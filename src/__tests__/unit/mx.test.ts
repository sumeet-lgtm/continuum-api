import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { lookupMx, clearMxCache, getMxCacheStats } from '../../engine/mx.js';

// ─── Mock node:dns/promises ───────────────────────────────────────────────────

vi.mock('node:dns/promises', () => ({
  default: {
    resolveMx: vi.fn(),
    resolve: vi.fn(),
  },
}));

import dns from 'node:dns/promises';
const mockResolveMx = vi.mocked(dns.resolveMx);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMxRecords(hosts: Array<{ exchange: string; priority: number }>) {
  return hosts;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('lookupMx', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMxCache();
  });

  afterEach(() => {
    clearMxCache();
  });

  // ─── Successful lookups ──────────────────────────────────────────────────

  describe('successful lookups', () => {
    it('returns found=true and sorted records for a domain with MX', async () => {
      mockResolveMx.mockResolvedValueOnce(
        makeMxRecords([
          { exchange: 'mx2.example.com.', priority: 20 },
          { exchange: 'mx1.example.com.', priority: 10 },
        ]),
      );

      const result = await lookupMx('example.com');

      expect(result.found).toBe(true);
      expect(result.records).toEqual(['mx1.example.com', 'mx2.example.com']);
      expect(result.error).toBeNull();
    });

    it('strips trailing dot from MX hostnames', async () => {
      mockResolveMx.mockResolvedValueOnce(
        makeMxRecords([{ exchange: 'mail.example.com.', priority: 10 }]),
      );

      const result = await lookupMx('example.com');
      expect(result.records[0]).toBe('mail.example.com');
    });

    it('lowercases MX hostnames', async () => {
      mockResolveMx.mockResolvedValueOnce(
        makeMxRecords([{ exchange: 'MAIL.EXAMPLE.COM', priority: 10 }]),
      );

      const result = await lookupMx('example.com');
      expect(result.records[0]).toBe('mail.example.com');
    });

    it('sorts multiple records by priority ascending', async () => {
      mockResolveMx.mockResolvedValueOnce(
        makeMxRecords([
          { exchange: 'c.example.com', priority: 30 },
          { exchange: 'a.example.com', priority: 10 },
          { exchange: 'b.example.com', priority: 20 },
        ]),
      );

      const result = await lookupMx('example.com');
      expect(result.records).toEqual([
        'a.example.com',
        'b.example.com',
        'c.example.com',
      ]);
    });

    it('handles a single MX record', async () => {
      mockResolveMx.mockResolvedValueOnce(
        makeMxRecords([{ exchange: 'mx.example.com', priority: 5 }]),
      );

      const result = await lookupMx('example.com');
      expect(result.found).toBe(true);
      expect(result.records).toHaveLength(1);
    });
  });

  // ─── No records ──────────────────────────────────────────────────────────

  describe('no MX records', () => {
    it('returns found=false for empty records array', async () => {
      mockResolveMx.mockResolvedValueOnce([]);

      const result = await lookupMx('nodns.example.com');
      expect(result.found).toBe(false);
      expect(result.records).toHaveLength(0);
      expect(result.error).toBeNull();
    });

    it('returns found=false on ENOTFOUND (non-existent domain)', async () => {
      const err = Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      mockResolveMx.mockRejectedValueOnce(err);

      const result = await lookupMx('nonexistent.example.com');
      expect(result.found).toBe(false);
      expect(result.error).toBeNull(); // definitive — no error message needed
    });

    it('returns found=false on ENODATA (no MX type records)', async () => {
      const err = Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
      mockResolveMx.mockRejectedValueOnce(err);

      const result = await lookupMx('example.com');
      expect(result.found).toBe(false);
      expect(result.error).toBeNull();
    });

    it('returns found=false on ESERVFAIL', async () => {
      const err = Object.assign(new Error('ESERVFAIL'), { code: 'ESERVFAIL' });
      mockResolveMx.mockRejectedValueOnce(err);

      const result = await lookupMx('example.com');
      expect(result.found).toBe(false);
      expect(result.error).toBeNull();
    });
  });

  // ─── Transient errors and retries ────────────────────────────────────────

  describe('transient errors', () => {
    it('retries on timeout and returns error after all retries exhausted', async () => {
      const timeoutErr = new Error('MX lookup timed out after 5000ms');
      mockResolveMx
        .mockRejectedValueOnce(timeoutErr)
        .mockRejectedValueOnce(timeoutErr);

      const result = await lookupMx('slow.example.com');
      expect(result.found).toBe(false);
      expect(result.error).not.toBeNull();
      // Should have been called exactly MX_LOOKUP_RETRIES (2) times
      expect(mockResolveMx).toHaveBeenCalledTimes(2);
    });

    it('succeeds on retry after transient error', async () => {
      const timeoutErr = new Error('timeout');
      mockResolveMx
        .mockRejectedValueOnce(timeoutErr)
        .mockResolvedValueOnce(
          makeMxRecords([{ exchange: 'mx.example.com', priority: 10 }]),
        );

      const result = await lookupMx('example.com');
      expect(result.found).toBe(true);
      expect(mockResolveMx).toHaveBeenCalledTimes(2);
    });
  });

  // ─── In-process cache ────────────────────────────────────────────────────

  describe('in-process cache', () => {
    it('returns cached result on second call (no second DNS query)', async () => {
      mockResolveMx.mockResolvedValue(
        makeMxRecords([{ exchange: 'mx.example.com', priority: 10 }]),
      );

      const r1 = await lookupMx('example.com');
      const r2 = await lookupMx('example.com');

      expect(r1).toEqual(r2);
      // Only one DNS call — second came from cache
      expect(mockResolveMx).toHaveBeenCalledTimes(1);
    });

    it('clearMxCache() forces a fresh lookup', async () => {
      mockResolveMx.mockResolvedValue(
        makeMxRecords([{ exchange: 'mx.example.com', priority: 10 }]),
      );

      await lookupMx('example.com');
      clearMxCache();
      await lookupMx('example.com');

      expect(mockResolveMx).toHaveBeenCalledTimes(2);
    });

    it('getMxCacheStats() returns current cache size', async () => {
      mockResolveMx.mockResolvedValue(
        makeMxRecords([{ exchange: 'mx.a.com', priority: 10 }]),
      );

      clearMxCache();
      expect(getMxCacheStats().size).toBe(0);

      await lookupMx('a.com');
      expect(getMxCacheStats().size).toBe(1);

      await lookupMx('b.com');  // different domain
      expect(getMxCacheStats().size).toBe(2);
    });

    it('different domains are cached independently', async () => {
      mockResolveMx
        .mockResolvedValueOnce(makeMxRecords([{ exchange: 'mx.a.com', priority: 10 }]))
        .mockResolvedValueOnce(makeMxRecords([{ exchange: 'mx.b.com', priority: 10 }]));

      const ra = await lookupMx('a.com');
      const rb = await lookupMx('b.com');

      expect(ra.records[0]).toBe('mx.a.com');
      expect(rb.records[0]).toBe('mx.b.com');
      expect(mockResolveMx).toHaveBeenCalledTimes(2);
    });
  });
});
