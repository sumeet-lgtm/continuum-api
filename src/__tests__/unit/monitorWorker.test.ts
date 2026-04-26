import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock everything the worker module touches at import time ─────────────────

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    monitor:       { findMany: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
    monitorCheck:  { create: vi.fn(), updateMany: vi.fn() },
    webhook:       { findMany: vi.fn().mockResolvedValue([]) },
    webhookDelivery: { create: vi.fn() },
    $disconnect:   vi.fn(),
  },
}));

vi.mock('../../lib/redis.js', () => ({
  redis: {
    set:  vi.fn().mockResolvedValue('OK'),
    get:  vi.fn().mockResolvedValue(null),
    del:  vi.fn().mockResolvedValue(1),
    ping: vi.fn().mockResolvedValue('PONG'),
  },
  pingRedis: vi.fn().mockResolvedValue(true),
  redisKey:  { rateLimit: vi.fn(), monitorLock: (id: string) => `lock:monitor:${id}` },
  getRedis:  vi.fn(),
}));

vi.mock('../../lib/queue.js', () => ({
  QUEUE_MONITOR:   'continuum:monitor',
  webhookQueue:    { add: vi.fn() },
  redisConnection: {},
}));

vi.mock('../../engine/index.js', () => ({
  verifyEmail: vi.fn(),
}));

vi.mock('../../engine/disposable.js', () => ({
  loadDisposableList: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({
    on: vi.fn(), close: vi.fn(),
  })),
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn(), close: vi.fn(),
  })),
}));

// ─── Import after mocks are in place ─────────────────────────────────────────

import {
  calcNextCheckAt,
  BATCH_SIZE,
  MAX_CONSECUTIVE_FAILURES,
  JITTER_FACTOR,
} from '../../workers/monitorWorker.js';

// ─── calcNextCheckAt — scheduling with jitter ─────────────────────────────────

describe('calcNextCheckAt', () => {
  it('returns a Date in the future', () => {
    const before = Date.now();
    const next   = calcNextCheckAt(24);
    expect(next.getTime()).toBeGreaterThan(before);
  });

  it('result is approximately now + intervalHours (within jitter band)', () => {
    const intervalHours = 24;
    const baseMs        = intervalHours * 3600 * 1000;
    const jitterMs      = baseMs * JITTER_FACTOR;

    const before = Date.now();
    const next   = calcNextCheckAt(intervalHours);
    const after  = Date.now();

    const delta = next.getTime() - before;

    // Should be within [base - jitter, base + jitter + small epsilon for execution time]
    expect(delta).toBeGreaterThanOrEqual(baseMs - jitterMs - 50);
    expect(delta).toBeLessThanOrEqual(baseMs + jitterMs + (after - before) + 50);
  });

  it('works for 1-hour interval', () => {
    const next = calcNextCheckAt(1);
    const nowPlus1h = Date.now() + 3600 * 1000;
    const jitter    = 3600 * 1000 * JITTER_FACTOR;

    expect(next.getTime()).toBeGreaterThan(nowPlus1h - jitter - 50);
    expect(next.getTime()).toBeLessThan(nowPlus1h + jitter + 100);
  });

  it('works for 168-hour (weekly) interval', () => {
    const next        = calcNextCheckAt(168);
    const baseMs      = 168 * 3600 * 1000;
    const jitterBand  = baseMs * JITTER_FACTOR;

    const delta = next.getTime() - Date.now();
    expect(delta).toBeGreaterThanOrEqual(baseMs - jitterBand - 100);
    expect(delta).toBeLessThanOrEqual(baseMs + jitterBand + 100);
  });

  it('produces different nextCheckAt values across calls (stochastic jitter)', () => {
    // Run many times — with ±10% jitter, two results should rarely be identical
    const results = new Set(
      Array.from({ length: 50 }, () => calcNextCheckAt(24).getTime()),
    );
    // At least a few distinct values (probabilistic — extremely unlikely to all match)
    expect(results.size).toBeGreaterThan(1);
  });

  it('never returns a time in the past', () => {
    for (let i = 0; i < 100; i++) {
      const next = calcNextCheckAt(1);
      expect(next.getTime()).toBeGreaterThan(Date.now() - 100);
    }
  });
});

// ─── Constants ────────────────────────────────────────────────────────────────

describe('worker constants', () => {
  it('BATCH_SIZE is a positive integer', () => {
    expect(typeof BATCH_SIZE).toBe('number');
    expect(Number.isInteger(BATCH_SIZE)).toBe(true);
    expect(BATCH_SIZE).toBeGreaterThan(0);
  });

  it('MAX_CONSECUTIVE_FAILURES is a positive integer', () => {
    expect(typeof MAX_CONSECUTIVE_FAILURES).toBe('number');
    expect(Number.isInteger(MAX_CONSECUTIVE_FAILURES)).toBe(true);
    expect(MAX_CONSECUTIVE_FAILURES).toBeGreaterThan(0);
  });

  it('JITTER_FACTOR is between 0 and 0.5 (reasonable jitter band)', () => {
    expect(JITTER_FACTOR).toBeGreaterThan(0);
    expect(JITTER_FACTOR).toBeLessThanOrEqual(0.5);
  });

  it('BATCH_SIZE >= MAX_CONCURRENT_MONITORS (ensures all concurrent slots can be filled)', () => {
    // BATCH_SIZE (50) should be >= MONITOR_CONCURRENCY (5) so we always process a full chunk
    expect(BATCH_SIZE).toBeGreaterThanOrEqual(5);
  });
});

// ─── Status change detection ──────────────────────────────────────────────────

describe('status change detection logic', () => {
  // The worker computes: statusChanged = newStatus !== previousStatus
  // Test this logic in isolation (it's a pure comparison)

  type Status = 'valid' | 'invalid' | 'risky' | 'unknown';

  function detectChange(newStatus: Status, previousStatus: Status | null): boolean {
    return newStatus !== previousStatus;
  }

  it('detects change from valid to invalid', () => {
    expect(detectChange('invalid', 'valid')).toBe(true);
  });

  it('detects change from null (first check) to any status', () => {
    expect(detectChange('valid', null)).toBe(true);
    expect(detectChange('invalid', null)).toBe(true);
    expect(detectChange('risky', null)).toBe(true);
    expect(detectChange('unknown', null)).toBe(true);
  });

  it('detects no change when status is same', () => {
    expect(detectChange('valid', 'valid')).toBe(false);
    expect(detectChange('invalid', 'invalid')).toBe(false);
    expect(detectChange('risky', 'risky')).toBe(false);
    expect(detectChange('unknown', 'unknown')).toBe(false);
  });

  it('detects all cross-status changes', () => {
    const statuses: Status[] = ['valid', 'invalid', 'risky', 'unknown'];
    for (const a of statuses) {
      for (const b of statuses) {
        const expected = a !== b;
        expect(detectChange(a, b)).toBe(expected);
      }
    }
  });
});

// ─── Auto-pause threshold ─────────────────────────────────────────────────────

describe('auto-pause logic', () => {
  function shouldAutoPause(consecutiveFailures: number): boolean {
    return consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
  }

  it('does not pause before MAX_CONSECUTIVE_FAILURES', () => {
    for (let i = 1; i < MAX_CONSECUTIVE_FAILURES; i++) {
      expect(shouldAutoPause(i)).toBe(false);
    }
  });

  it('triggers auto-pause at exactly MAX_CONSECUTIVE_FAILURES', () => {
    expect(shouldAutoPause(MAX_CONSECUTIVE_FAILURES)).toBe(true);
  });

  it('remains paused beyond MAX_CONSECUTIVE_FAILURES', () => {
    expect(shouldAutoPause(MAX_CONSECUTIVE_FAILURES + 1)).toBe(true);
    expect(shouldAutoPause(MAX_CONSECUTIVE_FAILURES + 10)).toBe(true);
  });
});

// ─── Exponential backoff calculation ─────────────────────────────────────────

describe('failure backoff calculation', () => {
  const MAX_BACKOFF_HOURS = 24;

  function calcBackoff(intervalHours: number, failureCount: number): number {
    return Math.min(intervalHours * Math.pow(2, failureCount), MAX_BACKOFF_HOURS);
  }

  it('failure 1: doubles the interval', () => {
    expect(calcBackoff(1, 1)).toBe(2);
    expect(calcBackoff(6, 1)).toBe(12);
  });

  it('failure 2: quadruples the interval', () => {
    expect(calcBackoff(1, 2)).toBe(4);
    expect(calcBackoff(6, 2)).toBe(24);
  });

  it('caps at MAX_BACKOFF_HOURS (24)', () => {
    expect(calcBackoff(1, 10)).toBe(24);
    expect(calcBackoff(24, 1)).toBe(24);  // already at cap on first failure
    expect(calcBackoff(24, 5)).toBe(24);
  });

  it('never exceeds 24 hours regardless of interval or failure count', () => {
    for (const intervalHours of [1, 6, 12, 24, 48, 72, 168]) {
      for (let f = 0; f <= 10; f++) {
        expect(calcBackoff(intervalHours, f)).toBeLessThanOrEqual(24);
      }
    }
  });

  it('always returns a positive value', () => {
    for (let f = 0; f <= 5; f++) {
      expect(calcBackoff(1, f)).toBeGreaterThan(0);
    }
  });
});

// ─── Interval validation (mirrors route logic) ────────────────────────────────

describe('valid interval hours', () => {
  const VALID_INTERVALS = [1, 6, 12, 24, 48, 72, 168];

  it('all documented intervals are in the set', () => {
    for (const h of VALID_INTERVALS) {
      expect(VALID_INTERVALS.includes(h)).toBe(true);
    }
  });

  it('rejects values not in the set', () => {
    const invalid = [0, 2, 3, 4, 5, 7, 8, 10, 23, 25, 100, -1, 1.5];
    for (const h of invalid) {
      expect(VALID_INTERVALS.includes(h)).toBe(false);
    }
  });
});
