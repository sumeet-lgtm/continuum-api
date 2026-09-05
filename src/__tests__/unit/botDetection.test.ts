import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findManyMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    trackingEvent: { findMany: findManyMock },
  },
}));

import { classifyTrackingEvent, checkIpFanout } from '../../engine/botDetection.js';

const now = new Date('2026-09-05T12:00:00.000Z');
const sentAt = new Date('2026-09-05T11:59:00.000Z'); // 1 minute before "now"

beforeEach(() => {
  vi.clearAllMocks();
});

describe('classifyTrackingEvent', () => {
  it('flags an Apple Mail Privacy Protection IP (17.0.0.0/8) as a bot', () => {
    const result = classifyTrackingEvent({ ip: '17.58.12.4', userAgent: 'Mozilla/5.0', sentAt, occurredAt: now });
    expect(result.isLikelyBot).toBe(true);
    expect(result.botReason).toBe('apple_mpp');
  });

  it('does not flag a normal residential-looking IP with a real browser UA', () => {
    const result = classifyTrackingEvent({ ip: '203.0.113.42', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', sentAt, occurredAt: now });
    expect(result.isLikelyBot).toBe(false);
    expect(result.botReason).toBeNull();
  });

  it('flags a bare curl user-agent as a bot', () => {
    const result = classifyTrackingEvent({ ip: '203.0.113.42', userAgent: 'curl/8.4.0', sentAt, occurredAt: now });
    expect(result.isLikelyBot).toBe(true);
    expect(result.botReason).toBe('bot_user_agent');
  });

  it('flags a missing user-agent as a bot', () => {
    const result = classifyTrackingEvent({ ip: '203.0.113.42', userAgent: null, sentAt, occurredAt: now });
    expect(result.isLikelyBot).toBe(true);
    expect(result.botReason).toBe('bot_user_agent');
  });

  it('flags an empty-string user-agent as a bot', () => {
    const result = classifyTrackingEvent({ ip: '203.0.113.42', userAgent: '   ', sentAt, occurredAt: now });
    expect(result.isLikelyBot).toBe(true);
    expect(result.botReason).toBe('bot_user_agent');
  });

  it('flags a headless-browser user-agent as a bot', () => {
    const result = classifyTrackingEvent({ ip: '203.0.113.42', userAgent: 'Mozilla/5.0 HeadlessChrome/120.0.0.0', sentAt, occurredAt: now });
    expect(result.isLikelyBot).toBe(true);
    expect(result.botReason).toBe('bot_user_agent');
  });

  it('flags an open occurring within 3 seconds of send as prefetch timing, even with a real-looking UA', () => {
    const justSent = new Date(now.getTime() - 1500);
    const result = classifyTrackingEvent({ ip: '203.0.113.42', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', sentAt: justSent, occurredAt: now });
    expect(result.isLikelyBot).toBe(true);
    expect(result.botReason).toBe('prefetch_timing');
  });

  it('does not flag prefetch timing when sentAt is unknown', () => {
    const result = classifyTrackingEvent({ ip: '203.0.113.42', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', sentAt: null, occurredAt: now });
    expect(result.isLikelyBot).toBe(false);
  });

  it('does not flag a normal engagement that happens minutes after send', () => {
    const result = classifyTrackingEvent({ ip: '203.0.113.42', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', sentAt, occurredAt: now });
    expect(result.isLikelyBot).toBe(false);
  });

  it('does not treat a negative time delta (clock skew) as prefetch timing', () => {
    const sentAfterOccurred = new Date(now.getTime() + 10_000);
    const result = classifyTrackingEvent({ ip: '203.0.113.42', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', sentAt: sentAfterOccurred, occurredAt: now });
    expect(result.isLikelyBot).toBe(false);
  });

  it('does not false-positive on an IP that merely starts with 17 but is not in the 17.0.0.0/8 block boundary', () => {
    // 170.x.x.x is a different, unrelated block — must not match the "17." prefix check incorrectly
    const result = classifyTrackingEvent({ ip: '170.10.20.30', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', sentAt, occurredAt: now });
    expect(result.isLikelyBot).toBe(false);
  });
});

describe('checkIpFanout', () => {
  it('returns false for a null IP without querying the database', async () => {
    const result = await checkIpFanout(null, now);
    expect(result).toBe(false);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it('flags an IP that has touched 8+ distinct messages within the window', async () => {
    findManyMock.mockResolvedValue(Array.from({ length: 8 }, (_, i) => ({ sendMessageId: `msg-${i}` })));
    const result = await checkIpFanout('198.51.100.7', now);
    expect(result).toBe(true);
  });

  it('does not flag an IP with only a few distinct messages (a real shared office/VPN gateway)', async () => {
    findManyMock.mockResolvedValue([{ sendMessageId: 'msg-1' }, { sendMessageId: 'msg-2' }]);
    const result = await checkIpFanout('198.51.100.7', now);
    expect(result).toBe(false);
  });

  it('queries only events within the fanout window, scoped to this exact IP', async () => {
    findManyMock.mockResolvedValue([]);
    await checkIpFanout('198.51.100.7', now);
    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        ip: '198.51.100.7',
        occurredAt: expect.objectContaining({ gte: expect.any(Date) }),
      }),
      distinct: ['sendMessageId'],
    }));
  });

  it('fails open (returns false, does not throw) when the database query errors', async () => {
    findManyMock.mockRejectedValue(new Error('connection lost'));
    await expect(checkIpFanout('198.51.100.7', now)).resolves.toBe(false);
  });
});
