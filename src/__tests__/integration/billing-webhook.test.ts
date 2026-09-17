import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';

// billing/index.ts's /billing/webhook handler had zero test coverage —
// this is the route that grants/revokes paid plans and applies credit
// packs based on a signature-verified Dodo payment event. Covers
// signature verification, the replay window, idempotency, and each of
// the four event-handling branches (credit pack, upgrade, downgrade,
// payment failed).

const { WEBHOOK_SECRET } = vi.hoisted(() => ({
  WEBHOOK_SECRET: 'whsec_' + Buffer.from('test-signing-key-0123456789ab').toString('base64'),
}));

vi.mock('../../config.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    isProd: false,
    config: {
      ...(actual.config as Record<string, unknown>),
      DODO_WEBHOOK_SECRET: WEBHOOK_SECRET,
      DODO_PAYMENTS_API_KEY: 'test_dodo_key',
      DODO_PRODUCT_STARTER: 'prod_starter',
      DODO_PRODUCT_GROWTH: 'prod_growth',
      DODO_PRODUCT_SCALE: 'prod_scale',
      DASHBOARD_URL: 'https://app.continuumapi.com',
    },
  };
});

vi.mock('../../lib/redis.js', () => ({
  redis: {
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn(),
    ttl: vi.fn().mockResolvedValue(55),
    ping: vi.fn().mockResolvedValue('PONG'),
  },
  isReconnecting: () => false,
  redisKey: {
    rateLimit: (id: string) => `rl:${id}`,
    ipRateLimit: (scope: string, ip: string) => `rl:ip:${scope}:${ip}`,
  },
}));

const { updateManyMock, findUniqueUserMock, executeRawMock } = vi.hoisted(() => ({
  updateManyMock: vi.fn(),
  findUniqueUserMock: vi.fn(),
  executeRawMock: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => {
  const prisma: {
    apiKey: { updateMany: typeof updateManyMock };
    user: { findUnique: typeof findUniqueUserMock };
    $executeRaw?: typeof executeRawMock;
    $transaction?: ReturnType<typeof vi.fn>;
    $executeRawUnsafe?: ReturnType<typeof vi.fn>;
  } = {
    apiKey: { updateMany: updateManyMock },
    user: { findUnique: findUniqueUserMock },
  };
  // $executeRaw is called as a tagged template (prisma.$executeRaw`...`);
  // a plain vi.fn() correctly receives the strings/values as args either way.
  prisma.$executeRaw = executeRawMock;
  prisma.$transaction = vi.fn((fn: (tx: typeof prisma) => unknown) => fn(prisma));
  prisma.$executeRawUnsafe = vi.fn().mockResolvedValue(undefined);
  return { prisma };
});

const { sendEmailMock } = vi.hoisted(() => ({ sendEmailMock: vi.fn().mockResolvedValue(true) }));
vi.mock('../../lib/email.js', () => ({
  sendEmail: sendEmailMock,
  upgradeConfirmEmail: (plan: string, limit: number) => ({
    subject: `Upgraded to ${plan}`,
    html: `limit ${limit}`,
  }),
  planDowngradedEmail: (plan: string) => ({ subject: `Downgraded to ${plan}`, html: '' }),
  paymentFailedEmail: (opts: { amount: string; retryDate: string }) => ({
    subject: `Payment failed: ${opts.amount}`,
    html: opts.retryDate,
  }),
  subscriptionCancelledEmail: () => ({ subject: 'Cancelled', html: '' }),
  paymentReceiptEmail: () => ({ subject: 'Receipt', html: '' }),
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { billingRoutes } from '../../routes/billing/index.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  await app.register(billingRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  executeRawMock.mockResolvedValue(1); // idempotency insert succeeds (not a duplicate) by default
  updateManyMock.mockResolvedValue({ count: 1 });
});

function sign(id: string, timestamp: string, payload: string): string {
  const key = Buffer.from(WEBHOOK_SECRET.slice(6), 'base64');
  const sig = crypto
    .createHmac('sha256', key)
    .update(`${id}.${timestamp}.${payload}`)
    .digest('base64');
  return `v1,${sig}`;
}

async function sendWebhook(
  body: object,
  opts: { id?: string; timestamp?: string; badSig?: boolean; noHeaders?: boolean } = {},
) {
  const payload = JSON.stringify(body);
  const id = opts.id ?? 'evt_1';
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (!opts.noHeaders) {
    headers['webhook-id'] = id;
    headers['webhook-timestamp'] = timestamp;
    headers['webhook-signature'] = opts.badSig
      ? 'v1,not-a-real-signature'
      : sign(id, timestamp, payload);
  }
  return app.inject({ method: 'POST', url: '/billing/webhook', headers, payload });
}

describe('POST /billing/webhook — signature verification', () => {
  it('rejects a request with no signature headers at all', async () => {
    const res = await sendWebhook({ type: 'payment.failed' }, { noHeaders: true });
    expect(res.statusCode).toBe(401);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it('rejects a request with an invalid signature', async () => {
    const res = await sendWebhook({ type: 'payment.failed' }, { badSig: true });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a stale timestamp outside the 5-minute replay window', async () => {
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 600); // 10 minutes ago
    const res = await sendWebhook({ type: 'payment.failed' }, { timestamp: staleTimestamp });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a correctly signed, fresh payload', async () => {
    const res = await sendWebhook({ type: 'some.unhandled.event' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
  });
});

describe('POST /billing/webhook — idempotency', () => {
  it('acks a duplicate delivery without reprocessing', async () => {
    executeRawMock.mockResolvedValue(0); // ON CONFLICT DO NOTHING inserted 0 rows — already seen
    const res = await sendWebhook({
      type: 'payment.succeeded',
      data: { metadata: { api_key_id: 'key-1', plan: 'growth' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, duplicate: true });
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it('still processes the event when the dedupe insert itself fails (never drop a real payment)', async () => {
    executeRawMock.mockRejectedValue(new Error('dedupe table down'));
    const res = await sendWebhook({
      type: 'payment.succeeded',
      data: {
        metadata: { api_key_id: 'key-1', plan: 'growth' },
        product_cart: [{ product_id: 'prod_growth' }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(updateManyMock).toHaveBeenCalled();
  });
});

describe('POST /billing/webhook — credit pack', () => {
  it('applies a credit pack by api_key_id and emails the customer', async () => {
    const res = await sendWebhook({
      type: 'payment.succeeded',
      data: {
        metadata: { api_key_id: 'key-1', credit_pack: '25k', credit_amount: '25000' },
        customer: { email: 'buyer@wyberai.com' },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: 'key-1' },
      data: { extraVerificationCredits: { increment: 25000 } },
    });
    expect(sendEmailMock).toHaveBeenCalledWith(
      'buyer@wyberai.com',
      expect.stringContaining('25,000'),
      expect.any(String),
    );
  });

  it('falls back to userId, then to email→user lookup, when api_key_id does not match', async () => {
    updateManyMock
      .mockResolvedValueOnce({ count: 0 }) // apiKeyId miss
      .mockResolvedValueOnce({ count: 0 }) // userId miss
      .mockResolvedValueOnce({ count: 1 }); // ownerId match via email
    findUniqueUserMock.mockResolvedValue({ id: 'user-1' });

    const res = await sendWebhook({
      type: 'payment.succeeded',
      data: {
        metadata: {
          api_key_id: 'key-missing',
          user_id: 'user-missing',
          credit_pack: '5k',
          credit_amount: '5000',
        },
        customer: { email: 'someone@wyberai.com' },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(findUniqueUserMock).toHaveBeenCalledWith({
      where: { email: 'someone@wyberai.com' },
      select: { id: true },
    });
    expect(updateManyMock).toHaveBeenNthCalledWith(3, {
      where: { ownerId: 'user-1' },
      data: { extraVerificationCredits: { increment: 5000 } },
    });
  });

  it('logs and acks (does not 500) when no api key matches anything', async () => {
    updateManyMock.mockResolvedValue({ count: 0 });
    findUniqueUserMock.mockResolvedValue(null);

    const res = await sendWebhook({
      type: 'payment.succeeded',
      data: { metadata: { credit_pack: '5k', credit_amount: '5000' } },
    });

    expect(res.statusCode).toBe(200);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe('POST /billing/webhook — plan upgrade', () => {
  it('upgrades the plan via product_id and emails a confirmation', async () => {
    const res = await sendWebhook({
      type: 'payment.succeeded',
      data: {
        product_cart: [{ product_id: 'prod_growth' }],
        metadata: { api_key_id: 'key-1' },
        customer: { email: 'buyer@wyberai.com' },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: 'key-1' },
      data: expect.objectContaining({ plan: 'growth' }),
    });
    expect(sendEmailMock).toHaveBeenCalledWith(
      'buyer@wyberai.com',
      expect.stringContaining('growth'),
      expect.any(String),
    );
  });

  it('falls back to the metadata plan when the cart is missing', async () => {
    const res = await sendWebhook({
      type: 'subscription.renewed',
      data: { metadata: { api_key_id: 'key-1', plan: 'starter' } },
    });

    expect(res.statusCode).toBe(200);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: 'key-1' },
      data: expect.objectContaining({ plan: 'starter' }),
    });
  });

  it('acks without crashing when the product/plan cannot be mapped (needs manual reconciliation)', async () => {
    const res = await sendWebhook({
      type: 'payment.succeeded',
      data: { product_cart: [{ product_id: 'prod_unknown' }], metadata: { api_key_id: 'key-1' } },
    });

    expect(res.statusCode).toBe(200);
    expect(updateManyMock).not.toHaveBeenCalled();
  });
});

describe('POST /billing/webhook — downgrade', () => {
  it('resets the key to the free plan and emails the customer', async () => {
    const res = await sendWebhook({
      type: 'subscription.cancelled',
      data: { metadata: { api_key_id: 'key-1' }, customer: { email: 'buyer@wyberai.com' } },
    });

    expect(res.statusCode).toBe(200);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: 'key-1' },
      data: expect.objectContaining({ plan: 'free' }),
    });
    expect(sendEmailMock).toHaveBeenCalledWith(
      'buyer@wyberai.com',
      expect.stringContaining('free'),
      expect.any(String),
    );
  });
});

describe('POST /billing/webhook — payment failed', () => {
  it('emails a dunning notice without changing the plan', async () => {
    const res = await sendWebhook({
      type: 'payment.failed',
      data: {
        metadata: { api_key_id: 'key-1' },
        customer: { email: 'buyer@wyberai.com' },
        total_amount: 1900,
        currency: 'USD',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(sendEmailMock).toHaveBeenCalledWith(
      'buyer@wyberai.com',
      expect.stringContaining('19.00'),
      expect.any(String),
    );
  });

  it('does nothing when there is no customer email to notify', async () => {
    const res = await sendWebhook({ type: 'payment.failed', data: { metadata: {} } });
    expect(res.statusCode).toBe(200);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe('POST /billing/webhook — processing errors', () => {
  it('releases the idempotency claim and returns 500 so Dodo retries', async () => {
    updateManyMock.mockRejectedValue(new Error('db exploded'));
    const res = await sendWebhook({
      type: 'payment.succeeded',
      data: { product_cart: [{ product_id: 'prod_growth' }], metadata: { api_key_id: 'key-1' } },
    });

    expect(res.statusCode).toBe(500);
    // First call is the idempotency INSERT, second is the release DELETE
    expect(executeRawMock).toHaveBeenCalledTimes(2);
  });
});
