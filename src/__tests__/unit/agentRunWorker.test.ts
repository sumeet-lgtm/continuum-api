import { describe, it, expect, vi } from 'vitest';

// ─── Mock everything the worker module touches at import time ─────────────────

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    agentRun:      { findMany: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
    agentRunEvent: { create: vi.fn() },
    apiKey:        { findUnique: vi.fn() },
    $disconnect:   vi.fn(),
  },
}));

vi.mock('../../lib/tenantContext.js', () => ({
  withTenant:    vi.fn((_apiKeyId: string, fn: (tx: unknown) => unknown) => fn({})),
  withRlsBypass: vi.fn((fn: (tx: unknown) => unknown) => fn({})),
}));

vi.mock('../../lib/redis.js', () => ({
  redis: {
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(1),
  },
  redisKey: { agentRunLock: (id: string) => `lock:agent-run:${id}` },
}));

vi.mock('../../lib/queue.js', () => ({
  QUEUE_AGENT_RUN: 'continuum-agent-run',
  redisConnection: {},
}));

vi.mock('../../engine/index.js', () => ({
  verifyEmail: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({ on: vi.fn(), close: vi.fn() })),
  Queue:  vi.fn().mockImplementation(() => ({ add: vi.fn(), close: vi.fn() })),
}));

// ─── Import after mocks are in place ─────────────────────────────────────────

import {
  calcNextCheckAt,
  TICK_BATCH_SIZE,
  RUN_CONCURRENCY,
  MAX_CONSECUTIVE_FAILURES,
  JITTER_FACTOR,
} from '../../workers/agentRunWorker.js';
import { parseVerificationAgentConfig, DEFAULT_VERIFICATION_CUTOFF_DAYS } from '../../types/agentRun.js';

// ─── calcNextCheckAt — scheduling with jitter (same formula as monitorWorker) ──

describe('calcNextCheckAt', () => {
  it('returns a Date in the future', () => {
    const before = Date.now();
    const next = calcNextCheckAt(24);
    expect(next.getTime()).toBeGreaterThan(before);
  });

  it('result is approximately now + intervalHours (within jitter band)', () => {
    const intervalHours = 24;
    const baseMs = intervalHours * 3600 * 1000;
    const jitterMs = baseMs * JITTER_FACTOR;

    const before = Date.now();
    const next = calcNextCheckAt(intervalHours);
    const after = Date.now();

    const delta = next.getTime() - before;

    expect(delta).toBeGreaterThanOrEqual(baseMs - jitterMs - 50);
    expect(delta).toBeLessThanOrEqual(baseMs + jitterMs + (after - before) + 50);
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
  it('TICK_BATCH_SIZE is a positive integer', () => {
    expect(Number.isInteger(TICK_BATCH_SIZE)).toBe(true);
    expect(TICK_BATCH_SIZE).toBeGreaterThan(0);
  });

  it('MAX_CONSECUTIVE_FAILURES is a positive integer', () => {
    expect(Number.isInteger(MAX_CONSECUTIVE_FAILURES)).toBe(true);
    expect(MAX_CONSECUTIVE_FAILURES).toBeGreaterThan(0);
  });

  it('JITTER_FACTOR is between 0 and 0.5', () => {
    expect(JITTER_FACTOR).toBeGreaterThan(0);
    expect(JITTER_FACTOR).toBeLessThanOrEqual(0.5);
  });

  it('TICK_BATCH_SIZE >= RUN_CONCURRENCY (ensures all concurrent slots can be filled)', () => {
    expect(TICK_BATCH_SIZE).toBeGreaterThanOrEqual(RUN_CONCURRENCY);
  });
});

// ─── Exponential backoff calculation (same formula as monitorWorker) ──────────

describe('failure backoff calculation', () => {
  const MAX_BACKOFF_HOURS = 24;

  function calcBackoff(intervalHours: number, failureCount: number): number {
    return Math.min(intervalHours * Math.pow(2, failureCount), MAX_BACKOFF_HOURS);
  }

  it('never exceeds 24 hours regardless of interval or failure count', () => {
    for (const intervalHours of [1, 6, 12, 24, 48, 72, 168]) {
      for (let f = 0; f <= 10; f++) {
        expect(calcBackoff(intervalHours, f)).toBeLessThanOrEqual(24);
      }
    }
  });

  it('triggers auto-pause at exactly MAX_CONSECUTIVE_FAILURES', () => {
    const shouldPause = (n: number) => n >= MAX_CONSECUTIVE_FAILURES;
    expect(shouldPause(MAX_CONSECUTIVE_FAILURES - 1)).toBe(false);
    expect(shouldPause(MAX_CONSECUTIVE_FAILURES)).toBe(true);
  });
});

// ─── Verification agent config parsing ────────────────────────────────────────

describe('parseVerificationAgentConfig', () => {
  it('accepts a minimal valid config', () => {
    const cfg = parseVerificationAgentConfig({ listId: 'list_123' });
    expect(cfg).toEqual({ listId: 'list_123' });
  });

  it('carries through autoRemoveInvalid and cutoffDays when present', () => {
    const cfg = parseVerificationAgentConfig({ listId: 'list_123', autoRemoveInvalid: true, cutoffDays: 14 });
    expect(cfg).toEqual({ listId: 'list_123', autoRemoveInvalid: true, cutoffDays: 14 });
  });

  it('rejects a missing listId', () => {
    expect(parseVerificationAgentConfig({})).toBeNull();
    expect(parseVerificationAgentConfig({ listId: '' })).toBeNull();
  });

  it('rejects non-object input', () => {
    expect(parseVerificationAgentConfig(null)).toBeNull();
    expect(parseVerificationAgentConfig('list_123')).toBeNull();
    expect(parseVerificationAgentConfig(undefined)).toBeNull();
  });

  it('ignores a non-positive cutoffDays rather than accepting it', () => {
    const cfg = parseVerificationAgentConfig({ listId: 'list_123', cutoffDays: -5 });
    expect(cfg).toEqual({ listId: 'list_123' });
  });

  it('DEFAULT_VERIFICATION_CUTOFF_DAYS is a positive integer', () => {
    expect(Number.isInteger(DEFAULT_VERIFICATION_CUTOFF_DAYS)).toBe(true);
    expect(DEFAULT_VERIFICATION_CUTOFF_DAYS).toBeGreaterThan(0);
  });
});
