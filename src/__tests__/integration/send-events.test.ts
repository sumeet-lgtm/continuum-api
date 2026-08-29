import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

// ─── Mock all external I/O ────────────────────────────────────────────────────

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    apiKey: { findUnique: vi.fn() },
    sendMessage: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    sendEvent: {
      create: vi.fn().mockResolvedValue({}),
    },
    suppression: {
      upsert: vi.fn().mockResolvedValue({}),
    },
    smtpCache: {
      delete: vi.fn().mockResolvedValue({}),
    },
    monitor: {
      findFirst: vi.fn().mockResolvedValue(null),
      update:    vi.fn().mockResolvedValue({}),
    },
    webhook: { findMany: vi.fn().mockResolvedValue([]) },
    $disconnect: vi.fn(),
  },
  disconnectPrisma: vi.fn(),
}));

vi.mock('../../lib/redis.js', () => ({
  redis:    { incr: vi.fn().mockResolvedValue(1), expire: vi.fn(), ttl: vi.fn().mockResolvedValue(55), ping: vi.fn().mockResolvedValue('PONG') },
  pingRedis: vi.fn().mockResolvedValue(true),
  redisKey:  { rateLimit: (id: string) => `rl:${id}` },
  getRedis:  vi.fn(),
}));

vi.mock('../../lib/queue.js', () => ({
  bulkQueue:    { add: vi.fn(), close: vi.fn() },
  webhookQueue: { add: vi.fn(), close: vi.fn() },
  monitorQueue: { add: vi.fn(), close: vi.fn() },
  closeQueues:  vi.fn(),
  redisConnection: {},
}));

vi.mock('../../engine/disposable.js', () => ({
  loadDisposableList: vi.fn(),
  isDisposableDomain: vi.fn().mockReturnValue(false),
  getBlocklistStats:  vi.fn().mockReturnValue({ exact: 0, wildcard: 0 }),
}));

vi.mock('../../engine/mx.js', () => ({
  lookupMx:        vi.fn(),
  clearMxCache:    vi.fn(),
  getMxCacheStats: vi.fn().mockReturnValue({ size: 0, maxSize: 10000 }),
}));

vi.mock('../../engine/smtp.js', () => ({
  smtpProbe: vi.fn().mockResolvedValue({
    checked: false, reachable: null, isCatchAll: null,
    greylisted: false, rawResponse: null, error: 'disabled',
  }),
}));

vi.mock('../../lib/snsVerify.js', () => ({
  verifySnsMessage: vi.fn().mockResolvedValue(true),
}));

import { buildApp } from '../../server.js';
import { prisma } from '../../lib/prisma.js';
import { verifySnsMessage } from '../../lib/snsVerify.js';
import { monitorQueue } from '../../lib/queue.js';

const mockFindSend    = vi.mocked(prisma.sendMessage.findUnique);
const mockUpdateSend  = vi.mocked(prisma.sendMessage.update);
const mockEventCreate = vi.mocked(prisma.sendEvent.create);
const mockSuppressUpsert = vi.mocked(prisma.suppression.upsert);
const mockVerifySns   = vi.mocked(verifySnsMessage);
const mockCacheDelete = vi.mocked(prisma.smtpCache.delete);
const mockMonitorFind = vi.mocked(prisma.monitor.findFirst);
const mockMonitorUpdate = vi.mocked(prisma.monitor.update);
const mockMonitorRecheck = vi.mocked(monitorQueue.add);

// correctOnGroundTruth runs fire-and-forget (`void`) after the route already
// responded — flush the microtask queue so its effects have landed before
// asserting on them.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let app: FastifyInstance;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifySns.mockResolvedValue(true);
  mockUpdateSend.mockResolvedValue({} as never);
  mockEventCreate.mockResolvedValue({} as never);
  mockSuppressUpsert.mockResolvedValue({} as never);
  fetchSpy = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetchSpy);
});

function postSns(body: unknown) {
  return app.inject({
    method: 'POST',
    url: '/v1/send/events',
    headers: { 'content-type': 'text/plain' },
    payload: JSON.stringify(body),
  });
}

const baseSns = {
  MessageId: 'sns-msg-1',
  TopicArn: 'arn:aws:sns:us-east-1:123456789012:ses-events',
  Timestamp: '2026-08-23T00:00:00.000Z',
  SignatureVersion: '1',
  Signature: 'fake-signature',
  SigningCertURL: 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc123.pem',
};

describe('POST /v1/send/events (SNS)', () => {
  it('confirms a SubscriptionConfirmation by fetching SubscribeURL', async () => {
    const res = await postSns({
      ...baseSns,
      Type: 'SubscriptionConfirmation',
      Token: 'tok',
      SubscribeURL: 'https://sns.us-east-1.amazonaws.com/confirm?Token=tok',
      Message: 'You have chosen to subscribe...',
    });

    expect(res.statusCode).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://sns.us-east-1.amazonaws.com/confirm?Token=tok',
      expect.anything(),
    );
  });

  it('rejects a Notification with an invalid signature', async () => {
    mockVerifySns.mockResolvedValueOnce(false);

    const res = await postSns({
      ...baseSns,
      Type: 'Notification',
      Message: JSON.stringify({ eventType: 'Delivery', mail: { messageId: 'ses-1' } }),
    });

    expect(res.statusCode).toBe(401);
  });

  it('acks and does nothing for an event whose sesMessageId matches no SendMessage', async () => {
    mockFindSend.mockResolvedValue(null);

    const res = await postSns({
      ...baseSns,
      Type: 'Notification',
      Message: JSON.stringify({ eventType: 'Delivery', mail: { messageId: 'unknown-id' } }),
    });

    expect(res.statusCode).toBe(200);
    expect(mockEventCreate).not.toHaveBeenCalled();
  });

  it('a permanent Bounce creates a SendEvent, updates status, and suppresses the address', async () => {
    mockFindSend.mockResolvedValue({ id: 'send-001', apiKeyId: 'key-001', sesMessageId: 'ses-1' } as never);

    const res = await postSns({
      ...baseSns,
      Type: 'Notification',
      Message: JSON.stringify({
        eventType: 'Bounce',
        mail: { messageId: 'ses-1' },
        bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'dead@example.com' }] },
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(mockEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ sendMessageId: 'send-001', type: 'bounced' }) }),
    );
    expect(mockUpdateSend).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'send-001' }, data: { status: 'bounced' } }),
    );
    expect(mockSuppressUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'dead@example.com' } }),
    );

    await flush();
    expect(mockCacheDelete).toHaveBeenCalledWith({ where: { email: 'dead@example.com' } });
  });

  it('a permanent Bounce force-rechecks an active Monitor watching that address', async () => {
    mockFindSend.mockResolvedValue({ id: 'send-003', apiKeyId: 'key-001', sesMessageId: 'ses-3' } as never);
    mockMonitorFind.mockResolvedValue({ id: 'mon-001' } as never);

    const res = await postSns({
      ...baseSns,
      Type: 'Notification',
      Message: JSON.stringify({
        eventType: 'Bounce',
        mail: { messageId: 'ses-3' },
        bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'watched@example.com' }] },
      }),
    });

    expect(res.statusCode).toBe(200);
    await flush();

    expect(mockMonitorFind).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ email: 'watched@example.com', apiKeyId: 'key-001', isActive: true }) }),
    );
    expect(mockMonitorUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'mon-001' } }),
    );
    expect(mockMonitorRecheck).toHaveBeenCalledWith(
      'recheck-single',
      expect.objectContaining({ monitorId: 'mon-001', source: 'bounce_ground_truth' }),
      expect.objectContaining({ priority: 1 }),
    );
  });

  it('a permanent Bounce with no matching Monitor does not enqueue a recheck', async () => {
    mockFindSend.mockResolvedValue({ id: 'send-004', apiKeyId: 'key-001', sesMessageId: 'ses-4' } as never);
    mockMonitorFind.mockResolvedValue(null);
    mockMonitorRecheck.mockClear();

    const res = await postSns({
      ...baseSns,
      Type: 'Notification',
      Message: JSON.stringify({
        eventType: 'Bounce',
        mail: { messageId: 'ses-4' },
        bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'unwatched@example.com' }] },
      }),
    });

    expect(res.statusCode).toBe(200);
    await flush();
    expect(mockMonitorRecheck).not.toHaveBeenCalled();
  });

  it('a Complaint suppresses the complaining address', async () => {
    mockFindSend.mockResolvedValue({ id: 'send-002', apiKeyId: 'key-001', sesMessageId: 'ses-2' } as never);

    const res = await postSns({
      ...baseSns,
      Type: 'Notification',
      Message: JSON.stringify({
        eventType: 'Complaint',
        mail: { messageId: 'ses-2' },
        complaint: { complainedRecipients: [{ emailAddress: 'annoyed@example.com' }] },
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(mockSuppressUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'annoyed@example.com' } }),
    );
  });

  it('a Delivery event does not suppress anything', async () => {
    mockFindSend.mockResolvedValue({ id: 'send-003', apiKeyId: 'key-001', sesMessageId: 'ses-3' } as never);

    const res = await postSns({
      ...baseSns,
      Type: 'Notification',
      Message: JSON.stringify({
        eventType: 'Delivery',
        mail: { messageId: 'ses-3' },
        delivery: { recipients: ['ok@example.com'] },
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(mockSuppressUpsert).not.toHaveBeenCalled();
    expect(mockUpdateSend).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'send-003' }, data: { status: 'delivered' } }),
    );
  });
});
