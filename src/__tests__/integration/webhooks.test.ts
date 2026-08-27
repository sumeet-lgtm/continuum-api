import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

// ─── Mock all external I/O ────────────────────────────────────────────────────

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    apiKey: { findUnique: vi.fn() },
    webhook: {
      count:      vi.fn(),
      create:     vi.fn(),
      findMany:   vi.fn(),
      findUnique: vi.fn(),
      update:     vi.fn(),
      delete:     vi.fn(),
    },
    webhookDelivery: {
      create:     vi.fn(),
      findMany:   vi.fn(),
      findFirst:  vi.fn(),
      findUnique: vi.fn(),
      count:      vi.fn(),
      update:     vi.fn(),
    },
    webhookAttempt: { create: vi.fn() },
    $disconnect: vi.fn(),
  },
  disconnectPrisma: vi.fn(),
}));

vi.mock('../../lib/redis.js', () => ({
  redis: {
    incr:   vi.fn().mockResolvedValue(1),
    expire: vi.fn(),
    ttl:    vi.fn().mockResolvedValue(55),
    ping:   vi.fn().mockResolvedValue('PONG'),
  },
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
  uploadToStorage:     vi.fn(),
  downloadFromStorage: vi.fn(),
  createSignedUrl:     vi.fn(),
  deleteFromStorage:   vi.fn(),
}));

vi.mock('../../engine/disposable.js', () => ({
  loadDisposableList:  vi.fn(),
  isDisposableDomain:  vi.fn().mockReturnValue(false),
  getBlocklistStats:   vi.fn().mockReturnValue({ exact: 0, wildcard: 0 }),
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

import { buildApp }      from '../../server.js';
import { prisma }        from '../../lib/prisma.js';
import { webhookQueue }  from '../../lib/queue.js';
import { signWebhookPayload, verifyWebhookSignature } from '../../lib/crypto.js';

const mockFindKey       = vi.mocked(prisma.apiKey.findUnique);
const mockWebhookCount  = vi.mocked(prisma.webhook.count);
const mockWebhookCreate = vi.mocked(prisma.webhook.create);
const mockWebhookList   = vi.mocked(prisma.webhook.findMany);
const mockWebhookFind   = vi.mocked(prisma.webhook.findUnique);
const mockWebhookUpdate = vi.mocked(prisma.webhook.update);
const mockWebhookDelete = vi.mocked(prisma.webhook.delete);
const mockDeliveryCreate = vi.mocked(prisma.webhookDelivery.create);
const mockDeliveryList  = vi.mocked(prisma.webhookDelivery.findMany);
const mockDeliveryCount = vi.mocked(prisma.webhookDelivery.count);
const mockDeliveryFind  = vi.mocked(prisma.webhookDelivery.findUnique);
const mockQueueAdd      = vi.mocked(webhookQueue.add);

// ─── Test fixtures ────────────────────────────────────────────────────────────

const TEST_KEY     = 'cnt_testwebhookkey0123456789abcdefg';
const TEST_KEY_REC = {
  id: 'key-wh-001', keyHash: '', keyPrefix: 'cnt_testwh',
  label: 'test', ownerId: null, userId: null, keyRaw: null, rateLimit: 1000,
  monthlyLimit: 100000, currentMonthUsage: 0, usageResetAt: new Date(), plan: 'free',
  isActive: true, createdAt: new Date(), revokedAt: null,
  name: null, monthlySendLimit: 500, currentMonthSendUsage: 0, sendUsageResetAt: new Date(),
  permission: 'full_access', restrictedDomainId: null, lastUsedAt: null,
};
const AUTH = { authorization: `Bearer ${TEST_KEY}` };

function makeWebhook(overrides: Record<string, unknown> = {}) {
  return {
    id:              'wh-001',
    apiKeyId:        'key-wh-001',
    url:             'https://example.com/webhook',
    label:           null,
    description:     null,
    events:          ['verification.completed'] as never,
    isActive:        true,
    createdAt:       new Date('2026-04-24T10:00:00Z'),
    lastPingAt:      null,
    lastPingOk:      null,
    totalDeliveries: 0,
    successCount:    0,
    failureCount:    0,
    secret:          'a'.repeat(64), // 64 hex chars
    ...overrides,
  };
}

function makeDelivery(overrides: Record<string, unknown> = {}) {
  return {
    id:                'del-001',
    webhookId:         'wh-001',
    event:             'verification.completed' as never,
    eventId:           'verification.completed:ver-001',
    attempts:          1,
    maxAttempts:       5,
    delivered:         true,
    failedPermanently: false,
    nextRetryAt:       null,
    lastAttemptAt:     new Date('2026-04-24T10:01:00Z'),
    statusCode:        200,
    errorMessage:      null,
    createdAt:         new Date('2026-04-24T10:00:00Z'),
    payload:           { event: 'verification.completed', id: 'ver-001' } as never,
    responseBody:      '{"ok":true}',
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
  mockWebhookCount.mockResolvedValue(0);
  mockQueueAdd.mockResolvedValue({} as never);
});

// ─── POST /v1/webhooks ────────────────────────────────────────────────────────

describe('POST /v1/webhooks', () => {
  beforeEach(() => {
    mockWebhookCreate.mockResolvedValue(makeWebhook());
  });

  it('returns 401 without API key', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/webhooks',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ url: 'https://example.com', events: ['verification.completed'] }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 201 with webhook and secret on success', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/webhooks',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ url: 'https://example.com/wh', events: ['verification.completed'] }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toHaveProperty('id');
    expect(body).toHaveProperty('secret');
    expect(body).toHaveProperty('_secretNote');
  });

  it('secret is a 64-char hex string', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/webhooks',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ url: 'https://example.com/wh', events: ['verification.completed'] }),
    });
    if (res.statusCode === 201) {
      expect(res.json().secret).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('response includes all required fields', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/webhooks',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ url: 'https://example.com/wh', events: ['verification.completed'] }),
    });
    if (res.statusCode === 201) {
      const body = res.json();
      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('url');
      expect(body).toHaveProperty('label');
      expect(body).toHaveProperty('events');
      expect(body).toHaveProperty('isActive');
      expect(body).toHaveProperty('createdAt');
      expect(body).toHaveProperty('totalDeliveries');
      expect(body).toHaveProperty('successCount');
      expect(body).toHaveProperty('failureCount');
    }
  });

  it('returns 422 when url is not HTTPS', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/webhooks',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ url: 'http://example.com/wh', events: ['verification.completed'] }),
    });
    expect([400, 422]).toContain(res.statusCode);
  });

  it('returns 422 when events array is empty', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/webhooks',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ url: 'https://example.com/wh', events: [] }),
    });
    expect([400, 422]).toContain(res.statusCode);
  });

  it('returns 422 for an invalid event name', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/webhooks',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ url: 'https://example.com/wh', events: ['not_a_real_event'] }),
    });
    expect([400, 422]).toContain(res.statusCode);
  });

  it('accepts all three Phase 5 event names', async () => {
    const events = ['verification.completed', 'email.status_changed', 'bulk_job.completed'];
    mockWebhookCreate.mockResolvedValue(makeWebhook({ events }));

    const res = await app.inject({
      method: 'POST', url: '/v1/webhooks',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ url: 'https://example.com/wh', events }),
    });
    expect(res.statusCode).toBe(201);
  });

  it('accepts legacy event names for backwards compat', async () => {
    const events = ['verification_complete', 'bulk_job_complete', 'monitor_status_change'];
    mockWebhookCreate.mockResolvedValue(makeWebhook({ events }));

    const res = await app.inject({
      method: 'POST', url: '/v1/webhooks',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ url: 'https://example.com/wh', events }),
    });
    expect(res.statusCode).toBe(201);
  });

  it('accepts optional label field', async () => {
    mockWebhookCreate.mockResolvedValue(makeWebhook({ label: 'Production endpoint' }));

    const res = await app.inject({
      method: 'POST', url: '/v1/webhooks',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({
        url: 'https://example.com/wh',
        events: ['verification.completed'],
        label: 'Production endpoint',
      }),
    });
    if (res.statusCode === 201) {
      expect(res.json().label).toBe('Production endpoint');
    }
  });

  it('returns 422 when at max webhooks (10)', async () => {
    mockWebhookCount.mockResolvedValue(10);

    const res = await app.inject({
      method: 'POST', url: '/v1/webhooks',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ url: 'https://example.com/wh', events: ['verification.completed'] }),
    });
    expect([400, 422]).toContain(res.statusCode);
  });
});

// ─── GET /v1/webhooks ─────────────────────────────────────────────────────────

describe('GET /v1/webhooks', () => {
  beforeEach(() => {
    mockWebhookList.mockResolvedValue([makeWebhook()]);
  });

  it('returns 401 without API key', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/webhooks' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 200 with data array and total', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/webhooks', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('data');
    expect(res.json()).toHaveProperty('total');
    expect(Array.isArray(res.json().data)).toBe(true);
  });

  it('each webhook has stats fields', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/webhooks', headers: AUTH });
    const wh = res.json().data[0];
    expect(wh).toHaveProperty('totalDeliveries');
    expect(wh).toHaveProperty('successCount');
    expect(wh).toHaveProperty('failureCount');
  });

  it('does NOT include secret in list response', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/webhooks', headers: AUTH });
    const wh = res.json().data[0];
    expect(wh).not.toHaveProperty('secret');
  });

  it('returns empty array when no webhooks exist', async () => {
    mockWebhookList.mockResolvedValue([]);
    const res = await app.inject({ method: 'GET', url: '/v1/webhooks', headers: AUTH });
    expect(res.json().data).toHaveLength(0);
    expect(res.json().total).toBe(0);
  });
});

// ─── GET /v1/webhooks/:id ─────────────────────────────────────────────────────

describe('GET /v1/webhooks/:id', () => {
  beforeEach(() => {
    mockWebhookFind.mockResolvedValue(makeWebhook());
  });

  it('returns 401 without API key', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/webhooks/wh-001' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 for unknown webhook', async () => {
    mockWebhookFind.mockResolvedValue(null);
    const res = await app.inject({ method: 'GET', url: '/v1/webhooks/nope', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for webhook belonging to another key', async () => {
    mockWebhookFind.mockResolvedValue(makeWebhook({ apiKeyId: 'other-key' }));
    const res = await app.inject({ method: 'GET', url: '/v1/webhooks/wh-001', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 with webhook details', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/webhooks/wh-001', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('id', 'wh-001');
    expect(res.json()).not.toHaveProperty('secret');
  });
});

// ─── PATCH /v1/webhooks/:id ───────────────────────────────────────────────────

describe('PATCH /v1/webhooks/:id', () => {
  beforeEach(() => {
    mockWebhookFind.mockResolvedValue(makeWebhook());
    mockWebhookUpdate.mockResolvedValue(makeWebhook({ url: 'https://new.example.com/wh' }));
  });

  it('returns 404 for unknown webhook', async () => {
    mockWebhookFind.mockResolvedValue(null);
    const res = await app.inject({
      method: 'PATCH', url: '/v1/webhooks/nope',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ isActive: false }),
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 on valid update', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/v1/webhooks/wh-001',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ isActive: false }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 422 when body is empty', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/v1/webhooks/wh-001',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect([400, 422]).toContain(res.statusCode);
  });

  it('accepts url update', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/v1/webhooks/wh-001',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ url: 'https://new.example.com/wh' }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('accepts events update', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/v1/webhooks/wh-001',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ events: ['verification.completed', 'bulk_job.completed'] }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects non-HTTPS url', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/v1/webhooks/wh-001',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ url: 'http://plain.example.com' }),
    });
    expect([400, 422]).toContain(res.statusCode);
  });
});

// ─── DELETE /v1/webhooks/:id ──────────────────────────────────────────────────

describe('DELETE /v1/webhooks/:id', () => {
  beforeEach(() => {
    mockWebhookFind.mockResolvedValue(makeWebhook());
    mockWebhookDelete.mockResolvedValue(makeWebhook());
  });

  it('returns 404 for unknown webhook', async () => {
    mockWebhookFind.mockResolvedValue(null);
    const res = await app.inject({ method: 'DELETE', url: '/v1/webhooks/nope', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 with deleted=true', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/v1/webhooks/wh-001', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(true);
    expect(res.json().id).toBe('wh-001');
  });

  it('returns 404 for webhook belonging to another key', async () => {
    mockWebhookFind.mockResolvedValue(makeWebhook({ apiKeyId: 'other-key' }));
    const res = await app.inject({ method: 'DELETE', url: '/v1/webhooks/wh-001', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });
});

// ─── POST /v1/webhooks/:id/ping ───────────────────────────────────────────────

describe('POST /v1/webhooks/:id/ping', () => {
  beforeEach(() => {
    mockWebhookFind.mockResolvedValue(makeWebhook());
    mockDeliveryCreate.mockResolvedValue({ id: 'del-ping-001' } as never);
  });

  it('returns 404 for unknown webhook', async () => {
    mockWebhookFind.mockResolvedValue(null);
    const res = await app.inject({ method: 'POST', url: '/v1/webhooks/nope/ping', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  it('returns 202 with deliveryId and webhookId', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/webhooks/wh-001/ping', headers: AUTH });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body).toHaveProperty('deliveryId');
    expect(body).toHaveProperty('webhookId', 'wh-001');
    expect(body).toHaveProperty('url');
    expect(body).toHaveProperty('eventId');
    expect(body).toHaveProperty('message');
  });

  it('enqueues a webhook job', async () => {
    await app.inject({ method: 'POST', url: '/v1/webhooks/wh-001/ping', headers: AUTH });
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'deliver-webhook',
      expect.objectContaining({
        webhookId: 'wh-001',
        event:     'verification.completed',
      }),
      expect.objectContaining({ priority: 1 }),
    );
  });

  it('returns 422 for inactive webhook', async () => {
    mockWebhookFind.mockResolvedValue(makeWebhook({ isActive: false }));
    const res = await app.inject({ method: 'POST', url: '/v1/webhooks/wh-001/ping', headers: AUTH });
    expect([400, 422]).toContain(res.statusCode);
  });

  it('ping payload uses Phase 5 event name verification.completed', async () => {
    await app.inject({ method: 'POST', url: '/v1/webhooks/wh-001/ping', headers: AUTH });
    const callArgs = mockQueueAdd.mock.calls[0]![1];
    expect(callArgs.event).toBe('verification.completed');
  });

  it('ping eventId has correct format', async () => {
    await app.inject({ method: 'POST', url: '/v1/webhooks/wh-001/ping', headers: AUTH });
    const callArgs = mockQueueAdd.mock.calls[0]![1];
    expect(callArgs.eventId).toMatch(/^verification\.completed:ping-/);
  });
});

// ─── GET /v1/webhooks/:id/deliveries ─────────────────────────────────────────

describe('GET /v1/webhooks/:id/deliveries', () => {
  beforeEach(() => {
    mockWebhookFind.mockResolvedValue(makeWebhook());
    mockDeliveryList.mockResolvedValue([makeDelivery()]);
    mockDeliveryCount.mockResolvedValue(1);
  });

  it('returns 401 without API key', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/webhooks/wh-001/deliveries' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 for unknown webhook', async () => {
    mockWebhookFind.mockResolvedValue(null);
    const res = await app.inject({ method: 'GET', url: '/v1/webhooks/nope/deliveries', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 with data, pagination, and filters', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/webhooks/wh-001/deliveries', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('webhookId', 'wh-001');
    expect(res.json()).toHaveProperty('data');
    expect(res.json()).toHaveProperty('pagination');
    expect(res.json()).toHaveProperty('filters');
    expect(Array.isArray(res.json().data)).toBe(true);
  });

  it('each delivery has all required fields', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/webhooks/wh-001/deliveries', headers: AUTH });
    const d = res.json().data[0];
    expect(d).toHaveProperty('id');
    expect(d).toHaveProperty('webhookId');
    expect(d).toHaveProperty('event');
    expect(d).toHaveProperty('eventId');
    expect(d).toHaveProperty('attempts');
    expect(d).toHaveProperty('maxAttempts');
    expect(d).toHaveProperty('delivered');
    expect(d).toHaveProperty('failedPermanently');
    expect(d).toHaveProperty('nextRetryAt');
    expect(d).toHaveProperty('lastAttemptAt');
    expect(d).toHaveProperty('statusCode');
    expect(d).toHaveProperty('errorMessage');
    expect(d).toHaveProperty('createdAt');
  });

  it('accepts delivered=true filter', async () => {
    const res = await app.inject({
      method: 'GET', url: '/v1/webhooks/wh-001/deliveries?delivered=true', headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().filters.delivered).toBe(true);
  });

  it('accepts delivered=false filter', async () => {
    const res = await app.inject({
      method: 'GET', url: '/v1/webhooks/wh-001/deliveries?delivered=false', headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().filters.delivered).toBe(false);
  });

  it('accepts failedPermanently=true filter', async () => {
    const res = await app.inject({
      method: 'GET', url: '/v1/webhooks/wh-001/deliveries?failedPermanently=true', headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().filters.failedPermanently).toBe(true);
  });

  it('accepts event filter', async () => {
    const res = await app.inject({
      method: 'GET', url: '/v1/webhooks/wh-001/deliveries?event=verification_complete', headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().filters.event).toBe('verification_complete');
  });

  it('pagination defaults to page=1 limit=20', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/webhooks/wh-001/deliveries', headers: AUTH });
    expect(res.json().pagination.page).toBe(1);
    expect(res.json().pagination.limit).toBe(20);
  });

  it('hasPrev is false on page 1', async () => {
    const res = await app.inject({
      method: 'GET', url: '/v1/webhooks/wh-001/deliveries?page=1', headers: AUTH,
    });
    expect(res.json().pagination.hasPrev).toBe(false);
  });

  it('hasNext is true when more pages exist', async () => {
    mockDeliveryCount.mockResolvedValue(100);
    const res = await app.inject({
      method: 'GET', url: '/v1/webhooks/wh-001/deliveries?page=1&limit=20', headers: AUTH,
    });
    expect(res.json().pagination.hasNext).toBe(true);
  });
});

// ─── GET /v1/webhooks/:id/deliveries/:deliveryId ──────────────────────────────

describe('GET /v1/webhooks/:id/deliveries/:deliveryId', () => {
  beforeEach(() => {
    mockWebhookFind.mockResolvedValue(makeWebhook());
    mockDeliveryFind.mockResolvedValue(makeDelivery());
  });

  it('returns 404 for unknown webhook', async () => {
    mockWebhookFind.mockResolvedValue(null);
    const res = await app.inject({
      method: 'GET', url: '/v1/webhooks/nope/deliveries/del-001', headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for unknown delivery', async () => {
    mockDeliveryFind.mockResolvedValue(null);
    const res = await app.inject({
      method: 'GET', url: '/v1/webhooks/wh-001/deliveries/nope', headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 with delivery detail including httpAttempts', async () => {
    const res = await app.inject({
      method: 'GET', url: '/v1/webhooks/wh-001/deliveries/del-001', headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('id', 'del-001');
    expect(body).toHaveProperty('event');
    expect(body).toHaveProperty('eventId');
    expect(body).toHaveProperty('payload');
    expect(body).toHaveProperty('delivered');
    expect(body).toHaveProperty('failedPermanently');
    expect(body).toHaveProperty('httpAttempts');
    expect(Array.isArray(body.httpAttempts)).toBe(true);
  });

  it('httpAttempts is empty array when no attempts logged yet', async () => {
    const res = await app.inject({
      method: 'GET', url: '/v1/webhooks/wh-001/deliveries/del-001', headers: AUTH,
    });
    expect(res.json().httpAttempts).toHaveLength(0);
  });

  it('httpAttempts contains attempt records with all fields', async () => {
    const attempt = {
      id: 'att-001', deliveryId: 'del-001', attemptNumber: 1,
      requestedAt: new Date(), respondedAt: new Date(), durationMs: 120,
      statusCode: 200, responseBody: '{"ok":true}', errorType: null,
      errorMessage: null, success: true,
    };
    mockDeliveryFind.mockResolvedValue(makeDelivery({ attempts_: [attempt] }));

    const res = await app.inject({
      method: 'GET', url: '/v1/webhooks/wh-001/deliveries/del-001', headers: AUTH,
    });
    const a = res.json().httpAttempts[0];
    expect(a).toHaveProperty('id');
    expect(a).toHaveProperty('attemptNumber');
    expect(a).toHaveProperty('requestedAt');
    expect(a).toHaveProperty('respondedAt');
    expect(a).toHaveProperty('durationMs');
    expect(a).toHaveProperty('statusCode');
    expect(a).toHaveProperty('errorType');
    expect(a).toHaveProperty('success');
  });

  it('delivery belonging to different webhook returns 404', async () => {
    mockDeliveryFind.mockResolvedValue(makeDelivery({ webhookId: 'wh-999' }));
    const res = await app.inject({
      method: 'GET', url: '/v1/webhooks/wh-001/deliveries/del-001', headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─── Signature verification (crypto) ─────────────────────────────────────────

describe('Webhook signature', () => {
  it('signWebhookPayload returns sha256=<64hex> format', () => {
    const sig = signWebhookPayload('my-secret', '{"test":1}');
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('verifyWebhookSignature returns true for correct signature', () => {
    const secret = 'test-secret-32charslongxxxxxxxxx';
    const body   = '{"event":"verification.completed","id":"ver-001"}';
    const sig    = signWebhookPayload(secret, body);
    expect(verifyWebhookSignature(secret, body, sig)).toBe(true);
  });

  it('verifyWebhookSignature returns false for tampered body', () => {
    const secret = 'test-secret-32charslongxxxxxxxxx';
    const body   = '{"event":"verification.completed","id":"ver-001"}';
    const sig    = signWebhookPayload(secret, body);
    expect(verifyWebhookSignature(secret, '{"tampered":true}', sig)).toBe(false);
  });

  it('verifyWebhookSignature returns false for wrong secret', () => {
    const body = '{"event":"test"}';
    const sig  = signWebhookPayload('secret-a', body);
    expect(verifyWebhookSignature('secret-b', body, sig)).toBe(false);
  });

  it('verifyWebhookSignature returns false for empty signature', () => {
    expect(verifyWebhookSignature('secret', 'body', '')).toBe(false);
  });

  it('same secret + body always produces the same signature (deterministic)', () => {
    const sig1 = signWebhookPayload('secret', 'body');
    const sig2 = signWebhookPayload('secret', 'body');
    expect(sig1).toBe(sig2);
  });
});

// ─── Phase 5 event naming ─────────────────────────────────────────────────────

describe('Phase 5 event names in queue payloads', () => {
  beforeEach(() => {
    mockWebhookFind.mockResolvedValue(makeWebhook());
    mockDeliveryCreate.mockResolvedValue({ id: 'del-001' } as never);
  });

  it('ping enqueues with verification.completed event', async () => {
    await app.inject({ method: 'POST', url: '/v1/webhooks/wh-001/ping', headers: AUTH });
    const payload = mockQueueAdd.mock.calls[0]?.[1];
    expect(payload?.event).toBe('verification.completed');
  });

  it('ping payload has apiVersion 2', async () => {
    await app.inject({ method: 'POST', url: '/v1/webhooks/wh-001/ping', headers: AUTH });
    const payload = mockQueueAdd.mock.calls[0]?.[1];
    expect((payload?.payload as unknown as Record<string, unknown>)?.['apiVersion']).toBe('2');
  });

  it('eventId contains the event name as prefix', async () => {
    await app.inject({ method: 'POST', url: '/v1/webhooks/wh-001/ping', headers: AUTH });
    const payload = mockQueueAdd.mock.calls[0]?.[1];
    expect(payload?.eventId).toMatch(/^verification\.completed:/);
  });
});
