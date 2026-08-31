import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

// ─── Mock all external dependencies (buildApp() registers every route) ──────

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    apiKey: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    suppression: {
      findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(),
      create: vi.fn(), delete: vi.fn(),
    },
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
  uploadToStorage: vi.fn(), downloadFromStorage: vi.fn(), createSignedUrl: vi.fn(), deleteFromStorage: vi.fn(),
}));

vi.mock('../../engine/disposable.js', () => ({
  loadDisposableList: vi.fn(), isDisposableDomain: vi.fn().mockReturnValue(false),
  getBlocklistStats: vi.fn().mockReturnValue({ exact: 0, wildcard: 0 }),
}));

vi.mock('../../engine/mx.js', () => ({
  lookupMx: vi.fn(), clearMxCache: vi.fn(), getMxCacheStats: vi.fn().mockReturnValue({ size: 0, maxSize: 10000 }),
}));

vi.mock('../../engine/smtp.js', () => ({
  smtpProbe: vi.fn().mockResolvedValue({ checked: false, reachable: null, isCatchAll: null, greylisted: false, rawResponse: null, error: 'disabled' }),
}));

import { buildApp } from '../../server.js';
import { prisma } from '../../lib/prisma.js';

const mockFindKey = vi.mocked(prisma.apiKey.findUnique);
const mockFindMany = vi.mocked(prisma.suppression.findMany);
const mockCount = vi.mocked(prisma.suppression.count);
const mockFindUnique = vi.mocked(prisma.suppression.findUnique);
const mockFindFirst = vi.mocked(prisma.suppression.findFirst);
const mockCreate = vi.mocked(prisma.suppression.create);
const mockDelete = vi.mocked(prisma.suppression.delete);

function makeKey(id: string) {
  return {
    id, keyHash: '', keyPrefix: 'cnt_test', label: 'test', ownerId: null, userId: null, orgId: null, keyRaw: null,
    rateLimit: 1000, monthlyLimit: 1000, currentMonthUsage: 0, monthlySendLimit: 500, currentMonthSendUsage: 0,
    sendUsageResetAt: new Date(Date.now() + 30 * 86_400_000), usageResetAt: new Date(Date.now() + 30 * 86_400_000),
    plan: 'free', isActive: true, createdAt: new Date(), revokedAt: null, name: null,
    permission: 'full_access', restrictedDomainId: null, lastUsedAt: null,
  };
}

let app: FastifyInstance;
let keyCounter = 0;

// requireAuth caches resolved keys in-process by hash of the raw key —
// each test uses its own key string so a cache hit from an earlier test
// never masks the mock configured for this one.
function authFor(apiKeyId: string) {
  keyCounter += 1;
  mockFindKey.mockResolvedValueOnce(makeKey(apiKeyId) as never);
  return { authorization: `Bearer cnt_supptest${keyCounter}0123456789abcdefgh` };
}

beforeAll(async () => {
  mockFindKey.mockResolvedValue(makeKey('key-A') as never);
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /v1/suppressions — cross-tenant isolation', () => {
  it('scopes the list query to entries owned by the caller or unowned, never another customer\'s', async () => {
    mockFindMany.mockResolvedValue([]);
    mockCount.mockResolvedValue(0);

    const res = await app.inject({ method: 'GET', url: '/v1/suppressions', headers: authFor('key-A') });

    expect(res.statusCode).toBe(200);
    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ OR: [{ apiKeyId: 'key-A' }, { apiKeyId: null }] }),
    }));
  });

  it('never returns apiKeyId in the response body', async () => {
    mockFindMany.mockResolvedValue([{ id: 's1', email: 'x@example.com', reason: 'hard_bounce', createdAt: new Date() }] as never);
    mockCount.mockResolvedValue(1);

    const res = await app.inject({ method: 'GET', url: '/v1/suppressions', headers: authFor('key-A') });

    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({
      select: { id: true, email: true, reason: true, createdAt: true },
    }));
    expect(res.json().data[0]).not.toHaveProperty('apiKeyId');
  });
});

describe('POST /v1/suppressions — no cross-tenant hijack', () => {
  it('creates a new record owned by the caller when the address is not yet suppressed', async () => {
    mockFindUnique.mockResolvedValue(null);
    mockCreate.mockResolvedValue({ id: 's-new', email: 'new@example.com', reason: 'manual', createdAt: new Date() } as never);

    const res = await app.inject({
      method: 'POST', url: '/v1/suppressions', headers: { ...authFor('key-A'), 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'new@example.com' }),
    });

    expect(res.statusCode).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ data: { email: 'new@example.com', reason: 'manual', apiKeyId: 'key-A' } }));
  });

  it('does not reassign ownership when another customer already suppressed the address', async () => {
    mockFindUnique.mockResolvedValue({ id: 's-existing', email: 'owned-by-b@example.com', reason: 'hard_bounce', apiKeyId: 'key-B', createdAt: new Date() } as never);

    const res = await app.inject({
      method: 'POST', url: '/v1/suppressions', headers: { ...authFor('key-A'), 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'owned-by-b@example.com' }),
    });

    expect(res.statusCode).toBe(200); // idempotent no-op, not 201 (created)
    expect(mockCreate).not.toHaveBeenCalled();
    expect(res.json()).not.toHaveProperty('apiKeyId');
  });
});

describe('DELETE /v1/suppressions/:email — no cross-tenant deletion', () => {
  it('deletes a suppression the caller owns', async () => {
    mockFindFirst.mockResolvedValue({ id: 's-a', email: 'mine@example.com', apiKeyId: 'key-A' } as never);

    const res = await app.inject({ method: 'DELETE', url: '/v1/suppressions/mine@example.com', headers: authFor('key-A') });

    expect(res.statusCode).toBe(200);
    expect(mockFindFirst).toHaveBeenCalledWith({ where: { email: 'mine@example.com', apiKeyId: 'key-A' } });
    expect(mockDelete).toHaveBeenCalledWith({ where: { id: 's-a' } });
  });

  it("returns 404 rather than deleting when the entry belongs to a different customer", async () => {
    mockFindFirst.mockResolvedValue(null); // scoped query finds nothing under key-A's ownership

    const res = await app.inject({ method: 'DELETE', url: '/v1/suppressions/belongs-to-b@example.com', headers: authFor('key-A') });

    expect(res.statusCode).toBe(404);
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
