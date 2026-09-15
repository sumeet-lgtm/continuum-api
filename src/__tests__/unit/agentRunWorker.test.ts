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
  agentRunQueue: { add: vi.fn(), close: vi.fn() },
}));

vi.mock('../../engine/index.js', () => ({
  verifyEmail: vi.fn(),
}));

vi.mock('../../lib/campaignSegments.js', () => ({
  deriveListSegments: vi.fn(),
}));

vi.mock('../../lib/emailGenerator.js', () => ({
  generateSegmentEmail: vi.fn(),
}));

vi.mock('../../lib/nurtureAgent.js', () => ({
  createAndSendCampaignFromDraft: vi.fn(),
}));

vi.mock('../../lib/finderSearch.js', () => ({
  buildFinderActorInput: vi.fn(),
  startFinderRun: vi.fn(),
  pollFinderRun: vi.fn(),
  fetchFinderDatasetRows: vi.fn(),
  mapLeadRow: vi.fn(),
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
import { parseVerificationAgentConfig, DEFAULT_VERIFICATION_CUTOFF_DAYS, parseNurtureAgentConfig, parseLeadFindingAgentConfig, parseWarmupAgentConfig } from '../../types/agentRun.js';

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

// ─── Nurture agent config parsing ─────────────────────────────────────────────

describe('parseNurtureAgentConfig', () => {
  const minimal = { listId: 'list_1', about: 'a security tool for CISOs', fromName: 'Ada', fromEmail: 'ada@acme.com' };

  it('accepts a minimal valid config', () => {
    expect(parseNurtureAgentConfig(minimal)).toEqual(minimal);
  });

  it('defaults to no autoSend field when omitted (caller treats missing as false)', () => {
    const cfg = parseNurtureAgentConfig(minimal);
    expect(cfg?.autoSend).toBeUndefined();
  });

  it('carries through optional sender, tone, replyTo, autoSend', () => {
    const cfg = parseNurtureAgentConfig({
      ...minimal,
      sender: { name: 'Ada', company: 'Acme' },
      tone: 'technical',
      replyTo: 'support@acme.com',
      autoSend: true,
    });
    expect(cfg).toEqual({
      ...minimal,
      sender: { name: 'Ada', company: 'Acme' },
      tone: 'technical',
      replyTo: 'support@acme.com',
      autoSend: true,
    });
  });

  it('carries through a previously-written draft and campaignId (worker re-kick idempotency)', () => {
    const draft = { subject: 'Hi', htmlBody: '<p>hi</p>', textBody: 'hi', segmentLabel: 'All contacts', matchCount: 42 };
    const cfg = parseNurtureAgentConfig({ ...minimal, draft, campaignId: 'camp_1' });
    expect(cfg?.draft).toEqual(draft);
    expect(cfg?.campaignId).toBe('camp_1');
  });

  it('rejects missing required fields', () => {
    expect(parseNurtureAgentConfig({})).toBeNull();
    expect(parseNurtureAgentConfig({ listId: 'list_1' })).toBeNull();
    expect(parseNurtureAgentConfig({ listId: 'list_1', about: 'x' })).toBeNull();
    expect(parseNurtureAgentConfig({ listId: 'list_1', about: 'x', fromName: 'Ada' })).toBeNull();
    expect(parseNurtureAgentConfig({ ...minimal, about: '' })).toBeNull();
    expect(parseNurtureAgentConfig({ ...minimal, fromEmail: '' })).toBeNull();
  });

  it('rejects non-object input', () => {
    expect(parseNurtureAgentConfig(null)).toBeNull();
    expect(parseNurtureAgentConfig(undefined)).toBeNull();
    expect(parseNurtureAgentConfig('list_1')).toBeNull();
  });
});

// ─── Lead Finding agent config parsing ────────────────────────────────────────

describe('parseLeadFindingAgentConfig', () => {
  const minimal = { searchFilters: { personTitleIncludes: ['CISO'], totalResults: 100 } };

  it('accepts a minimal valid config', () => {
    expect(parseLeadFindingAgentConfig(minimal)).toEqual(minimal);
  });

  it('carries through sequenceId when present', () => {
    const cfg = parseLeadFindingAgentConfig({ ...minimal, sequenceId: 'seq_1' });
    expect(cfg).toEqual({ ...minimal, sequenceId: 'seq_1' });
  });

  it('carries through a pendingRunId set by the worker (mid-search-cycle state)', () => {
    const cfg = parseLeadFindingAgentConfig({ ...minimal, pendingRunId: 'apify_run_123' });
    expect(cfg?.pendingRunId).toBe('apify_run_123');
  });

  it('rejects a missing or non-object searchFilters', () => {
    expect(parseLeadFindingAgentConfig({})).toBeNull();
    expect(parseLeadFindingAgentConfig({ searchFilters: 'not an object' })).toBeNull();
    expect(parseLeadFindingAgentConfig({ searchFilters: null })).toBeNull();
  });

  it('rejects non-object input', () => {
    expect(parseLeadFindingAgentConfig(null)).toBeNull();
    expect(parseLeadFindingAgentConfig(undefined)).toBeNull();
    expect(parseLeadFindingAgentConfig('list_1')).toBeNull();
  });

  it('ignores an empty-string sequenceId/pendingRunId rather than accepting it', () => {
    const cfg = parseLeadFindingAgentConfig({ ...minimal, sequenceId: '', pendingRunId: '' });
    expect(cfg).toEqual(minimal);
  });
});

// ─── Warmup agent config parsing ───────────────────────────────────────────────

describe('parseWarmupAgentConfig', () => {
  const minimal = { mailboxId: 'mbx_1', baselineDailyRampUp: 2 };

  it('accepts a minimal valid config', () => {
    expect(parseWarmupAgentConfig(minimal)).toEqual(minimal);
  });

  it('accepts a baselineDailyRampUp of 0 (a mailbox already at target)', () => {
    expect(parseWarmupAgentConfig({ mailboxId: 'mbx_1', baselineDailyRampUp: 0 })).toEqual({ mailboxId: 'mbx_1', baselineDailyRampUp: 0 });
  });

  it('rejects a missing mailboxId', () => {
    expect(parseWarmupAgentConfig({ baselineDailyRampUp: 2 })).toBeNull();
    expect(parseWarmupAgentConfig({ mailboxId: '', baselineDailyRampUp: 2 })).toBeNull();
  });

  it('rejects a missing or negative baselineDailyRampUp', () => {
    expect(parseWarmupAgentConfig({ mailboxId: 'mbx_1' })).toBeNull();
    expect(parseWarmupAgentConfig({ mailboxId: 'mbx_1', baselineDailyRampUp: -1 })).toBeNull();
  });

  it('rejects non-object input', () => {
    expect(parseWarmupAgentConfig(null)).toBeNull();
    expect(parseWarmupAgentConfig(undefined)).toBeNull();
    expect(parseWarmupAgentConfig('mbx_1')).toBeNull();
  });
});
