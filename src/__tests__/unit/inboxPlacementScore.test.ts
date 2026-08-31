import { describe, it, expect } from 'vitest';
import { calculateScore } from '../../routes/inbox-test/index.js';

describe('calculateScore', () => {
  it('returns null when no provider was actually checked', () => {
    expect(calculateScore({ gmail: 'unavailable', outlook: 'unavailable' })).toBeNull();
  });

  it('returns null when every check errored', () => {
    expect(calculateScore({ gmail: 'error' })).toBeNull();
  });

  it('is 100 when every checked provider landed in the inbox', () => {
    expect(calculateScore({ gmail: 'inbox', outlook: 'inbox' })).toBe(100);
  });

  it('is 0 when every checked provider landed in spam', () => {
    expect(calculateScore({ gmail: 'spam' })).toBe(0);
  });

  it('excludes unavailable/error providers from the denominator instead of penalizing the score', () => {
    // Only gmail was actually tested and it landed in the inbox — outlook
    // wasn't tested at all, so it must not drag the score down to 50.
    expect(calculateScore({ gmail: 'inbox', outlook: 'unavailable' })).toBe(100);
  });

  it('averages correctly across a mix of real outcomes', () => {
    expect(calculateScore({ gmail: 'inbox', outlook: 'spam' })).toBe(50);
  });

  it('counts not_found as a real (non-inbox) outcome, not an exclusion', () => {
    expect(calculateScore({ gmail: 'not_found' })).toBe(0);
  });
});
