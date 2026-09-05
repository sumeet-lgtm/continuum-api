import { describe, it, expect } from 'vitest';
import { computeResponseSignal } from '../../routes/finder/index.js';

describe('computeResponseSignal', () => {
  it('recognizes "deliverable" as a strong signal — this is what the actor actually returns in production', () => {
    // Confirmed live: a real search result came back emailStatus: "deliverable",
    // which the previous version's ['verified','valid'] check never matched,
    // silently zeroing out this half of the score for every real lead.
    // Director (+2) + linkedin (+1) alone = 3 = "medium" — deliverable (+2)
    // is what has to tip it over the "high" threshold (>=4) for this to
    // prove the field is actually being read, not just present alongside
    // other fields that would reach "high" on their own regardless.
    const withStatus = computeResponseSignal({ emailStatus: 'deliverable', seniority: 'director', linkedinUrl: 'linkedin.com/in/x' });
    const withoutStatus = computeResponseSignal({ seniority: 'director', linkedinUrl: 'linkedin.com/in/x' });
    expect(withStatus).toBe('high');
    expect(withoutStatus).toBe('medium');
  });

  it('matches catch-all regardless of hyphen/underscore/camelCase separator', () => {
    expect(computeResponseSignal({ emailStatus: 'catch-all' })).toBe(computeResponseSignal({ emailStatus: 'catch_all' }));
    expect(computeResponseSignal({ emailStatus: 'CatchAll' })).toBe(computeResponseSignal({ emailStatus: 'catch_all' }));
  });

  it('still returns low for a genuinely thin row (no status, no seniority bump, no company size, no linkedin)', () => {
    expect(computeResponseSignal({ seniority: 'c_suite' })).toBe('low');
  });
});
