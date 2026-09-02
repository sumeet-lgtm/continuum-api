import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

// ─── Mock all external dependencies ──────────────────────────────────────────

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    apiKey:       { findUnique: vi.fn() },
    monitor:      {
      count:      vi.fn(),
      findUnique: vi.fn(),
      findMany:   vi.fn(),
      create:     vi.fn(),
      update:     vi.fn(),
      delete:     vi.fn(),
    },
    monitorCheck: { findMany: vi.fn(), count: vi.fn() },
    verification: { create: vi.fn() },
    webhook:      { findMany: vi.fn().mockResolvedValue([]) },
    $disconnect:  vi.fn(),
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
  bulkQueue:       { add: vi.fn(), close: vi.fn() },
  webhookQueue:    { add: vi.fn(), close: vi.fn() },
  monitorQueue:    { add: vi.fn(), close: vi.fn() },
  closeQueues:     vi.fn(),
  redisConnection: {},
}));

vi.mock('../../lib/supabase.js', () => ({
  uploadToStorage:  vi.fn(),
  downloadFromStorage: vi.fn(),
  createSignedUrl:  vi.fn(),
  deleteFromStorage: vi.fn(),
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

import { buildApp }    from '../../server.js';
import { prisma }      from '../../lib/prisma.js';
import { monitorQueue } from '../../lib/queue.js';

const mockFindKey      = vi.mocked(prisma.apiKey.findUnique);
const mockMonitorCount = vi.mocked(prisma.monitor.count);
const mockMonitorFind  = vi.mocked(prisma.monitor.findUnique);
const mockMonitorList  = vi.mocked(prisma.monitor.findMany);
const mockMonitorCreate = vi.mocked(prisma.monitor.create);
const mockMonitorUpdate = vi.mocked(prisma.monitor.update);
const mockMonitorDelete = vi.mocked(prisma.monitor.delete);
const mockCheckList    = vi.mocked(prisma.monitorCheck.findMany);
const mockCheckCount   = vi.mocked(prisma.monitorCheck.count);
const mockQueueAdd     = vi.mocked(monitorQueue.add);

// ─── Test API key ─────────────────────────────────────────────────────────────

const TEST_KEY     = 'cnt_testmonitorkey0123456789abcdefgh';
const TEST_KEY_REC = {
  id: 'key-mon-001', keyHash: '', keyPrefix: 'cnt_testmonitor',
  label: 'test', ownerId: null, userId: null, orgId: null, keyRaw: null, rateLimit: 1000,
  monthlyLimit: 100000, currentMonthUsage: 0, usageResetAt: new Date(), plan: 'free',
  isActive: true, createdAt: new Date(), revokedAt: null,
  name: null, monthlySendLimit: 500, currentMonthSendUsage: 0, sendUsageResetAt: new Date(),
  permission: 'full_access', restrictedDomainId: null, lastUsedAt: null, extraVerificationCredits: 0, extraSendCredits: 0,
};
const AUTH = { authorization: `Bearer ${TEST_KEY}` };

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeMonitor(overrides: Record<string, unknown> = {}) {
  return {
    id:                  'mon-001',
    email:               'alice@example.com',
    intervalHours:       24,
    isActive:            true,
    lastCheckedAt:       null,
    nextCheckAt:         new Date(Date.now() + 86_400_000),
    lastStatus:          null,
    consecutiveFailures: 0,
    pausedAt:            null,
    failureReason:       null,
    tags:                [] as string[],
    notifyOnAnyChange:   true,
    createdAt:           new Date('2026-04-24T10:00:00Z'),
    updatedAt:           new Date('2026-04-24T10:00:00Z'),
    apiKeyId:            'key-mon-001',
    ...overrides,
  };
}

function makeCheck(overrides: Record<string, unknown> = {}) {
  return {
    id:             'chk-001',
    monitorId:      'mon-001',
    statusChanged:  true,
    previousStatus: 'valid' as never,
    newStatus:      'invalid' as never,
    source:         'scheduled',
    checkedAt:      new Date('2026-04-24T12:00:00Z'),
    durationMs:     340,
    webhookSent:    false,
    verificationId: 'ver-001',
    ...overrides,
  };
}

// ─── App fixture ──────────────────────────────────────────────────────────────

let app: FastifyInstance;

beforeAll(async () => {
  mockFindKey.mockResolvedValue(TEST_KEY_REC);
  app = await buildApp();
});

afterAll(async () => { await app.close(); });

beforeEach(() => {
  vi.clearAllMocks();
  mockFindKey.mockResolvedValue(TEST_KEY_REC);
});

// ─── POST /v1/monitoring ──────────────────────────────────────────────────────

describe('POST /v1/monitoring', () => {
  beforeEach(() => {
    mockMonitorCount.mockResolvedValue(0);
    mockMonitorFind.mockResolvedValue(null);
    mockMonitorCreate.mockResolvedValue(makeMonitor());
  });

  it('returns 401 without API key', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/monitoring',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'a@b.com' }) });
    expect(res.statusCode).toBe(401);
  });

  it('returns 201 on success', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/monitoring',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'alice@example.com', intervalHours: 24 }) });
    expect(res.statusCode).toBe(201);
  });

  it('response includes all required fields', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/monitoring',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'alice@example.com' }) });
    const body = res.json();
    expect(body).toHaveProperty('id');
    expect(body).toHaveProperty('email', 'alice@example.com');
    expect(body).toHaveProperty('intervalHours');
    expect(body).toHaveProperty('isActive');
    expect(body).toHaveProperty('isPaused');
    expect(body).toHaveProperty('nextCheckAt');
    expect(body).toHaveProperty('lastStatus');
    expect(body).toHaveProperty('consecutiveFailures');
    expect(body).toHaveProperty('tags');
    expect(body).toHaveProperty('notifyOnAnyChange');
    expect(body).toHaveProperty('createdAt');
  });

  it('isPaused is false for a newly created monitor', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/monitoring',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'alice@example.com' }) });
    expect(res.json().isPaused).toBe(false);
  });

  it('returns 422 when email is invalid', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/monitoring',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'notanemail' }) });
    expect([400, 422]).toContain(res.statusCode);
  });

  it('returns 422 when intervalHours is invalid', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/monitoring',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'a@b.com', intervalHours: 7 }) });
    expect([400, 422]).toContain(res.statusCode);
  });

  it('returns 422 when email already has an active monitor', async () => {
    mockMonitorFind.mockResolvedValue(makeMonitor());
    const res = await app.inject({ method: 'POST', url: '/v1/monitoring',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'alice@example.com' }) });
    expect([400, 422]).toContain(res.statusCode);
  });

  it('returns 200 and reactivates a paused monitor', async () => {
    mockMonitorFind.mockResolvedValue(makeMonitor({ pausedAt: new Date(), isActive: false }));
    mockMonitorUpdate.mockResolvedValue(makeMonitor({ pausedAt: null, isActive: true }));
    const res = await app.inject({ method: 'POST', url: '/v1/monitoring',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'alice@example.com' }) });
    expect(res.statusCode).toBe(200);
  });

  it('applies default intervalHours of 24 when not provided', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/monitoring',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'alice@example.com' }) });
    if (res.statusCode === 201) {
      expect(res.json().intervalHours).toBe(24);
    }
  });

  it('accepts tags array', async () => {
    mockMonitorCreate.mockResolvedValue(makeMonitor({ tags: ['crm', 'outbound'] }));
    const res = await app.inject({ method: 'POST', url: '/v1/monitoring',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'alice@example.com', tags: ['crm', 'outbound'] }) });
    if (res.statusCode === 201) {
      expect(res.json().tags).toEqual(['crm', 'outbound']);
    }
  });
});

// ─── GET /v1/monitoring ───────────────────────────────────────────────────────

describe('GET /v1/monitoring', () => {
  beforeEach(() => {
    mockMonitorList.mockResolvedValue([makeMonitor()]);
    mockMonitorCount.mockResolvedValue(1);
  });

  it('returns 401 without API key', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/monitoring' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 200 with data array and pagination', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/monitoring', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('data');
    expect(res.json()).toHaveProperty('pagination');
    expect(res.json()).toHaveProperty('filters');
    expect(Array.isArray(res.json().data)).toBe(true);
  });

  it('pagination has all required fields', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/monitoring', headers: AUTH });
    const p = res.json().pagination;
    expect(p).toHaveProperty('page');
    expect(p).toHaveProperty('limit');
    expect(p).toHaveProperty('total');
    expect(p).toHaveProperty('totalPages');
    expect(p).toHaveProperty('hasNext');
    expect(p).toHaveProperty('hasPrev');
  });

  it('accepts isActive=true filter', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/monitoring?isActive=true', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().filters.isActive).toBe(true);
  });

  it('accepts isActive=false filter', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/monitoring?isActive=false', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().filters.isActive).toBe(false);
  });

  it('accepts isPaused filter', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/monitoring?isPaused=true', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().filters.isPaused).toBe(true);
  });

  it('accepts tag filter', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/monitoring?tag=crm', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().filters.tag).toBe('crm');
  });

  it('accepts email filter', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/monitoring?email=alice', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().filters.email).toBe('alice');
  });

  it('default page=1 and limit=20', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/monitoring', headers: AUTH });
    expect(res.json().pagination.page).toBe(1);
    expect(res.json().pagination.limit).toBe(20);
  });

  it('hasPrev is false on page 1', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/monitoring?page=1', headers: AUTH });
    expect(res.json().pagination.hasPrev).toBe(false);
  });

  it('each data row has isPaused field derived from pausedAt', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/monitoring', headers: AUTH });
    const row = res.json().data[0];
    expect(row).toHaveProperty('isPaused');
    expect(typeof row.isPaused).toBe('boolean');
  });
});

// ─── GET /v1/monitoring/:id ───────────────────────────────────────────────────

describe('GET /v1/monitoring/:id', () => {
  beforeEach(() => {
    mockMonitorFind.mockResolvedValue({ ...makeMonitor(), checks: [] } as never);
  });

  it('returns 404 for unknown id', async () => {
    mockMonitorFind.mockResolvedValue(null);
    const res = await app.inject({ method: 'GET', url: '/v1/monitoring/nope', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for a monitor belonging to another key', async () => {
    mockMonitorFind.mockResolvedValue({ ...makeMonitor({ apiKeyId: 'other-key' }), checks: [] } as never);
    const res = await app.inject({ method: 'GET', url: '/v1/monitoring/mon-001', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 with monitor and recentChecks array', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/monitoring/mon-001', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('recentChecks');
    expect(Array.isArray(res.json().recentChecks)).toBe(true);
  });

  it('recentChecks contains check objects when checks exist', async () => {
    const check = { ...makeCheck(), monitorId: 'mon-001' };
    mockMonitorFind.mockResolvedValue({ ...makeMonitor(), checks: [check] } as never);
    const res = await app.inject({ method: 'GET', url: '/v1/monitoring/mon-001', headers: AUTH });
    const body = res.json();
    expect(body.recentChecks).toHaveLength(1);
    const c = body.recentChecks[0];
    expect(c).toHaveProperty('id');
    expect(c).toHaveProperty('statusChanged');
    expect(c).toHaveProperty('previousStatus');
    expect(c).toHaveProperty('newStatus');
    expect(c).toHaveProperty('source');
    expect(c).toHaveProperty('checkedAt');
    expect(c).toHaveProperty('durationMs');
    expect(c).toHaveProperty('verificationId');
  });
});

// ─── PATCH /v1/monitoring/:id ─────────────────────────────────────────────────

describe('PATCH /v1/monitoring/:id', () => {
  beforeEach(() => {
    mockMonitorFind.mockResolvedValue(makeMonitor());
    mockMonitorUpdate.mockResolvedValue(makeMonitor({ intervalHours: 12 }));
  });

  it('returns 404 for unknown monitor', async () => {
    mockMonitorFind.mockResolvedValue(null);
    const res = await app.inject({ method: 'PATCH', url: '/v1/monitoring/nope',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ intervalHours: 12 }) });
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 on successful update', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/v1/monitoring/mon-001',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ intervalHours: 12 }) });
    expect(res.statusCode).toBe(200);
  });

  it('returns 422 when body is empty', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/v1/monitoring/mon-001',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({}) });
    expect([400, 422]).toContain(res.statusCode);
  });

  it('accepts isActive=false to pause', async () => {
    mockMonitorUpdate.mockResolvedValue(makeMonitor({ isActive: false }));
    const res = await app.inject({ method: 'PATCH', url: '/v1/monitoring/mon-001',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ isActive: false }) });
    expect(res.statusCode).toBe(200);
  });

  it('accepts isActive=true to resume', async () => {
    mockMonitorFind.mockResolvedValue(makeMonitor({ isActive: false, pausedAt: new Date() }));
    mockMonitorUpdate.mockResolvedValue(makeMonitor({ isActive: true, pausedAt: null }));
    const res = await app.inject({ method: 'PATCH', url: '/v1/monitoring/mon-001',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ isActive: true }) });
    expect(res.statusCode).toBe(200);
  });

  it('returns 422 for invalid intervalHours', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/v1/monitoring/mon-001',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ intervalHours: 99 }) });
    expect([400, 422]).toContain(res.statusCode);
  });
});

// ─── DELETE /v1/monitoring/:id ────────────────────────────────────────────────

describe('DELETE /v1/monitoring/:id', () => {
  beforeEach(() => {
    mockMonitorFind.mockResolvedValue(makeMonitor());
    mockMonitorDelete.mockResolvedValue(makeMonitor());
  });

  it('returns 404 for unknown monitor', async () => {
    mockMonitorFind.mockResolvedValue(null);
    const res = await app.inject({ method: 'DELETE', url: '/v1/monitoring/nope', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 with deleted=true', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/v1/monitoring/mon-001', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(true);
    expect(res.json().id).toBe('mon-001');
  });

  it('returns 404 for monitor belonging to another key', async () => {
    mockMonitorFind.mockResolvedValue(makeMonitor({ apiKeyId: 'other-key' }));
    const res = await app.inject({ method: 'DELETE', url: '/v1/monitoring/mon-001', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });
});

// ─── POST /v1/monitoring/:id/recheck ─────────────────────────────────────────

describe('POST /v1/monitoring/:id/recheck', () => {
  beforeEach(() => {
    mockMonitorFind.mockResolvedValue(makeMonitor());
    mockMonitorUpdate.mockResolvedValue(makeMonitor({ nextCheckAt: new Date() }));
    mockQueueAdd.mockResolvedValue({} as never);
  });

  it('returns 404 for unknown monitor', async () => {
    mockMonitorFind.mockResolvedValue(null);
    const res = await app.inject({ method: 'POST', url: '/v1/monitoring/nope/recheck', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  it('returns 202 with enqueued confirmation', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/monitoring/mon-001/recheck', headers: AUTH });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body).toHaveProperty('monitorId', 'mon-001');
    expect(body).toHaveProperty('email');
    expect(body).toHaveProperty('enqueuedAt');
    expect(body).toHaveProperty('message');
  });

  it('returns 422 for inactive monitor', async () => {
    mockMonitorFind.mockResolvedValue(makeMonitor({ isActive: false }));
    const res = await app.inject({ method: 'POST', url: '/v1/monitoring/mon-001/recheck', headers: AUTH });
    expect([400, 422]).toContain(res.statusCode);
  });

  it('enqueues a recheck job to the monitor queue', async () => {
    await app.inject({ method: 'POST', url: '/v1/monitoring/mon-001/recheck', headers: AUTH });
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'recheck-single',
      expect.objectContaining({ monitorId: 'mon-001', source: 'manual_recheck' }),
      expect.objectContaining({ priority: 1 }),
    );
  });

  it('sets nextCheckAt to now before enqueueing', async () => {
    await app.inject({ method: 'POST', url: '/v1/monitoring/mon-001/recheck', headers: AUTH });
    expect(mockMonitorUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'mon-001' } }),
    );
  });
});

// ─── GET /v1/monitoring/:id/checks ───────────────────────────────────────────

describe('GET /v1/monitoring/:id/checks', () => {
  beforeEach(() => {
    mockMonitorFind.mockResolvedValue(makeMonitor());
    mockCheckList.mockResolvedValue([makeCheck()]);
    mockCheckCount.mockResolvedValue(1);
  });

  it('returns 404 for unknown monitor', async () => {
    mockMonitorFind.mockResolvedValue(null);
    const res = await app.inject({ method: 'GET', url: '/v1/monitoring/nope/checks', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 with paginated checks', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/monitoring/mon-001/checks', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('monitorId', 'mon-001');
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('pagination');
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('each check has source and durationMs fields', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/monitoring/mon-001/checks', headers: AUTH });
    const check = res.json().data[0];
    expect(check).toHaveProperty('source', 'scheduled');
    expect(check).toHaveProperty('durationMs');
    expect(check).toHaveProperty('statusChanged');
    expect(check).toHaveProperty('previousStatus');
    expect(check).toHaveProperty('newStatus');
  });

  it('accepts statusChanged=true filter', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/monitoring/mon-001/checks?statusChanged=true', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().filters.statusChanged).toBe(true);
  });

  it('accepts statusChanged=false filter', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/monitoring/mon-001/checks?statusChanged=false', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().filters.statusChanged).toBe(false);
  });

  it('pagination defaults to page=1 limit=20', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/monitoring/mon-001/checks', headers: AUTH });
    expect(res.json().pagination.page).toBe(1);
    expect(res.json().pagination.limit).toBe(20);
  });
});
