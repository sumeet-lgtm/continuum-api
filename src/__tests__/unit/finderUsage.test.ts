import { describe, it, expect, vi, beforeEach } from 'vitest';

// Finder gets its own guaranteed monthly allowance (getFinderLimit /
// PLAN_FINDER_LIMITS), separate from the general verification pool, with
// overflow billed against that pool at FINDER_OVERFLOW_VERIFICATION_COST
// credits/lead once the allowance is exhausted — see the comment above
// currentMonthFinderUsage in schema.prisma for why this needed its own
// counter instead of reusing currentMonthUsage.

const { findUniqueMock, updateMock } = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    apiKey: { findUnique: findUniqueMock, update: updateMock },
  },
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../lib/email.js', () => ({
  sendEmail: vi.fn(),
}));

import {
  getFinderLimit,
  getFinderAffordability,
  incrementFinderUsage,
  FINDER_OVERFLOW_VERIFICATION_COST,
} from '../../plugins/usageMeter.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getFinderLimit', () => {
  it('returns the per-plan allowance', () => {
    expect(getFinderLimit('free')).toBe(25);
    expect(getFinderLimit('starter')).toBe(250);
    expect(getFinderLimit('growth')).toBe(750);
    expect(getFinderLimit('scale')).toBe(2_500);
  });

  it('falls back to the free allowance for an unknown/null plan', () => {
    expect(getFinderLimit(null)).toBe(25);
    expect(getFinderLimit('made-up-plan')).toBe(25);
  });
});

describe('getFinderAffordability', () => {
  it('reports the full dedicated allowance untouched when nothing has been used', () => {
    const { finderRemaining, maxAffordable } = getFinderAffordability({
      plan: 'starter',
      currentMonthFinderUsage: 0,
      currentMonthUsage: 0,
      extraVerificationCredits: 0,
    });
    expect(finderRemaining).toBe(250);
    // Plus whatever the general verification pool can also fund at the overflow rate.
    expect(maxAffordable).toBeGreaterThanOrEqual(250);
  });

  it('falls back to the general verification pool once the dedicated allowance is spent', () => {
    const result = getFinderAffordability({
      plan: 'free', // 25 finder allowance, 1,000 verification limit
      currentMonthFinderUsage: 25, // allowance fully spent
      currentMonthUsage: 0,
      extraVerificationCredits: 0,
    });
    expect(result.finderRemaining).toBe(0);
    expect(result.verificationAsFinderRemaining).toBe(Math.floor(1_000 / FINDER_OVERFLOW_VERIFICATION_COST));
    expect(result.maxAffordable).toBe(result.verificationAsFinderRemaining);
  });

  it('counts purchased top-up credits toward overflow affordability', () => {
    const withoutTopup = getFinderAffordability({
      plan: 'free',
      currentMonthFinderUsage: 25,
      currentMonthUsage: 1_000, // pool exhausted
      extraVerificationCredits: 0,
    });
    expect(withoutTopup.maxAffordable).toBe(0);

    const withTopup = getFinderAffordability({
      plan: 'free',
      currentMonthFinderUsage: 25,
      currentMonthUsage: 1_000,
      extraVerificationCredits: 5_000, // e.g. a purchased credit pack
    });
    expect(withTopup.verificationAsFinderRemaining).toBe(Math.floor(5_000 / FINDER_OVERFLOW_VERIFICATION_COST));
    expect(withTopup.maxAffordable).toBe(withTopup.verificationAsFinderRemaining);
  });

  it('never returns a negative remaining count when usage exceeds the limit', () => {
    const result = getFinderAffordability({
      plan: 'free',
      currentMonthFinderUsage: 999,
      currentMonthUsage: 999_999,
      extraVerificationCredits: 0,
    });
    expect(result.finderRemaining).toBe(0);
    expect(result.verificationAsFinderRemaining).toBe(0);
    expect(result.maxAffordable).toBe(0);
  });
});

describe('incrementFinderUsage', () => {
  it('bills entirely against the dedicated Finder allowance while it covers the count', () => {
    findUniqueMock.mockResolvedValue({
      plan: 'starter',
      monthlyLimit: null,
      currentMonthUsage: 0,
      extraVerificationCredits: 0,
      currentMonthFinderUsage: 10,
    });

    return incrementFinderUsage('key-1', 20).then(() => {
      expect(updateMock).toHaveBeenCalledWith({
        where: { id: 'key-1' },
        data: { currentMonthFinderUsage: { increment: 20 } },
      });
    });
  });

  it('splits billing across the allowance and the overflow pool once the allowance runs out mid-batch', () => {
    findUniqueMock.mockResolvedValue({
      plan: 'free', // 25 finder allowance
      monthlyLimit: null,
      currentMonthUsage: 0,
      extraVerificationCredits: 0,
      currentMonthFinderUsage: 20, // only 5 left in the dedicated allowance
    });

    return incrementFinderUsage('key-2', 12).then(() => {
      // 5 leads from the dedicated allowance, 7 leads overflow at 2 credits/lead
      expect(updateMock).toHaveBeenCalledWith({
        where: { id: 'key-2' },
        data: {
          currentMonthFinderUsage: { increment: 5 },
          currentMonthUsage: { increment: 7 * FINDER_OVERFLOW_VERIFICATION_COST },
        },
      });
    });
  });

  it('bills entirely at the overflow rate once the dedicated allowance is already exhausted', () => {
    findUniqueMock.mockResolvedValue({
      plan: 'free',
      monthlyLimit: null,
      currentMonthUsage: 0,
      extraVerificationCredits: 0,
      currentMonthFinderUsage: 25, // allowance fully spent
    });

    return incrementFinderUsage('key-3', 4).then(() => {
      expect(updateMock).toHaveBeenCalledWith({
        where: { id: 'key-3' },
        data: { currentMonthUsage: { increment: 4 * FINDER_OVERFLOW_VERIFICATION_COST } },
      });
    });
  });

  it('is a no-op for a zero or negative count', async () => {
    await incrementFinderUsage('key-4', 0);
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('fails silently (logs, does not throw) when the key lookup fails', async () => {
    findUniqueMock.mockRejectedValue(new Error('db unreachable'));
    await expect(incrementFinderUsage('key-5', 3)).resolves.toBeUndefined();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('is a no-op when the key no longer exists', async () => {
    findUniqueMock.mockResolvedValue(null);
    await incrementFinderUsage('key-missing', 3);
    expect(updateMock).not.toHaveBeenCalled();
  });
});
