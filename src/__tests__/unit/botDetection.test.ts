import { describe, it, expect } from 'vitest';
import { classifyTrackingEvent } from '../../engine/botDetection.js';

const now = new Date('2026-09-05T12:00:00.000Z');
const sentAt = new Date('2026-09-05T11:59:00.000Z'); // 1 minute before "now"

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
