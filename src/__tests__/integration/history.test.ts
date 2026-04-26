import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    apiKey:       { findUnique: vi.fn() },
    verification: { findMany: vi.fn(), count: vi.fn() },
    monitorCheck: { findMany: vi.fn() },
    webhook:      { findMany: vi.fn().mockResolvedValue([]) },
    $disconnect:  vi.fn(),
  },
  disconnectPrisma: vi.fn(),
}));

vi.mock('../../lib/redis.js', () => ({
  redis: { incr: vi.fn().mockResolvedValue(1), expire: vi.fn(), ttl: vi.fn().mockResolvedValue(55), ping: vi.fn().mockResolvedValue('PONG') },
  pingRedis: vi.fn().mockResolvedValue(true),
  redisKey:  { rateLimit: (id: string) => `rl:${id}` },
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
  uploadToStorage: vi.fn(), downloadFromStorage: vi.fn(),
  createSignedUrl: vi.fn(), deleteFromStorage: vi.fn(),
}));

vi.mock('../../engine/disposable.js', () => ({
  loadDisposableList: vi.fn(),
  isDisposableDomain: vi.fn().mockReturnValue(false),
  getBlocklistStats:  vi.fn().mockReturnValue({ exact: 0, wildcard: 0 }),
}));

vi.mock('../../engine/mx.js', () => ({
  lookupMx: vi.fn(), clearMxCache: vi.fn(),
  getMxCacheStats: vi.fn().mockReturnValue({ size: 0, maxSize: 10000 }),
}));

vi.mock('../../engine/smtp.js', () => ({
  smtpProbe: vi.fn().mockResolvedValue({
    checked: false, reachable: null, isCatchAll: null,
    greylisted: false, rawResponse: null, error: 'disabled',
  }),
}));

import { buildApp }   from '../../server.js';
import { prisma }     from '../../lib/prisma.js';

const mockFindKey       = vi.mocked(prisma.apiKey.findUnique);
const mockVerifList     = vi.mocked(prisma.verification.findMany);
const mockVerifCount    = vi.mocked(prisma.verification.count);
const mockCheckList     = vi.mocked(prisma.monitorCheck.findMany);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_KEY     = 'cnt_testhistorykey0123456789abcdefgh';
const TEST_KEY_REC = {
  id: 'key-hist-001', keyHash: '', keyPrefix: 'cnt_testhist',
  label: 'test', ownerId: null, rateLimit: 1000,
  isActive: true, createdAt: new Date(), revokedAt: null,
};
const AUTH = { authorization: `Bearer ${TEST_KEY}` };

function makeVerification(overrides: Record<string, unknown> = {}) {
  return {
    id:            'ver-001',
    email:         'alice@example.com',
    domain:        'example.com',
    status:        'valid',
    subStatus:     null,
    syntaxValid:   true,
    mxFound:       true,
    mxRecords:     ['mx.example.com'],
    isDisposable:  false,
    isRoleAccount: false,
    smtpChecked:   true,
    smtpReachable: true,
    isCatchAll:    false,
    greylisted:    false,
    score:         100,
    durationMs:    200,
    checkedAt:     new Date('2026-04-24T10:00:00Z'),
    bulkJobId:     null,
    ...overrides,
  };
}

// ─── App ──────────────────────────────────────────────────────────────────────

let app: FastifyInstance;

beforeAll(async () => {
  mockFindKey.mockResolvedValue(TEST_KEY_REC);
  app = await buildApp();
});

afterAll(async () => { await app.close(); });

beforeEach(() => {
  vi.clearAllMocks();
  mockFindKey.mockResolvedValue(TEST_KEY_REC);
  mockVerifList.mockResolvedValue([makeVerification()]);
  mockVerifCount.mockResolvedValue(1);
  mockCheckList.mockResolvedValue([]);
});

// ─── GET /v1/history/:email ───────────────────────────────────────────────────

describe('GET /v1/history/:email', () => {

  // ── Auth ──────────────────────────────────────────────────────────────────

  it('returns 401 without API key', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/history/alice%40example.com' });
    expect(res.statusCode).toBe(401);
  });

  // ── Email param validation ────────────────────────────────────────────────

  it('returns 422 for a URL param without @ sign', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/history/notanemail', headers: AUTH });
    expect([400, 422]).toContain(res.statusCode);
  });

  it('accepts percent-encoded @ (%40)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/history/alice%40example.com', headers: AUTH });
    expect(res.statusCode).toBe(200);
  });

  // ── Response shape ────────────────────────────────────────────────────────

  it('returns 200 with data array, pagination, and filters', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/history/alice%40example.com', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('email', 'alice@example.com');
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('pagination');
    expect(body).toHaveProperty('filters');
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('each record contains all required fields including greylisted', async () => {
    const res  = await app.inject({ method: 'GET', url: '/v1/history/alice%40example.com', headers: AUTH });
    const row  = res.json().data[0];
    expect(row).toHaveProperty('id');
    expect(row).toHaveProperty('status');
    expect(row).toHaveProperty('subStatus');
    expect(row).toHaveProperty('checks');
    expect(row.checks).toHaveProperty('greylisted');
    expect(row).toHaveProperty('score');
    expect(row).toHaveProperty('durationMs');
    expect(row).toHaveProperty('checkedAt');
    expect(row).toHaveProperty('source');
    expect(row).toHaveProperty('monitorId');
    expect(row).toHaveProperty('bulkJobId');
  });

  it('greylisted is a boolean in checks', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/history/alice%40example.com', headers: AUTH });
    expect(typeof res.json().data[0].checks.greylisted).toBe('boolean');
  });

  // ── Source annotation ─────────────────────────────────────────────────────

  it('source is "single_verify" when no bulkJobId and no monitor check', async () => {
    mockCheckList.mockResolvedValue([]);
    const res = await app.inject({ method: 'GET', url: '/v1/history/alice%40example.com', headers: AUTH });
    expect(res.json().data[0].source).toBe('single_verify');
  });

  it('source is "bulk_job" when bulkJobId is set', async () => {
    mockVerifList.mockResolvedValue([makeVerification({ bulkJobId: 'bulk-001' })]);
    mockCheckList.mockResolvedValue([]);
    const res = await app.inject({ method: 'GET', url: '/v1/history/alice%40example.com', headers: AUTH });
    expect(res.json().data[0].source).toBe('bulk_job');
  });

  it('source is "scheduled" and monitorId is set when verification came from monitor', async () => {
    mockCheckList.mockResolvedValue([{
      verificationId: 'ver-001',
      monitorId:      'mon-001',
      source:         'scheduled',
    }]);
    const res = await app.inject({ method: 'GET', url: '/v1/history/alice%40example.com', headers: AUTH });
    const row = res.json().data[0];
    expect(row.source).toBe('scheduled');
    expect(row.monitorId).toBe('mon-001');
  });

  it('source is "manual_recheck" for recheck-triggered verifications', async () => {
    mockCheckList.mockResolvedValue([{
      verificationId: 'ver-001',
      monitorId:      'mon-001',
      source:         'manual_recheck',
    }]);
    const res = await app.inject({ method: 'GET', url: '/v1/history/alice%40example.com', headers: AUTH });
    expect(res.json().data[0].source).toBe('manual_recheck');
  });

  it('monitorId is null for single_verify records', async () => {
    mockCheckList.mockResolvedValue([]);
    const res = await app.inject({ method: 'GET', url: '/v1/history/alice%40example.com', headers: AUTH });
    expect(res.json().data[0].monitorId).toBeNull();
  });

  // ── Filters ───────────────────────────────────────────────────────────────

  it('accepts status=valid filter', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/history/alice%40example.com?status=valid', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().filters.status).toBe('valid');
  });

  it('accepts status=invalid filter', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/history/alice%40example.com?status=invalid', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().filters.status).toBe('invalid');
  });

  it('rejects invalid status value', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/history/alice%40example.com?status=BOGUS', headers: AUTH });
    expect([400, 422]).toContain(res.statusCode);
  });

  it('accepts since filter (ISO timestamp)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/history/alice%40example.com?since=2026-01-01T00:00:00.000Z',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().filters.since).toBe('2026-01-01T00:00:00.000Z');
  });

  it('accepts until filter (ISO timestamp)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/history/alice%40example.com?until=2026-12-31T23:59:59.000Z',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().filters.until).toBe('2026-12-31T23:59:59.000Z');
  });

  it('accepts since + until together', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/history/alice%40example.com?since=2026-01-01T00:00:00.000Z&until=2026-06-01T00:00:00.000Z',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().filters.since).not.toBeNull();
    expect(res.json().filters.until).not.toBeNull();
  });

  it('rejects malformed since value', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/history/alice%40example.com?since=not-a-date',
      headers: AUTH,
    });
    expect([400, 422]).toContain(res.statusCode);
  });

  // ── Pagination ────────────────────────────────────────────────────────────

  it('pagination defaults to page=1 limit=20', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/history/alice%40example.com', headers: AUTH });
    expect(res.json().pagination.page).toBe(1);
    expect(res.json().pagination.limit).toBe(20);
  });

  it('hasPrev is false on page 1', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/history/alice%40example.com?page=1', headers: AUTH });
    expect(res.json().pagination.hasPrev).toBe(false);
  });

  it('hasPrev is true on page 2', async () => {
    mockVerifCount.mockResolvedValue(50);
    const res = await app.inject({ method: 'GET', url: '/v1/history/alice%40example.com?page=2&limit=20', headers: AUTH });
    expect(res.json().pagination.hasPrev).toBe(true);
  });

  it('hasNext is true when more pages exist', async () => {
    mockVerifCount.mockResolvedValue(100);
    const res = await app.inject({ method: 'GET', url: '/v1/history/alice%40example.com?page=1&limit=20', headers: AUTH });
    expect(res.json().pagination.hasNext).toBe(true);
  });

  it('totalPages is calculated correctly', async () => {
    mockVerifCount.mockResolvedValue(45);
    const res = await app.inject({ method: 'GET', url: '/v1/history/alice%40example.com?limit=20', headers: AUTH });
    expect(res.json().pagination.totalPages).toBe(3);
  });

  it('returns empty data array when no verifications exist', async () => {
    mockVerifList.mockResolvedValue([]);
    mockVerifCount.mockResolvedValue(0);
    const res  = await app.inject({ method: 'GET', url: '/v1/history/alice%40example.com', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(0);
    expect(res.json().pagination.total).toBe(0);
  });

  // ── Checks object fields ──────────────────────────────────────────────────

  it('checks object has all 9 fields', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/history/alice%40example.com', headers: AUTH });
    const checks = res.json().data[0].checks;
    expect(checks).toHaveProperty('syntaxValid');
    expect(checks).toHaveProperty('mxFound');
    expect(checks).toHaveProperty('mxRecords');
    expect(checks).toHaveProperty('isDisposable');
    expect(checks).toHaveProperty('isRoleAccount');
    expect(checks).toHaveProperty('smtpChecked');
    expect(checks).toHaveProperty('smtpReachable');
    expect(checks).toHaveProperty('isCatchAll');
    expect(checks).toHaveProperty('greylisted');
  });
});
