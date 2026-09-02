import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    apiKey: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    webhook: { findMany: vi.fn().mockResolvedValue([]) },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: 'log-1' }),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
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
  bulkQueue: { add: vi.fn(), close: vi.fn() }, webhookQueue: { add: vi.fn(), close: vi.fn() },
  monitorQueue: { add: vi.fn(), close: vi.fn() }, closeQueues: vi.fn(), redisConnection: {},
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

const { exportMock, deleteMock } = vi.hoisted(() => ({
  exportMock: vi.fn(),
  deleteMock: vi.fn(),
}));
vi.mock('../../lib/accountData.js', () => ({
  exportAccountData: exportMock,
  deleteAccountData: deleteMock,
}));

import { buildApp } from '../../server.js';
import { prisma } from '../../lib/prisma.js';

const mockFindKey = vi.mocked(prisma.apiKey.findUnique);
const mockKeyUpdate = vi.mocked(prisma.apiKey.update);
const mockAuditCreate = vi.mocked(prisma.auditLog.create);
const mockAuditFindMany = vi.mocked(prisma.auditLog.findMany);
const mockAuditCount = vi.mocked(prisma.auditLog.count);

function makeKey(id: string) {
  return {
    id, keyHash: '', keyPrefix: 'cnt_test', label: 'test', ownerId: null, userId: null, orgId: null, keyRaw: null,
    rateLimit: 1000, monthlyLimit: 1000, currentMonthUsage: 0, monthlySendLimit: 500, currentMonthSendUsage: 0,
    sendUsageResetAt: new Date(Date.now() + 30 * 86_400_000), usageResetAt: new Date(Date.now() + 30 * 86_400_000),
    plan: 'free', isActive: true, createdAt: new Date(), revokedAt: null, name: null,
    permission: 'full_access', restrictedDomainId: null, lastUsedAt: null, extraVerificationCredits: 0, extraSendCredits: 0,
  };
}

let app: FastifyInstance;
let keyCounter = 0;
function authFor(apiKeyId: string) {
  keyCounter += 1;
  mockFindKey.mockResolvedValueOnce(makeKey(apiKeyId) as never);
  return { authorization: `Bearer cnt_accttest${keyCounter}0123456789abcdefgh` };
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
  mockKeyUpdate.mockResolvedValue({} as never);
  mockAuditCreate.mockResolvedValue({ id: 'log-1' } as never);
  mockAuditFindMany.mockResolvedValue([]);
  mockAuditCount.mockResolvedValue(0);
});

describe('GET /v1/account/export', () => {
  it('returns the exported bundle for the authenticated key', async () => {
    exportMock.mockResolvedValue({ apiKeyId: 'key-A', exportedAt: '2026-01-01T00:00:00.000Z', data: { contacts: [] } });

    const res = await app.inject({ method: 'GET', url: '/v1/account/export', headers: authFor('key-A') });

    expect(res.statusCode).toBe(200);
    expect(exportMock).toHaveBeenCalledWith('key-A');
    expect(res.json().apiKeyId).toBe('key-A');
    expect(mockAuditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'account.data_exported', apiKeyId: 'key-A' }),
    }));
  });
});

describe('GET /v1/account/audit-logs', () => {
  it('scopes the query to this API key\'s own audit entries', async () => {
    mockAuditFindMany.mockResolvedValue([{ id: 'log-1', action: 'api_key.created', actorId: 'key-A', actorEmail: 'k', actorIp: null, targets: [], createdAt: new Date() }] as never);
    mockAuditCount.mockResolvedValue(1);

    const res = await app.inject({ method: 'GET', url: '/v1/account/audit-logs', headers: authFor('key-A') });

    expect(res.statusCode).toBe(200);
    expect(mockAuditFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { apiKeyId: 'key-A' } }));
    expect(res.json().data).toHaveLength(1);
  });
});

describe('DELETE /v1/account', () => {
  it('rejects the request without the exact confirmation string', async () => {
    const res = await app.inject({
      method: 'DELETE', url: '/v1/account',
      headers: { ...authFor('key-A'), 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });

    expect(res.statusCode).toBe(422);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('rejects a near-miss confirmation string (no partial-match bypass)', async () => {
    const res = await app.inject({
      method: 'DELETE', url: '/v1/account',
      headers: { ...authFor('key-A'), 'content-type': 'application/json' },
      payload: JSON.stringify({ confirm: 'delete_my_account' }),
    });

    expect(res.statusCode).toBe(422);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('deletes all owned data and revokes (does not hard-delete) the key when correctly confirmed', async () => {
    deleteMock.mockResolvedValue({ contacts: 5, sendMessages: 12 });

    const res = await app.inject({
      method: 'DELETE', url: '/v1/account',
      headers: { ...authFor('key-A'), 'content-type': 'application/json' },
      payload: JSON.stringify({ confirm: 'DELETE_MY_ACCOUNT' }),
    });

    expect(res.statusCode).toBe(200);
    expect(deleteMock).toHaveBeenCalledWith('key-A');
    expect(mockKeyUpdate).toHaveBeenCalledWith({
      where: { id: 'key-A' },
      data: { isActive: false, revokedAt: expect.any(Date) },
    });
    expect(res.json()).toMatchObject({ deleted: true, apiKeyId: 'key-A', counts: { contacts: 5, sendMessages: 12 } });
    expect(mockAuditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'account.deleted', apiKeyId: 'key-A' }),
    }));
  });

  it('only ever operates on the authenticated caller\'s own key', async () => {
    deleteMock.mockResolvedValue({});

    await app.inject({
      method: 'DELETE', url: '/v1/account',
      headers: { ...authFor('key-B'), 'content-type': 'application/json' },
      payload: JSON.stringify({ confirm: 'DELETE_MY_ACCOUNT' }),
    });

    expect(deleteMock).toHaveBeenCalledWith('key-B');
    expect(deleteMock).not.toHaveBeenCalledWith('key-A');
  });
});
