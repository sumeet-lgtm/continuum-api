import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    warmupConfig: { findMany: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    mailbox: { update: vi.fn().mockResolvedValue({}) },
  },
}));
vi.mock('../../config.js', () => ({
  config: { WARMUP_POOL_ENABLED: true, MAILBOX_CREDS_SECRET: 'test-secret' },
}));
vi.mock('../../lib/queue.js', () => ({
  QUEUE_WARMUP: 'continuum-warmup',
  redisConnection: {},
}));
vi.mock('../../lib/smtp.js', () => ({ sendViaSmtp: vi.fn().mockResolvedValue({}) }));
vi.mock('../../lib/crypto.js', () => ({ decryptValue: vi.fn().mockReturnValue('decrypted-password') }));
// Real IMAP connections must never happen in a unit test — imap-simple is
// a real installed dependency, so a bare dynamic import would try to load
// it for real. autoOpenAndReply already treats a failed connect as
// non-fatal, so mocking connect to reject exercises that path safely.
vi.mock('imap-simple', () => ({ connect: vi.fn().mockRejectedValue(new Error('no imap in tests')) }));

import { processWarmupTick } from '../../workers/warmupWorker.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';

const mockFindMany = vi.mocked(prisma.warmupConfig.findMany);

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wc-1',
    mailboxId: 'mb-1',
    enabled: true,
    targetPerDay: 40,
    currentPerDay: 40,
    rampUpDays: 30,
    dailyRampUp: 2,
    replyRatePct: 0, // deterministic — no reply branch in tests
    lastRampDate: new Date().toISOString().slice(0, 10), // already ramped today
    poolTier: 'basic', // skip the IMAP auto-open/reply branch entirely
    startedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000), // long past ramp-up
    mailbox: {
      id: 'mb-1', status: 'active', host: 'smtp.example.com', port: 587,
      username: 'a@example.com', passwordEnc: 'enc', oauthTokenEnc: null,
      sentToday: 0, sentTodayResetAt: new Date(), isHousePool: false,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
  vi.spyOn(logger, 'info').mockImplementation(() => undefined as never);
  vi.spyOn(Math, 'random').mockReturnValue(0); // no jitter delay, deterministic randomItem picks
});

describe('processWarmupTick — the house-pool fix', () => {
  it('warns clearly and does nothing when fewer than 2 mailboxes are enabled and none are house-pool', async () => {
    mockFindMany.mockResolvedValue([makeConfig()] as never);

    await processWarmupTick();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ housePoolCount: 0 }),
      expect.stringContaining('Run scripts/add-house-warmup-mailbox.ts'),
    );
  });

  it('runs normally once a house-pool mailbox exists alongside a single real customer mailbox', async () => {
    vi.useFakeTimers();
    try {
      const { sendViaSmtp } = await import('../../lib/smtp.js');
      mockFindMany.mockResolvedValue([
        makeConfig({ id: 'wc-customer', mailboxId: 'mb-customer', targetPerDay: 1, mailbox: { ...makeConfig().mailbox, id: 'mb-customer', username: 'customer@example.com' } }),
        makeConfig({ id: 'wc-house', mailboxId: 'mb-house', targetPerDay: 1, mailbox: { ...makeConfig().mailbox, id: 'mb-house', username: 'house@example.com', isHousePool: true } }),
      ] as never);

      const tick = processWarmupTick();
      await vi.runAllTimersAsync();
      await tick;

      // Two enabled mailboxes, each with a valid partner (the other one) —
      // this is exactly the scenario that always previously failed with
      // "Not enough mailboxes in warmup pool" before a house-pool mailbox
      // could ever exist.
      expect(sendViaSmtp).toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('Warmup pool has fewer than 2'),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports whether the house pool itself exists but is unhealthy, distinctly from having none at all', async () => {
    // A single enabled config whose own mailbox happens to be flagged
    // isHousePool — simulates "the house pool exists but only 1 of its
    // mailboxes is currently enabled/active."
    mockFindMany.mockResolvedValue([makeConfig({ mailbox: { ...makeConfig().mailbox, isHousePool: true } })] as never);

    await processWarmupTick();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ housePoolCount: 1 }),
      expect.stringContaining('check they have status=active and real credentials'),
    );
  });

  it('logs a specific warning when an individual mailbox has no available partner this tick', async () => {
    vi.useFakeTimers();
    try {
      const { sendViaSmtp } = await import('../../lib/smtp.js');
      mockFindMany.mockResolvedValue([
        makeConfig({ id: 'wc-1', mailboxId: 'mb-1' }),
        // Second enabled config exists (passes the >=2 gate) but its
        // mailbox is inactive, so mb-1 still has nobody to actually send to.
        makeConfig({ id: 'wc-2', mailboxId: 'mb-2', mailbox: { ...makeConfig().mailbox, id: 'mb-2', status: 'paused' } }),
      ] as never);

      const tick = processWarmupTick();
      await vi.runAllTimersAsync();
      await tick;

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ mailboxId: 'mb-1' }),
        'No warmup partner mailbox available for this mailbox this tick',
      );
      expect(sendViaSmtp).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
