import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    apiKey: { findUnique: vi.fn() },
    sendMessage: { count: vi.fn() },
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

vi.mock('../../engine/disposable.js', () => ({
  loadDisposableList: vi.fn(),
  isDisposableDomain: vi.fn().mockReturnValue(false),
  getBlocklistStats:  vi.fn().mockReturnValue({ exact: 0, wildcard: 0 }),
}));

vi.mock('../../engine/smtp.js', () => ({
  smtpProbe: vi.fn().mockResolvedValue({
    checked: false, reachable: null, isCatchAll: null, greylisted: false, rawResponse: null, error: 'disabled',
  }),
}));

import { buildApp } from '../../server.js';
import { prisma } from '../../lib/prisma.js';

const mockFindKey = vi.mocked(prisma.apiKey.findUnique);
const mockCount    = vi.mocked(prisma.sendMessage.count);

const TEST_API_KEY = 'cnt_testkey0123456789abcdefghijklmnopqrstu';
const TEST_KEY_RECORD = {
  id: 'key-test-001', keyHash: '', keyPrefix: 'cnt_testkey',
  label: 'test', ownerId: null, userId: null, orgId: null, keyRaw: null, rateLimit: 1000,
  monthlyLimit: 100000, currentMonthUsage: 0, usageResetAt: new Date(), plan: 'free',
  isActive: true, createdAt: new Date(), revokedAt: null,
  name: null, monthlySendLimit: 500, currentMonthSendUsage: 0, sendUsageResetAt: new Date(),
  permission: 'full_access', restrictedDomainId: null, lastUsedAt: null,
};

let app: FastifyInstance;

beforeAll(async () => {
  mockFindKey.mockResolvedValue(TEST_KEY_RECORD as never);
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  mockCount.mockReset();
});

function get() {
  return app.inject({
    method: 'GET',
    url: '/v1/analytics/verification-accuracy',
    headers: { authorization: `Bearer ${TEST_API_KEY}` },
  });
}

describe('GET /v1/analytics/verification-accuracy', () => {
  it('returns null accuracy below the minimum sample size, not a misleadingly precise number', async () => {
    // Every count call (total/bounced/complained, x3 buckets) returns a tiny number
    mockCount.mockResolvedValue(3);

    const res = await get();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.measured_accuracy_pct).toBeNull();
    const validBucket = body.buckets.find((b: { verified_status: string }) => b.verified_status === 'valid');
    expect(validBucket.sample_size_ok).toBe(false);
    expect(validBucket.bounce_rate).toBeNull();
  });

  it('computes a real bounce rate once the sample size is large enough', async () => {
    // total=100, bounced=2, complained=1 for every bucket (mock can't easily
    // differentiate call args here, so this exercises the arithmetic path)
    let call = 0;
    mockCount.mockImplementation((() => {
      const seq = [100, 2, 1]; // total, bounced, complained per bucket
      return Promise.resolve(seq[call++ % 3]!);
    }) as typeof mockCount);

    const res = await get();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const validBucket = body.buckets.find((b: { verified_status: string }) => b.verified_status === 'valid');
    expect(validBucket.sample_size_ok).toBe(true);
    expect(validBucket.total_sent).toBe(100);
    expect(validBucket.bounced).toBe(2);
    expect(validBucket.bounce_rate).toBe(2);
    expect(body.measured_accuracy_pct).toBe(98);
  });

  it('returns 401 without an API key', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/analytics/verification-accuracy' });
    expect(res.statusCode).toBe(401);
  });

  it('includes all three verified-status buckets', async () => {
    mockCount.mockResolvedValue(0);
    const res = await get();
    const statuses = res.json().buckets.map((b: { verified_status: string }) => b.verified_status);
    expect(statuses.sort()).toEqual(['risky', 'unknown', 'valid']);
  });
});
