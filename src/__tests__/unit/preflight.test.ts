import { describe, it, expect } from 'vitest';
import { computePreflightBreakdown } from '../../routes/preflight/index.js';

// "Will this list bounce?" answered purely from data we already have (the
// shared SMTP-verdict cache + the global suppression list) — no new
// verification spend. These tests pin down the classification rules since
// getting them wrong either hides real risk from a customer about to send,
// or cries wolf on addresses that are actually fine.

describe('computePreflightBreakdown', () => {
  it('classifies an address with no suppression and no cache entry as unknown, not a guess', () => {
    const result = computePreflightBreakdown(['nobody-knows@example.com'], [], []);
    expect(result.breakdown.unknown).toBe(1);
    expect(result.breakdown.likely_deliverable).toBe(0);
    expect(result.total).toBe(1);
  });

  it('a cached reachable:true, non-catch-all address counts as likely deliverable', () => {
    const result = computePreflightBreakdown(
      ['good@example.com'], [],
      [{ email: 'good@example.com', reachable: true, isCatchAll: false }],
    );
    expect(result.breakdown.likely_deliverable).toBe(1);
  });

  it('a cached reachable:false address counts as likely to bounce, and is sampled', () => {
    const result = computePreflightBreakdown(
      ['bad@example.com'], [],
      [{ email: 'bad@example.com', reachable: false, isCatchAll: null }],
    );
    expect(result.breakdown.likely_bounce).toBe(1);
    expect(result.sample_risky).toContain('bad@example.com');
  });

  it('a cached catch-all address counts as risky, not deliverable — even though reachable', () => {
    const result = computePreflightBreakdown(
      ['catchall@example.com'], [],
      [{ email: 'catchall@example.com', reachable: true, isCatchAll: true }],
    );
    expect(result.breakdown.risky).toBe(1);
    expect(result.breakdown.likely_deliverable).toBe(0);
  });

  it('a suppressed address is reported as suppressed even if it also has a good cache entry', () => {
    // Suppression is ground truth from an actual bounce/complaint/unsubscribe —
    // it must win over a stale "looked fine" cache entry from before that happened.
    const result = computePreflightBreakdown(
      ['exlead@example.com'],
      [{ email: 'exlead@example.com', reason: 'unsubscribed' }],
      [{ email: 'exlead@example.com', reachable: true, isCatchAll: false }],
    );
    expect(result.breakdown.suppressed).toBe(1);
    expect(result.breakdown.likely_deliverable).toBe(0);
    expect(result.suppressed_reasons.unsubscribed).toBe(1);
  });

  it('tallies suppression reasons separately so a customer can tell hard bounces from unsubscribes', () => {
    const result = computePreflightBreakdown(
      ['a@example.com', 'b@example.com', 'c@example.com'],
      [
        { email: 'a@example.com', reason: 'hard_bounce' },
        { email: 'b@example.com', reason: 'hard_bounce' },
        { email: 'c@example.com', reason: 'complaint' },
      ],
      [],
    );
    expect(result.suppressed_reasons).toEqual({ hard_bounce: 2, complaint: 1 });
    expect(result.breakdown.suppressed).toBe(3);
  });

  it('caps the risky sample list at 20 even with many more flagged addresses', () => {
    const emails = Array.from({ length: 30 }, (_, i) => `bad${i}@example.com`);
    const cacheHits = emails.map(email => ({ email, reachable: false, isCatchAll: null }));
    const result = computePreflightBreakdown(emails, [], cacheHits);
    expect(result.breakdown.likely_bounce).toBe(30);
    expect(result.sample_risky.length).toBe(20);
  });

  it('an empty email list returns an all-zero breakdown, not an error', () => {
    const result = computePreflightBreakdown([], [], []);
    expect(result.total).toBe(0);
    expect(result.breakdown).toEqual({ likely_deliverable: 0, risky: 0, likely_bounce: 0, suppressed: 0, unknown: 0 });
  });

  it('a cache entry with reachable:null (checked but inconclusive) counts as unknown, not deliverable or bounce', () => {
    const result = computePreflightBreakdown(
      ['inconclusive@example.com'], [],
      [{ email: 'inconclusive@example.com', reachable: null, isCatchAll: null }],
    );
    expect(result.breakdown.unknown).toBe(1);
    expect(result.breakdown.likely_deliverable).toBe(0);
    expect(result.breakdown.likely_bounce).toBe(0);
  });
});
