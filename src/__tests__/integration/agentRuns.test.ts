import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

// ─── Mock all external dependencies ──────────────────────────────────────────

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    apiKey: { findUnique: vi.fn() },
    agentRun: {
      count: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    agentRunEvent: { findMany: vi.fn(), count: vi.fn(), create: vi.fn() },
    mailingList: { findFirst: vi.fn() },
    sequence: { findFirst: vi.fn() },
    mailbox: { findFirst: vi.fn() },
    webhook: { findMany: vi.fn().mockResolvedValue([]) },
    $disconnect: vi.fn(),
  },
  disconnectPrisma: vi.fn(),
}));

// withTenant/withRlsBypass just pass the plain (mocked) prisma client
// through as `tx` — the routes call tx.agentRun.* the same way the mocks
// above expose it, so this keeps the test focused on route behavior rather
// than re-proving tenantContext.ts's own SET LOCAL logic.
vi.mock('../../lib/tenantContext.js', () => ({
  withTenant: vi.fn(async (_apiKeyId: string, fn: (tx: unknown) => unknown) => {
    const { prisma } = await import('../../lib/prisma.js');
    return fn(prisma);
  }),
  withRlsBypass: vi.fn(async (fn: (tx: unknown) => unknown) => {
    const { prisma } = await import('../../lib/prisma.js');
    return fn(prisma);
  }),
}));

vi.mock('../../lib/redis.js', () => ({
  redis: { incr: vi.fn().mockResolvedValue(1), expire: vi.fn(), ttl: vi.fn().mockResolvedValue(55), ping: vi.fn().mockResolvedValue('PONG') },
  pingRedis: vi.fn().mockResolvedValue(true),
  redisKey: { rateLimit: (id: string) => `rl:${id}`, ipRateLimit: (scope: string, ip: string) => `rl:ip:${scope}:${ip}`, agentRunLock: (id: string) => `lock:agent-run:${id}` },
  getRedis: vi.fn(),
}));

vi.mock('../../lib/queue.js', () => ({
  bulkQueue: { add: vi.fn(), close: vi.fn() },
  webhookQueue: { add: vi.fn(), close: vi.fn() },
  monitorQueue: { add: vi.fn(), close: vi.fn() },
  agentRunQueue: { add: vi.fn(), close: vi.fn() },
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

vi.mock('../../lib/nurtureAgent.js', () => ({
  createAndSendCampaignFromDraft: vi.fn().mockResolvedValue('camp-mock-1'),
}));

import { buildApp } from '../../server.js';
import { prisma } from '../../lib/prisma.js';
import { agentRunQueue } from '../../lib/queue.js';
import { createAndSendCampaignFromDraft } from '../../lib/nurtureAgent.js';

const mockFindKey       = vi.mocked(prisma.apiKey.findUnique);
const mockRunCount      = vi.mocked(prisma.agentRun.count);
const mockRunFindFirst  = vi.mocked(prisma.agentRun.findFirst);
const mockRunFindMany   = vi.mocked(prisma.agentRun.findMany);
const mockRunCreate     = vi.mocked(prisma.agentRun.create);
const mockRunUpdate     = vi.mocked(prisma.agentRun.update);
const mockEventFindMany = vi.mocked(prisma.agentRunEvent.findMany);
const mockEventCount    = vi.mocked(prisma.agentRunEvent.count);
const mockEventCreate   = vi.mocked(prisma.agentRunEvent.create);
const mockListFind      = vi.mocked(prisma.mailingList.findFirst);
const mockSequenceFind  = vi.mocked(prisma.sequence.findFirst);
const mockMailboxFind   = vi.mocked(prisma.mailbox.findFirst);
const mockQueueAdd      = vi.mocked(agentRunQueue.add);
const mockCreateAndSend = vi.mocked(createAndSendCampaignFromDraft);

// ─── Test API key ─────────────────────────────────────────────────────────────

const TEST_KEY = 'cnt_testagentrunkey0123456789abcdefgh';
const TEST_KEY_REC = {
  id: 'key-agent-001', keyHash: '', keyPrefix: 'cnt_testagentrun',
  label: 'test', ownerId: null, userId: null, orgId: null, keyRaw: null, rateLimit: 1000,
  monthlyLimit: 100000, currentMonthUsage: 0, usageResetAt: new Date(), plan: 'free',
  isActive: true, createdAt: new Date(), revokedAt: null,
  name: null, monthlySendLimit: 500, currentMonthSendUsage: 0, sendUsageResetAt: new Date(),
  permission: 'full_access', restrictedDomainId: null, lastUsedAt: null, extraVerificationCredits: 0, extraSendCredits: 0,
};
const AUTH = { authorization: `Bearer ${TEST_KEY}` };

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeAgentRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-001',
    apiKeyId: 'key-agent-001',
    pillar: 'verification',
    name: null,
    status: 'active',
    config: { listId: 'list-001', autoRemoveInvalid: false, cutoffDays: 30 },
    errorMessage: null,
    intervalHours: 24,
    nextCheckAt: new Date(Date.now() + 86_400_000),
    lastCheckedAt: null,
    consecutiveFailures: 0,
    pausedAt: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date('2026-09-15T10:00:00Z'),
    cancelledAt: null,
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

// ─── POST /v1/agent-runs ────────────────────────────────────────────────────

describe('POST /v1/agent-runs', () => {
  beforeEach(() => {
    mockRunCount.mockResolvedValue(0);
    mockListFind.mockResolvedValue({ id: 'list-001' });
    mockRunCreate.mockResolvedValue(makeAgentRun());
  });

  it('returns 401 without API key', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/agent-runs',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ listId: 'list-001' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 201 on success', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/agent-runs',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ listId: 'list-001', intervalHours: 24 }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.pillar).toBe('verification');
    expect(body.status).toBe('active');
  });

  it('returns 422 when listId is missing', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/agent-runs',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ intervalHours: 24 }),
    });
    expect(res.statusCode).toBe(422);
  });

  it('returns 404 when the referenced list does not belong to this key', async () => {
    mockListFind.mockResolvedValue(null);
    const res = await app.inject({
      method: 'POST', url: '/v1/agent-runs',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ listId: 'someone-elses-list' }),
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 422 when the plan agent-run limit is reached', async () => {
    mockRunCount.mockResolvedValue(2); // free plan limit
    const res = await app.inject({
      method: 'POST', url: '/v1/agent-runs',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ listId: 'list-001' }),
    });
    expect(res.statusCode).toBe(422);
  });

  it('applies default intervalHours of 24 and autoRemoveInvalid false when not provided', async () => {
    await app.inject({
      method: 'POST', url: '/v1/agent-runs',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ listId: 'list-001' }),
    });
    const createCall = mockRunCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(createCall.data['intervalHours']).toBe(24);
    expect((createCall.data['config'] as Record<string, unknown>)['autoRemoveInvalid']).toBe(false);
  });
});

// ─── GET /v1/agent-runs ─────────────────────────────────────────────────────

describe('GET /v1/agent-runs', () => {
  it('returns 401 without API key', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/agent-runs' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 200 with data array and pagination', async () => {
    mockRunFindMany.mockResolvedValue([makeAgentRun()]);
    mockRunCount.mockResolvedValue(1);
    const res = await app.inject({ method: 'GET', url: '/v1/agent-runs', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.pagination.total).toBe(1);
  });
});

// ─── GET /v1/agent-runs/:id ─────────────────────────────────────────────────

describe('GET /v1/agent-runs/:id', () => {
  it('returns 404 for unknown id', async () => {
    mockRunFindFirst.mockResolvedValue(null);
    const res = await app.inject({ method: 'GET', url: '/v1/agent-runs/nope', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 with the agent run', async () => {
    mockRunFindFirst.mockResolvedValue(makeAgentRun());
    const res = await app.inject({ method: 'GET', url: '/v1/agent-runs/run-001', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe('run-001');
  });
});

// ─── GET /v1/agent-runs/:id/events ──────────────────────────────────────────

describe('GET /v1/agent-runs/:id/events', () => {
  it('returns 404 for unknown agent run', async () => {
    mockRunFindFirst.mockResolvedValue(null);
    const res = await app.inject({ method: 'GET', url: '/v1/agent-runs/nope/events', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 with paginated events', async () => {
    mockRunFindFirst.mockResolvedValue({ id: 'run-001' });
    mockEventFindMany.mockResolvedValue([
      { id: 'evt-1', eventType: 'verified', message: 'Verified 3, 3 valid', data: { valid: 3 }, createdAt: new Date() },
    ]);
    mockEventCount.mockResolvedValue(1);
    const res = await app.inject({ method: 'GET', url: '/v1/agent-runs/run-001/events', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].message).toContain('Verified 3');
  });
});

// ─── PATCH /v1/agent-runs/:id ───────────────────────────────────────────────

describe('PATCH /v1/agent-runs/:id', () => {
  it('returns 404 for unknown agent run', async () => {
    mockRunFindFirst.mockResolvedValue(null);
    const res = await app.inject({
      method: 'PATCH', url: '/v1/agent-runs/nope',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ status: 'paused' }),
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 422 when body is empty', async () => {
    mockRunFindFirst.mockResolvedValue(makeAgentRun());
    const res = await app.inject({
      method: 'PATCH', url: '/v1/agent-runs/run-001',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(422);
  });

  it('pausing sets status paused and pausedAt (kill switch)', async () => {
    mockRunFindFirst.mockResolvedValue(makeAgentRun());
    mockRunUpdate.mockResolvedValue(makeAgentRun({ status: 'paused', pausedAt: new Date() }));
    const res = await app.inject({
      method: 'PATCH', url: '/v1/agent-runs/run-001',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ status: 'paused' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isPaused).toBe(true);
    const updateCall = mockRunUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(updateCall.data['status']).toBe('paused');
    expect(updateCall.data['pausedAt']).toBeInstanceOf(Date);
  });

  it('resuming recomputes nextCheckAt and resets failure state', async () => {
    mockRunFindFirst.mockResolvedValue(makeAgentRun({ status: 'paused', pausedAt: new Date(), consecutiveFailures: 3 }));
    mockRunUpdate.mockResolvedValue(makeAgentRun({ status: 'active', pausedAt: null }));
    const res = await app.inject({
      method: 'PATCH', url: '/v1/agent-runs/run-001',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ status: 'active' }),
    });
    expect(res.statusCode).toBe(200);
    const updateCall = mockRunUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(updateCall.data['pausedAt']).toBeNull();
    expect(updateCall.data['consecutiveFailures']).toBe(0);
    expect(updateCall.data['nextCheckAt']).toBeInstanceOf(Date);
  });

  it('rejects updates to a cancelled agent run', async () => {
    mockRunFindFirst.mockResolvedValue(makeAgentRun({ status: 'cancelled' }));
    const res = await app.inject({
      method: 'PATCH', url: '/v1/agent-runs/run-001',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ status: 'active' }),
    });
    expect(res.statusCode).toBe(422);
  });
});

// ─── POST /v1/agent-runs/:id/cancel ─────────────────────────────────────────

describe('POST /v1/agent-runs/:id/cancel', () => {
  it('returns 404 for unknown agent run', async () => {
    mockRunFindFirst.mockResolvedValue(null);
    const res = await app.inject({ method: 'POST', url: '/v1/agent-runs/nope/cancel', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  it('cancels an active agent run', async () => {
    mockRunFindFirst.mockResolvedValue(makeAgentRun());
    mockRunUpdate.mockResolvedValue(makeAgentRun({ status: 'cancelled', cancelledAt: new Date() }));
    const res = await app.inject({ method: 'POST', url: '/v1/agent-runs/run-001/cancel', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('cancelled');
  });

  it('is idempotent when already cancelled', async () => {
    mockRunFindFirst.mockResolvedValue(makeAgentRun({ status: 'cancelled' }));
    const res = await app.inject({ method: 'POST', url: '/v1/agent-runs/run-001/cancel', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('cancelled');
    expect(mockRunUpdate).not.toHaveBeenCalled();
  });
});

// ─── POST /v1/agent-runs/:id/trigger ────────────────────────────────────────

describe('POST /v1/agent-runs/:id/trigger', () => {
  it('returns 404 for unknown agent run', async () => {
    mockRunFindFirst.mockResolvedValue(null);
    const res = await app.inject({ method: 'POST', url: '/v1/agent-runs/nope/trigger', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  it('returns 422 when the run is paused', async () => {
    mockRunFindFirst.mockResolvedValue(makeAgentRun({ status: 'paused', pausedAt: new Date() }));
    const res = await app.inject({ method: 'POST', url: '/v1/agent-runs/run-001/trigger', headers: AUTH });
    expect(res.statusCode).toBe(422);
  });

  it('returns 202 and enqueues a kick job for an active run', async () => {
    mockRunFindFirst.mockResolvedValue(makeAgentRun());
    const res = await app.inject({ method: 'POST', url: '/v1/agent-runs/run-001/trigger', headers: AUTH });
    expect(res.statusCode).toBe(202);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'agent-run-kick',
      { agentRunId: 'run-001' },
      expect.objectContaining({ priority: 1 }),
    );
  });
});

// ─── POST /v1/agent-runs — nurture pillar ───────────────────────────────────

function makeNurtureAgentRun(overrides: Record<string, unknown> = {}) {
  return makeAgentRun({
    pillar: 'nurture',
    config: { listId: 'list-001', about: 'a new security feature', fromName: 'Ada', fromEmail: 'ada@acme.com', autoSend: false },
    intervalHours: null,
    nextCheckAt: null,
    ...overrides,
  });
}

describe('POST /v1/agent-runs — nurture pillar', () => {
  beforeEach(() => {
    mockRunCount.mockResolvedValue(0);
    mockListFind.mockResolvedValue({ id: 'list-001' });
    mockRunCreate.mockResolvedValue(makeNurtureAgentRun());
  });

  it('creates a nurture run and immediately enqueues a kick job (one-shot, not tick-scheduled)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/agent-runs',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ pillar: 'nurture', listId: 'list-001', about: 'a new security feature', fromName: 'Ada', fromEmail: 'ada@acme.com' }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().pillar).toBe('nurture');
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'agent-run-kick',
      { agentRunId: 'run-001' },
      expect.any(Object),
    );
  });

  it('returns 422 when about/fromName/fromEmail are missing', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/agent-runs',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ pillar: 'nurture', listId: 'list-001' }),
    });
    expect(res.statusCode).toBe(422);
  });

  it('defaults autoSend to false (human-in-the-loop by default)', async () => {
    await app.inject({
      method: 'POST', url: '/v1/agent-runs',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ pillar: 'nurture', listId: 'list-001', about: 'x', fromName: 'Ada', fromEmail: 'ada@acme.com' }),
    });
    const createCall = mockRunCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect((createCall.data['config'] as Record<string, unknown>)['autoSend']).toBe(false);
  });

  it('a request with no pillar field still defaults to verification (backward compatible)', async () => {
    mockRunCreate.mockResolvedValue(makeAgentRun());
    const res = await app.inject({
      method: 'POST', url: '/v1/agent-runs',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ listId: 'list-001' }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().pillar).toBe('verification');
  });
});

// ─── POST /v1/agent-runs/:id/approve ────────────────────────────────────────

describe('POST /v1/agent-runs/:id/approve', () => {
  it('returns 404 for unknown agent run', async () => {
    mockRunFindFirst.mockResolvedValue(null);
    const res = await app.inject({ method: 'POST', url: '/v1/agent-runs/nope/approve', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  it('returns 422 for a verification-pillar run (no approval step outside nurture)', async () => {
    mockRunFindFirst.mockResolvedValue(makeAgentRun({ status: 'pending_approval' }));
    const res = await app.inject({ method: 'POST', url: '/v1/agent-runs/run-001/approve', headers: AUTH });
    expect(res.statusCode).toBe(422);
  });

  it('returns 422 when the run is not pending_approval', async () => {
    mockRunFindFirst.mockResolvedValue(makeNurtureAgentRun({ status: 'active' }));
    const res = await app.inject({ method: 'POST', url: '/v1/agent-runs/run-001/approve', headers: AUTH });
    expect(res.statusCode).toBe(422);
  });

  it('returns 422 when pending_approval but has no draft yet', async () => {
    mockRunFindFirst.mockResolvedValue(makeNurtureAgentRun({ status: 'pending_approval' }));
    const res = await app.inject({ method: 'POST', url: '/v1/agent-runs/run-001/approve', headers: AUTH });
    expect(res.statusCode).toBe(422);
    expect(mockCreateAndSend).not.toHaveBeenCalled();
  });

  it('creates and sends the campaign, marks the run completed, on a valid approval', async () => {
    const draft = { subject: 'New feature!', htmlBody: '<p>hi</p>', textBody: 'hi', segmentLabel: 'All contacts', matchCount: 120 };
    mockRunFindFirst.mockResolvedValue(makeNurtureAgentRun({ status: 'pending_approval', config: { listId: 'list-001', about: 'x', fromName: 'Ada', fromEmail: 'ada@acme.com', draft } }));
    mockRunUpdate.mockResolvedValue(makeNurtureAgentRun({ status: 'completed', completedAt: new Date() }));

    const res = await app.inject({ method: 'POST', url: '/v1/agent-runs/run-001/approve', headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(mockCreateAndSend).toHaveBeenCalledWith('key-agent-001', expect.objectContaining({ draft }));
    expect(res.json().campaignId).toBe('camp-mock-1');
    expect(mockEventCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventType: 'sent', agentRunId: 'run-001' }),
    }));
  });
});

// ─── POST /v1/agent-runs — lead_finding pillar ──────────────────────────────

function makeLeadFindingAgentRun(overrides: Record<string, unknown> = {}) {
  return makeAgentRun({
    pillar: 'lead_finding',
    config: { searchFilters: { personTitleIncludes: ['CISO'], totalResults: 100 } },
    intervalHours: 168,
    ...overrides,
  });
}

describe('POST /v1/agent-runs — lead_finding pillar', () => {
  beforeEach(() => {
    mockRunCount.mockResolvedValue(0);
    mockRunCreate.mockResolvedValue(makeLeadFindingAgentRun());
  });

  it('creates a lead-finding run without validating a mailing list (it searches externally)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/agent-runs',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ pillar: 'lead_finding', searchFilters: { personTitleIncludes: ['CISO'] } }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().pillar).toBe('lead_finding');
    expect(mockListFind).not.toHaveBeenCalled();
  });

  it('defaults intervalHours to 168 (weekly)', async () => {
    await app.inject({
      method: 'POST', url: '/v1/agent-runs',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ pillar: 'lead_finding', searchFilters: { personTitleIncludes: ['CISO'] } }),
    });
    const createCall = mockRunCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(createCall.data['intervalHours']).toBe(168);
  });

  it('returns 422 when searchFilters is missing', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/agent-runs',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ pillar: 'lead_finding' }),
    });
    expect(res.statusCode).toBe(422);
  });

  it('validates sequenceId ownership when auto-enroll is configured', async () => {
    mockSequenceFind.mockResolvedValue(null);
    const res = await app.inject({
      method: 'POST', url: '/v1/agent-runs',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ pillar: 'lead_finding', searchFilters: { personTitleIncludes: ['CISO'] }, sequenceId: 'someone-elses-sequence' }),
    });
    expect(res.statusCode).toBe(404);
  });

  it('creates successfully when sequenceId belongs to this key', async () => {
    mockSequenceFind.mockResolvedValue({ id: 'seq-001' });
    const res = await app.inject({
      method: 'POST', url: '/v1/agent-runs',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ pillar: 'lead_finding', searchFilters: { personTitleIncludes: ['CISO'] }, sequenceId: 'seq-001' }),
    });
    expect(res.statusCode).toBe(201);
  });
});

// ─── POST /v1/agent-runs — warmup pillar ────────────────────────────────────

function makeWarmupAgentRun(overrides: Record<string, unknown> = {}) {
  return makeAgentRun({
    pillar: 'warmup',
    config: { mailboxId: 'mbx-001', baselineDailyRampUp: 2 },
    intervalHours: 24,
    ...overrides,
  });
}

describe('POST /v1/agent-runs — warmup pillar', () => {
  beforeEach(() => {
    mockRunCount.mockResolvedValue(0);
    mockRunFindFirst.mockResolvedValue(null); // no existing duplicate warmup agent
    mockMailboxFind.mockResolvedValue({ id: 'mbx-001', warmupConfig: { dailyRampUp: 2 } });
    mockRunCreate.mockResolvedValue(makeWarmupAgentRun());
  });

  it('creates a warmup agent, capturing the mailbox\'s current dailyRampUp as the baseline', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/agent-runs',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ pillar: 'warmup', mailboxId: 'mbx-001' }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().pillar).toBe('warmup');
    const createCall = mockRunCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(createCall.data['config']).toEqual({ mailboxId: 'mbx-001', baselineDailyRampUp: 2 });
    expect(createCall.data['intervalHours']).toBe(24);
  });

  it('returns 404 when the mailbox does not belong to this key', async () => {
    mockMailboxFind.mockResolvedValue(null);
    const res = await app.inject({
      method: 'POST', url: '/v1/agent-runs',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ pillar: 'warmup', mailboxId: 'someone-elses-mailbox' }),
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 422 when the mailbox does not have warmup enabled', async () => {
    mockMailboxFind.mockResolvedValue({ id: 'mbx-001', warmupConfig: null });
    const res = await app.inject({
      method: 'POST', url: '/v1/agent-runs',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ pillar: 'warmup', mailboxId: 'mbx-001' }),
    });
    expect(res.statusCode).toBe(422);
  });

  it('returns 422 when this mailbox already has an active warmup agent', async () => {
    mockRunFindFirst.mockResolvedValue({ id: 'run-existing' });
    const res = await app.inject({
      method: 'POST', url: '/v1/agent-runs',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ pillar: 'warmup', mailboxId: 'mbx-001' }),
    });
    expect(res.statusCode).toBe(422);
  });

  it('returns 422 when mailboxId is missing', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/agent-runs',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ pillar: 'warmup' }),
    });
    expect(res.statusCode).toBe(422);
  });
});
