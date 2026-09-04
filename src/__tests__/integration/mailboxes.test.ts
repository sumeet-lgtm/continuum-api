import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

// ─── Mock all external dependencies (buildApp() registers every route) ──────

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    apiKey: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    mailbox: { count: vi.fn(), create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
    webhook: { findMany: vi.fn().mockResolvedValue([]) },
    $disconnect: vi.fn(),
  },
  disconnectPrisma: vi.fn(),
}));

vi.mock('../../lib/redis.js', () => ({
  redis: { incr: vi.fn().mockResolvedValue(1), expire: vi.fn(), ttl: vi.fn().mockResolvedValue(55), ping: vi.fn().mockResolvedValue('PONG') },
  pingRedis: vi.fn().mockResolvedValue(true),
  redisKey: { rateLimit: (id: string) => `rl:${id}`, ipRateLimit: (scope: string, ip: string) => `rl:ip:${scope}:${ip}` },
  getRedis: vi.fn(),
}));

vi.mock('../../lib/queue.js', () => ({
  bulkQueue: { add: vi.fn(), close: vi.fn() },
  webhookQueue: { add: vi.fn(), close: vi.fn() },
  monitorQueue: { add: vi.fn(), close: vi.fn() },
  closeQueues: vi.fn(),
  redisConnection: {},
}));

vi.mock('../../lib/supabase.js', () => ({
  uploadToStorage: vi.fn(),
  downloadFromStorage: vi.fn(),
  createSignedUrl: vi.fn(),
  deleteFromStorage: vi.fn(),
}));

vi.mock('../../engine/disposable.js', () => ({
  loadDisposableList: vi.fn(),
  isDisposableDomain: vi.fn().mockReturnValue(false),
  getBlocklistStats: vi.fn().mockReturnValue({ exact: 0, wildcard: 0 }),
}));

vi.mock('../../engine/mx.js', () => ({
  lookupMx: vi.fn(),
  clearMxCache: vi.fn(),
  getMxCacheStats: vi.fn().mockReturnValue({ size: 0, maxSize: 10000 }),
}));

vi.mock('../../engine/smtp.js', () => ({
  smtpProbe: vi.fn().mockResolvedValue({
    checked: false, reachable: null, isCatchAll: null,
    greylisted: false, rawResponse: null, error: 'disabled',
  }),
}));

// POST /v1/mailboxes now verifies credentials inline before marking a
// mailbox 'active' — mock the actual SMTP dial so this suite doesn't depend
// on live DNS/network (previously it accidentally worked because
// smtp.example.com fails fast, which is not something to rely on in CI).
vi.mock('../../lib/smtp.js', () => ({
  testSmtpConnection: vi.fn().mockResolvedValue({ ok: true }),
  sendViaSmtp: vi.fn(),
}));

import { buildApp } from '../../server.js';
import { prisma } from '../../lib/prisma.js';
import { testSmtpConnection } from '../../lib/smtp.js';

const mockFindKey = vi.mocked(prisma.apiKey.findUnique);
const mockMailboxCount = vi.mocked(prisma.mailbox.count);
const mockMailboxCreate = vi.mocked(prisma.mailbox.create);
const mockTestSmtpConnection = vi.mocked(testSmtpConnection);

// requireAuth caches resolved API keys in-process, keyed by hash of the raw
// key string — reusing one literal key across tests with different `plan`
// overrides would read back a stale cached record from an earlier test
// instead of the freshly-mocked one, so each test gets its own unique key.
let keyCounter = 0;
function nextAuthHeader(): { authorization: string } {
  keyCounter += 1;
  return { authorization: `Bearer cnt_testmailboxkey${keyCounter}0123456789abcdefgh` };
}

function makeKey(overrides: Record<string, unknown> = {}) {
  return {
    id: 'key-mailbox-001',
    keyHash: '', keyPrefix: 'cnt_testmb', label: 'test', ownerId: null, userId: null, orgId: null, keyRaw: null,
    rateLimit: 1000, monthlyLimit: 1000, currentMonthUsage: 0,
    monthlySendLimit: 500, currentMonthSendUsage: 0,
    sendUsageResetAt: new Date(Date.now() + 30 * 86_400_000),
    usageResetAt: new Date(Date.now() + 30 * 86_400_000),
    plan: 'free', isActive: true, createdAt: new Date(), revokedAt: null, name: null,
    permission: 'full_access', restrictedDomainId: null, lastUsedAt: null, extraVerificationCredits: 0, extraSendCredits: 0,
    ...overrides,
  };
}

let app: FastifyInstance;

beforeAll(async () => {
  mockFindKey.mockResolvedValue(makeKey() as never);
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockFindKey.mockResolvedValue(makeKey() as never);
  mockMailboxCreate.mockResolvedValue({
    id: 'mailbox-001', type: 'smtp', host: 'smtp.example.com', port: 587,
    username: 'me@example.com', dailyLimit: 200, status: 'active', createdAt: new Date(),
  } as never);
});

function createMailbox() {
  return app.inject({
    method: 'POST',
    url: '/v1/mailboxes',
    headers: { 'content-type': 'application/json', ...nextAuthHeader() },
    payload: JSON.stringify({ type: 'smtp', host: 'smtp.example.com', port: 587, username: 'me@example.com', password: 'app-password' }),
  });
}

describe('POST /v1/mailboxes — per-plan mailbox cap', () => {
  it('allows creating a mailbox when under the plan limit', async () => {
    mockFindKey.mockResolvedValue(makeKey({ plan: 'free' }) as never);
    mockMailboxCount.mockResolvedValue(0); // free plan allows 1

    const res = await createMailbox();

    expect(res.statusCode).toBe(201);
    expect(mockMailboxCreate).toHaveBeenCalledTimes(1);
  });

  it('blocks creating a mailbox once the free plan (limit 1) already has one', async () => {
    mockFindKey.mockResolvedValue(makeKey({ plan: 'free' }) as never);
    mockMailboxCount.mockResolvedValue(1);

    const res = await createMailbox();

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      details: { limit: expect.stringContaining('free plan allows 1 mailbox') },
    });
    expect(mockMailboxCreate).not.toHaveBeenCalled();
  });

  it('allows a higher count on a paid plan that has not yet hit its own cap', async () => {
    mockFindKey.mockResolvedValue(makeKey({ plan: 'growth' }) as never);
    mockMailboxCount.mockResolvedValue(10); // growth allows 25

    const res = await createMailbox();

    expect(res.statusCode).toBe(201);
  });

  it('blocks a paid plan once it hits its own higher cap', async () => {
    mockFindKey.mockResolvedValue(makeKey({ plan: 'starter' }) as never);
    mockMailboxCount.mockResolvedValue(5); // starter allows 5

    const res = await createMailbox();

    expect(res.statusCode).toBe(422);
    expect(mockMailboxCreate).not.toHaveBeenCalled();
  });
});

describe('POST /v1/mailboxes — verifies credentials before marking active', () => {
  it('tests the SMTP connection and creates the mailbox as active when it succeeds', async () => {
    mockFindKey.mockResolvedValue(makeKey({ plan: 'free' }) as never);
    mockMailboxCount.mockResolvedValue(0);
    mockTestSmtpConnection.mockResolvedValueOnce({ ok: true });

    const res = await createMailbox();

    expect(res.statusCode).toBe(201);
    expect(mockTestSmtpConnection).toHaveBeenCalledTimes(1);
    expect(mockMailboxCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'active', lastErrorMsg: null }) }),
    );
  });

  it('creates the mailbox as error (not active) when the SMTP test fails, instead of silently trusting a bad password', async () => {
    mockFindKey.mockResolvedValue(makeKey({ plan: 'free' }) as never);
    mockMailboxCount.mockResolvedValue(0);
    mockTestSmtpConnection.mockResolvedValueOnce({ ok: false, error: 'Invalid login: 535-5.7.8' });

    const res = await createMailbox();

    // Still 201 — the mailbox row is created either way, just flagged so it
    // isn't picked up for sending/warmup until fixed.
    expect(res.statusCode).toBe(201);
    expect(mockMailboxCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'error', lastErrorMsg: 'Invalid login: 535-5.7.8' }),
      }),
    );
  });
});
