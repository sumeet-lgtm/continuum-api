import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

// ─── Mock all external I/O ────────────────────────────────────────────────────

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    apiKey: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    suppression: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
    },
    verification: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'ver-001', checkedAt: new Date() }),
    },
    sendMessage: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    sendEvent: {
      create: vi.fn(),
    },
    webhook: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    webhookDelivery: {
      create: vi.fn(),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    $disconnect: vi.fn(),
  },
  disconnectPrisma: vi.fn(),
}));

vi.mock('../../lib/redis.js', () => ({
  redis:    { incr: vi.fn().mockResolvedValue(1), expire: vi.fn(), ttl: vi.fn().mockResolvedValue(55), ping: vi.fn().mockResolvedValue('PONG') },
  pingRedis: vi.fn().mockResolvedValue(true),
  redisKey:  { rateLimit: (id: string) => `rl:${id}`, ipRateLimit: (scope: string, ip: string) => `rl:ip:${scope}:${ip}` },
  getRedis:  vi.fn(),
}));

vi.mock('../../lib/queue.js', () => ({
  bulkQueue:    { add: vi.fn(), close: vi.fn() },
  webhookQueue: { add: vi.fn(), close: vi.fn() },
  monitorQueue: { add: vi.fn(), close: vi.fn() },
  closeQueues:  vi.fn(),
  redisConnection: {},
}));

vi.mock('../../engine/mx.js', () => ({
  lookupMx:        vi.fn().mockResolvedValue({ found: true, records: ['mx1.example.com'], error: null }),
  clearMxCache:    vi.fn(),
  getMxCacheStats: vi.fn().mockReturnValue({ size: 0, maxSize: 10000 }),
}));

vi.mock('../../engine/smtp.js', () => ({
  smtpProbe: vi.fn().mockResolvedValue({
    checked: false, reachable: null, isCatchAll: null,
    greylisted: false, rawResponse: null, error: 'disabled',
  }),
}));

vi.mock('../../engine/disposable.js', () => ({
  isDisposableDomain:  vi.fn().mockReturnValue(false),
  loadDisposableList:  vi.fn(),
  getBlocklistStats:   vi.fn().mockReturnValue({ exact: 0, wildcard: 0 }),
}));

vi.mock('../../lib/ses.js', () => ({
  sendViaSes: vi.fn().mockResolvedValue({ sesMessageId: 'ses-msg-001' }),
  isSesConfigured: vi.fn().mockReturnValue(true),
  SesNotConfiguredError: class SesNotConfiguredError extends Error {},
}));

import { buildApp } from '../../server.js';
import { prisma } from '../../lib/prisma.js';
import { sendViaSes, isSesConfigured } from '../../lib/ses.js';
import { lookupMx } from '../../engine/mx.js';

const mockFindKey       = vi.mocked(prisma.apiKey.findUnique);
const mockKeyUpdate     = vi.mocked(prisma.apiKey.update);
const mockSuppressFind  = vi.mocked(prisma.suppression.findUnique);
const mockVerifyFind    = vi.mocked(prisma.verification.findFirst);
const mockSendCreate    = vi.mocked(prisma.sendMessage.create);
const mockSendUpdate    = vi.mocked(prisma.sendMessage.update);
const mockSendViaSes    = vi.mocked(sendViaSes);
const mockSesConfigured = vi.mocked(isSesConfigured);
const mockLookupMx      = vi.mocked(lookupMx);

// ─── Test fixtures ────────────────────────────────────────────────────────────

const TEST_API_KEY = 'cnt_testsendkey0123456789abcdefghijklmno';
const AUTH = { authorization: `Bearer ${TEST_API_KEY}` };

function makeKey(overrides: Record<string, unknown> = {}) {
  return {
    id: 'key-send-001',
    keyHash: '',
    keyPrefix: 'cnt_testsend',
    label: 'test',
    ownerId: null,
    userId: null,
    orgId: null,
    keyRaw: null,
    rateLimit: 1000,
    monthlyLimit: 1000,
    currentMonthUsage: 0,
    monthlySendLimit: 500,
    currentMonthSendUsage: 0,
    sendUsageResetAt: new Date(Date.now() + 30 * 86_400_000),
    usageResetAt: new Date(Date.now() + 30 * 86_400_000),
    plan: 'free',
    isActive: true,
    createdAt: new Date(),
    revokedAt: null,
    name: null,
    permission: 'full_access',
    restrictedDomainId: null,
    lastUsedAt: null,
    ...overrides,
  };
}

let app: FastifyInstance;

beforeAll(async () => {
  mockFindKey.mockResolvedValue(makeKey());
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockFindKey.mockResolvedValue(makeKey());
  mockKeyUpdate.mockResolvedValue({} as never);
  mockSuppressFind.mockResolvedValue(null);
  mockVerifyFind.mockResolvedValue(null);
  mockSendCreate.mockResolvedValue({ id: 'send-001', createdAt: new Date() } as never);
  mockSendViaSes.mockResolvedValue({ sesMessageId: 'ses-msg-001' });
  mockSesConfigured.mockReturnValue(true);
  mockLookupMx.mockResolvedValue({ found: true, records: ['mx1.example.com'], error: null });
});

function send(body: unknown) {
  return app.inject({
    method: 'POST',
    url: '/v1/send',
    headers: { 'content-type': 'application/json', ...AUTH },
    payload: JSON.stringify(body),
  });
}

// auth.ts caches a resolved API key by hash for 60s (in-process, module-level
// Map) — reusing TEST_API_KEY after changing what findUnique returns for it
// would just read the stale cached record. Any test that needs a DIFFERENT
// key record mid-suite must use its own never-before-seen key string.
function sendWithKey(body: unknown, apiKey: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/send',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    payload: JSON.stringify(body),
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /v1/send', () => {
  it('sends successfully and returns the sesMessageId', async () => {
    const res = await send({ to: 'user@example.com', subject: 'Hi', html_body: '<p>hi</p>' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('sent');
    expect(body.sesMessageId).toBe('ses-msg-001');
    expect(mockSendViaSes).toHaveBeenCalledTimes(1);
  });

  it('still returns 200 when SES succeeds but the DB write to record it fails', async () => {
    // The real bug this guards against: SES already sent the email, so a
    // 500 here would tell the customer their send failed — they'd retry and
    // double-send something that already went out.
    mockSendCreate.mockRejectedValueOnce(new Error('connection reset'));

    const res = await send({ to: 'user@example.com', subject: 'Hi', text_body: 'hi' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('sent');
    expect(body.sesMessageId).toBe('ses-msg-001');
    expect(body.id).toMatch(/^ephemeral_/);
  });

  it('rejects a suppressed address without ever calling SES', async () => {
    mockSuppressFind.mockResolvedValueOnce({
      id: 'sup-001', email: 'bad@example.com', reason: 'hard_bounce', apiKeyId: null, createdAt: new Date(),
    });

    const res = await send({ to: 'bad@example.com', subject: 'Hi', text_body: 'hi' });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN');
    expect(mockSendViaSes).not.toHaveBeenCalled();
  });

  it('returns 429 once currentMonthSendUsage reaches the plan limit', async () => {
    mockFindKey.mockResolvedValue(
      makeKey({ id: 'key-quota-001', currentMonthSendUsage: 1_000, monthlySendLimit: 1_000, plan: 'free' }),
    );

    const res = await sendWithKey(
      { to: 'user@example.com', subject: 'Hi', text_body: 'hi' },
      'cnt_quotaexceededkey0123456789abcdefghij',
    );

    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe('RATE_LIMITED');
    expect(mockSendViaSes).not.toHaveBeenCalled();
  });

  it('includes X-Send-Usage headers on a normal send', async () => {
    const res = await send({ to: 'user@example.com', subject: 'Hi', text_body: 'hi' });
    expect(res.headers['x-send-usage-limit']).toBeDefined();
    expect(res.headers['x-send-usage-remaining']).toBeDefined();
  });

  it('blocks sending when verify_before_send=true and the address is invalid (no MX)', async () => {
    mockLookupMx.mockResolvedValueOnce({ found: false, records: [], error: null });

    const res = await send({
      to: 'user@nodomain.example', subject: 'Hi', text_body: 'hi', verify_before_send: true,
    });

    expect(res.statusCode).toBe(403);
    expect(mockSendViaSes).not.toHaveBeenCalled();
  });

  it('does not block (only warns) on a flagged address when verify_before_send is false', async () => {
    mockVerifyFind.mockResolvedValueOnce({ id: 'ver-flagged', status: 'invalid', isDisposable: false } as never);

    const res = await send({ to: 'user@example.com', subject: 'Hi', text_body: 'hi' });

    expect(res.statusCode).toBe(200);
    expect(mockSendViaSes).toHaveBeenCalledTimes(1);
  });

  it('the soft verification-history lookup fails open — a DB error there does not block the send', async () => {
    mockVerifyFind.mockRejectedValueOnce(new Error('connection reset'));

    const res = await send({ to: 'user@example.com', subject: 'Hi', text_body: 'hi' });

    expect(res.statusCode).toBe(200);
    expect(mockSendViaSes).toHaveBeenCalledTimes(1);
  });

  it('returns 502 and persists status=failed when SES itself errors', async () => {
    mockSendViaSes.mockRejectedValueOnce(new Error('SES throttled'));

    const res = await send({ to: 'user@example.com', subject: 'Hi', text_body: 'hi' });

    expect(res.statusCode).toBe(502);
    expect(res.json().status).toBe('failed');
    // create() always writes status:'queued' up front (before the SES call);
    // the failure is persisted via the subsequent update() once SES errors.
    expect(mockSendUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
    // A send that never left the building must not cost the customer quota —
    // apiKey.update is only ever called for the send-usage increment in this
    // flow (the key already has a future sendUsageResetAt, so no lazy-init
    // update fires either), so zero calls here is the actual assertion.
    expect(mockKeyUpdate).not.toHaveBeenCalled();
  });

  it('increments send usage only on a successful send', async () => {
    const res = await send({ to: 'user@example.com', subject: 'Hi', text_body: 'hi' });

    expect(res.statusCode).toBe(200);
    expect(mockKeyUpdate).toHaveBeenCalledWith({
      where: { id: 'key-send-001' },
      data: { currentMonthSendUsage: { increment: 1 } },
    });
  });

  it('returns 503 when SES is not configured', async () => {
    mockSesConfigured.mockReturnValue(false);

    const res = await send({ to: 'user@example.com', subject: 'Hi', text_body: 'hi' });

    expect(res.statusCode).toBe(503);
    expect(mockSendViaSes).not.toHaveBeenCalled();
  });

  it('returns 401 without an API key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/send',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ to: 'user@example.com', subject: 'Hi', text_body: 'hi' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('requires either html_body or text_body', async () => {
    const res = await send({ to: 'user@example.com', subject: 'Hi' });
    expect([400, 422]).toContain(res.statusCode);
  });
});
