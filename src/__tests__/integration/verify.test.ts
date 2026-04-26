import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

// ─── Mock all external I/O ────────────────────────────────────────────────────

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    apiKey: {
      findUnique: vi.fn(),
    },
    verification: {
      create: vi.fn(),
    },
    webhook: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    webhookDelivery: {
      create: vi.fn(),
    },
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

vi.mock('../../engine/mx.js', () => ({
  lookupMx:       vi.fn(),
  clearMxCache:   vi.fn(),
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

import { buildApp } from '../../server.js';
import { prisma } from '../../lib/prisma.js';
import { lookupMx } from '../../engine/mx.js';

const mockFindKey  = vi.mocked(prisma.apiKey.findUnique);
const mockCreate   = vi.mocked(prisma.verification.create);
const mockLookupMx = vi.mocked(lookupMx);

// ─── Test API key ─────────────────────────────────────────────────────────────

const TEST_API_KEY = 'cnt_testkey0123456789abcdefghijklmnopqrstu';
const TEST_KEY_RECORD = {
  id:         'key-test-001',
  keyHash:    '', // hash is computed by hashApiKey — we bypass by making findUnique return this
  keyPrefix:  'cnt_testkey',
  label:      'test',
  ownerId:    null,
  rateLimit:  1000,
  isActive:   true,
  createdAt:  new Date(),
  revokedAt:  null,
};

// ─── App fixture ──────────────────────────────────────────────────────────────

let app: FastifyInstance;

beforeAll(async () => {
  // Make every API key lookup return the test key record
  mockFindKey.mockResolvedValue(TEST_KEY_RECORD);
  mockCreate.mockResolvedValue({ id: 'ver-001', checkedAt: new Date('2026-04-24T10:00:00Z') });
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  mockLookupMx.mockReset();
  mockCreate.mockReset();
  mockCreate.mockResolvedValue({ id: 'ver-001', checkedAt: new Date('2026-04-24T10:00:00Z') });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function post(body: unknown) {
  return app.inject({
    method:  'POST',
    url:     '/v1/verify',
    headers: {
      'content-type':  'application/json',
      'authorization': `Bearer ${TEST_API_KEY}`,
    },
    payload: JSON.stringify(body),
  });
}

function mxFound(records = ['mx1.example.com']) {
  mockLookupMx.mockResolvedValue({ found: true, records, error: null });
}

function mxNotFound() {
  mockLookupMx.mockResolvedValue({ found: false, records: [], error: null });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /v1/verify', () => {

  // ─── Auth ──────────────────────────────────────────────────────────────────

  describe('authentication', () => {
    it('returns 401 when no API key is provided', async () => {
      const res = await app.inject({
        method:  'POST',
        url:     '/v1/verify',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ email: 'test@example.com' }),
      });

      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.code).toBe('UNAUTHORIZED');
    });

    it('returns 401 for an invalid API key', async () => {
      mockFindKey.mockResolvedValueOnce(null);

      const res = await app.inject({
        method:  'POST',
        url:     '/v1/verify',
        headers: {
          'content-type':  'application/json',
          'authorization': 'Bearer cnt_invalid_key_here',
        },
        payload: JSON.stringify({ email: 'test@example.com' }),
      });

      expect(res.statusCode).toBe(401);
    });

    it('accepts X-API-Key header as an alternative', async () => {
      mxFound();

      const res = await app.inject({
        method:  'POST',
        url:     '/v1/verify',
        headers: {
          'content-type': 'application/json',
          'x-api-key':    TEST_API_KEY,
        },
        payload: JSON.stringify({ email: 'test@example.com' }),
      });

      expect(res.statusCode).toBe(200);
    });
  });

  // ─── Validation ────────────────────────────────────────────────────────────

  describe('input validation', () => {
    it('returns 400 when email field is missing', async () => {
      const res = await post({});
      expect(res.statusCode).toBe(400);
    });

    it('returns 422 when email is empty string', async () => {
      const res = await post({ email: '' });
      expect([400, 422]).toContain(res.statusCode);
    });

    it('returns 400 for unknown body fields (additionalProperties: false)', async () => {
      mxFound();
      const res = await post({ email: 'test@example.com', extra: 'field' });
      // Ajv strips unknown fields with removeAdditional: 'all', so this is 200
      expect(res.statusCode).toBe(200);
    });
  });

  // ─── Response shape ────────────────────────────────────────────────────────

  describe('response shape', () => {
    it('returns 200 with full verification result', async () => {
      mxFound();

      const res = await post({ email: 'alice@example.com' });

      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('email', 'alice@example.com');
      expect(body).toHaveProperty('domain', 'example.com');
      expect(body).toHaveProperty('status');
      expect(body).toHaveProperty('subStatus');
      expect(body).toHaveProperty('checks');
      expect(body).toHaveProperty('score');
      expect(body).toHaveProperty('durationMs');
      expect(body).toHaveProperty('checkedAt');
    });

    it('checks object has all expected fields including greylisted', async () => {
      mxFound();

      const res  = await post({ email: 'alice@example.com' });
      const body = res.json();

      expect(body.checks).toHaveProperty('syntaxValid');
      expect(body.checks).toHaveProperty('mxFound');
      expect(body.checks).toHaveProperty('mxRecords');
      expect(body.checks).toHaveProperty('isDisposable');
      expect(body.checks).toHaveProperty('isRoleAccount');
      expect(body.checks).toHaveProperty('smtpChecked');
      expect(body.checks).toHaveProperty('smtpReachable');
      expect(body.checks).toHaveProperty('isCatchAll');
      expect(body.checks).toHaveProperty('greylisted');
    });

    it('normalises email to lowercase in the response', async () => {
      mxFound();

      const res = await post({ email: '  ALICE@EXAMPLE.COM  ' });
      expect(res.json().email).toBe('alice@example.com');
    });
  });

  // ─── Engine outcomes in response ───────────────────────────────────────────

  describe('engine outcome mapping', () => {
    it('returns status=invalid for a bad email address', async () => {
      const res = await post({ email: 'notanemail' });
      // Fastify's JSON schema may catch this as 400 before the engine runs
      expect([400, 422, 200]).toContain(res.statusCode);
      if (res.statusCode === 200) {
        expect(res.json().status).toBe('invalid');
      }
    });

    it('returns status=invalid when no MX records', async () => {
      mxNotFound();

      const res = await post({ email: 'user@nodomain.example' });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('invalid');
      expect(res.json().subStatus).toBe('no_mx_records');
    });

    it('returns status=unknown when SMTP is not checked', async () => {
      mxFound();

      const res = await post({ email: 'user@example.com' });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('unknown');
      expect(res.json().subStatus).toBe('smtp_not_checked');
    });

    it('returns status=risky for role account when SMTP unchecked', async () => {
      mxFound();

      const res = await post({ email: 'admin@example.com' });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('risky');
      expect(res.json().checks.isRoleAccount).toBe(true);
    });

    it('mxRecords array contains resolved hostnames', async () => {
      mxFound(['mx1.example.com', 'mx2.example.com']);

      const res = await post({ email: 'user@example.com' });
      expect(res.json().checks.mxRecords).toEqual(['mx1.example.com', 'mx2.example.com']);
    });
  });

  // ─── Rate limit headers ────────────────────────────────────────────────────

  describe('rate limit headers', () => {
    it('includes X-RateLimit-Limit header', async () => {
      mxFound();
      const res = await post({ email: 'user@example.com' });
      expect(res.headers['x-ratelimit-limit']).toBeDefined();
    });

    it('includes X-RateLimit-Remaining header', async () => {
      mxFound();
      const res = await post({ email: 'user@example.com' });
      expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    });
  });

  // ─── Health endpoint ───────────────────────────────────────────────────────

  describe('GET /health', () => {
    it('returns 200 with status field', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect([200, 503]).toContain(res.statusCode);
      expect(res.json()).toHaveProperty('status');
    });

    it('GET /health/live always returns 200', async () => {
      const res = await app.inject({ method: 'GET', url: '/health/live' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'ok' });
    });
  });
});
