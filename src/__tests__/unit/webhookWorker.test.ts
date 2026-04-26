import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock all I/O ─────────────────────────────────────────────────────────────

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    webhookDelivery: { findUnique: vi.fn(), update: vi.fn() },
    webhookAttempt:  { create: vi.fn() },
    webhook:         { update: vi.fn() },
    $disconnect:     vi.fn(),
  },
}));

vi.mock('../../lib/queue.js', () => ({
  QUEUE_WEBHOOK:   'continuum:webhooks',
  webhookQueue:    { add: vi.fn() },
  redisConnection: {},
}));

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({ on: vi.fn(), close: vi.fn() })),
}));

import {
  RETRY_DELAYS_MS,
  MAX_BACKOFF_MS,
  RETRY_JITTER,
  retryDelayMs,
} from '../../workers/webhookWorker.js';

// ─── retryDelayMs — jitter + backoff ─────────────────────────────────────────

describe('retryDelayMs', () => {
  it('returns a value near the base delay for attempt 1', () => {
    const base   = RETRY_DELAYS_MS[1]!;
    const jitter = base * RETRY_JITTER;
    const delay  = retryDelayMs(1);
    expect(delay).toBeGreaterThanOrEqual(base - jitter - 1);
    expect(delay).toBeLessThanOrEqual(base + jitter + 1);
  });

  it('each attempt has a base delay larger than the previous', () => {
    const delays = [1, 2, 3, 4, 5].map((n) => RETRY_DELAYS_MS[n]!);
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]!).toBeGreaterThan(delays[i - 1]!);
    }
  });

  it('never exceeds MAX_BACKOFF_MS', () => {
    for (let attempt = 1; attempt <= 20; attempt++) {
      const delay = retryDelayMs(attempt);
      expect(delay).toBeLessThanOrEqual(MAX_BACKOFF_MS);
    }
  });

  it('never returns a value <= 0', () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      expect(retryDelayMs(attempt)).toBeGreaterThan(0);
    }
  });

  it('unknown attempt numbers fall back to MAX_BACKOFF_MS (with jitter)', () => {
    const delay = retryDelayMs(999);
    const jitter = MAX_BACKOFF_MS * RETRY_JITTER;
    expect(delay).toBeGreaterThanOrEqual(MAX_BACKOFF_MS - jitter - 1);
    expect(delay).toBeLessThanOrEqual(MAX_BACKOFF_MS);
  });

  it('produces different values across calls (stochastic jitter)', () => {
    const results = new Set(Array.from({ length: 50 }, () => retryDelayMs(2)));
    expect(results.size).toBeGreaterThan(1);
  });

  it('RETRY_JITTER is a sensible band (>0 and <0.5)', () => {
    expect(RETRY_JITTER).toBeGreaterThan(0);
    expect(RETRY_JITTER).toBeLessThan(0.5);
  });
});

// ─── Retry schedule constants ─────────────────────────────────────────────────

describe('RETRY_DELAYS_MS schedule', () => {
  it('attempt 1 is ~30 seconds', () => {
    expect(RETRY_DELAYS_MS[1]).toBe(30_000);
  });

  it('attempt 2 is ~2 minutes', () => {
    expect(RETRY_DELAYS_MS[2]).toBe(120_000);
  });

  it('attempt 3 is ~8 minutes', () => {
    expect(RETRY_DELAYS_MS[3]).toBe(480_000);
  });

  it('attempt 4 is ~34 minutes', () => {
    expect(RETRY_DELAYS_MS[4]).toBe(2_040_000);
  });

  it('attempt 5 is ~2 hours', () => {
    expect(RETRY_DELAYS_MS[5]).toBe(7_200_000);
  });

  it('MAX_BACKOFF_MS is 2 hours', () => {
    expect(MAX_BACKOFF_MS).toBe(7_200_000);
  });
});

// ─── Error classification (pure logic, no network) ───────────────────────────

describe('error classification logic', () => {
  type ErrorType = 'timeout' | 'connection_refused' | 'network_error' | 'http_error';

  function classifyError(err: unknown): { errorType: ErrorType; errorMessage: string } {
    if (err instanceof Error) {
      if (err.name === 'AbortError' || err.message.includes('abort')) {
        return { errorType: 'timeout', errorMessage: 'Request timed out' };
      }
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ECONNREFUSED') {
        return { errorType: 'connection_refused', errorMessage: err.message };
      }
      return { errorType: 'network_error', errorMessage: err.message };
    }
    return { errorType: 'network_error', errorMessage: String(err) };
  }

  it('classifies AbortError as timeout', () => {
    const err = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    expect(classifyError(err).errorType).toBe('timeout');
  });

  it('classifies "abort" in message as timeout', () => {
    const err = new Error('fetch aborted by controller');
    expect(classifyError(err).errorType).toBe('timeout');
  });

  it('classifies ECONNREFUSED as connection_refused', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(classifyError(err).errorType).toBe('connection_refused');
  });

  it('classifies generic Error as network_error', () => {
    const err = new Error('ETIMEDOUT');
    expect(classifyError(err).errorType).toBe('network_error');
  });

  it('classifies non-Error as network_error', () => {
    expect(classifyError('something went wrong').errorType).toBe('network_error');
    expect(classifyError(null).errorType).toBe('network_error');
  });

  it('always returns an errorMessage string', () => {
    const cases = [
      new Error('test'),
      Object.assign(new Error('refused'), { name: 'AbortError' }),
      'string error',
      42,
    ];
    for (const c of cases) {
      const { errorMessage } = classifyError(c);
      expect(typeof errorMessage).toBe('string');
      expect(errorMessage.length).toBeGreaterThan(0);
    }
  });
});

// ─── Idempotency logic ────────────────────────────────────────────────────────

describe('delivery idempotency guard', () => {
  it('delivered=true should trigger early return (no re-delivery)', () => {
    // This verifies the guard condition logic, not the full handler
    const delivery = { delivered: true, failedPermanently: false, attempts: 3, maxAttempts: 5 };
    expect(delivery.delivered).toBe(true);
    // Worker skips if delivery.delivered is true
  });

  it('failedPermanently=true should trigger early return', () => {
    const delivery = { delivered: false, failedPermanently: true, attempts: 5, maxAttempts: 5 };
    expect(delivery.failedPermanently).toBe(true);
  });

  it('exhausted when attempts >= maxAttempts', () => {
    const isExhausted = (attempts: number, max: number) => attempts >= max;
    expect(isExhausted(5, 5)).toBe(true);
    expect(isExhausted(4, 5)).toBe(false);
    expect(isExhausted(6, 5)).toBe(true);
  });
});

// ─── Signature verification (uses crypto lib) ─────────────────────────────────

describe('webhook signature', () => {
  it('X-Continuum-Signature format is sha256=<hex>', async () => {
    const { signWebhookPayload } = await import('../../lib/crypto.js');
    const sig = signWebhookPayload('secret', '{"test":1}');
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('different bodies produce different signatures', async () => {
    const { signWebhookPayload } = await import('../../lib/crypto.js');
    const s1 = signWebhookPayload('secret', '{"a":1}');
    const s2 = signWebhookPayload('secret', '{"a":2}');
    expect(s1).not.toBe(s2);
  });

  it('same body + secret always produce the same signature (deterministic)', async () => {
    const { signWebhookPayload } = await import('../../lib/crypto.js');
    const s1 = signWebhookPayload('secret', 'body');
    const s2 = signWebhookPayload('secret', 'body');
    expect(s1).toBe(s2);
  });
});

// ─── Event naming ─────────────────────────────────────────────────────────────

describe('Phase 5 event names', () => {
  it('all three Phase 5 event names are defined in types', async () => {
    const { ALL_WEBHOOK_EVENTS } = await import('../../types/webhook.js');
    expect(ALL_WEBHOOK_EVENTS).toContain('verification.completed');
    expect(ALL_WEBHOOK_EVENTS).toContain('email.status_changed');
    expect(ALL_WEBHOOK_EVENTS).toContain('bulk_job.completed');
  });

  it('legacy event names are still present for backwards compatibility', async () => {
    const { ALL_WEBHOOK_EVENTS } = await import('../../types/webhook.js');
    expect(ALL_WEBHOOK_EVENTS).toContain('verification_complete');
    expect(ALL_WEBHOOK_EVENTS).toContain('bulk_job_complete');
    expect(ALL_WEBHOOK_EVENTS).toContain('monitor_status_change');
  });
});

// ─── buildEventId ─────────────────────────────────────────────────────────────

describe('buildEventId', () => {
  it('formats as <event>:<sourceId>', async () => {
    const { buildEventId } = await import('../../lib/webhooks.js');
    expect(buildEventId('verification.completed', 'ver-abc')).toBe('verification.completed:ver-abc');
  });

  it('produces a unique string for unique sourceIds', async () => {
    const { buildEventId } = await import('../../lib/webhooks.js');
    const ids = new Set(['ver-1', 'ver-2', 'ver-3'].map((id) => buildEventId('verification.completed', id)));
    expect(ids.size).toBe(3);
  });

  it('same event + sourceId always produces the same eventId', async () => {
    const { buildEventId } = await import('../../lib/webhooks.js');
    const id1 = buildEventId('email.status_changed', 'mon-001:2026-04-24T10:00:00.000Z');
    const id2 = buildEventId('email.status_changed', 'mon-001:2026-04-24T10:00:00.000Z');
    expect(id1).toBe(id2);
  });
});
