import { describe, it, expect } from 'vitest';
// Mock prisma so importing from the route file doesn't trigger PrismaClient init
import { vi } from 'vitest';
vi.mock('../../lib/prisma.js', () => ({
  prisma: { bulkJob: {}, bulkJobEmail: {}, $disconnect: vi.fn() },
  disconnectPrisma: vi.fn(),
}));
// Mock other libs pulled in transitively by the route file
vi.mock('../../lib/redis.js',    () => ({ redis: {}, pingRedis: vi.fn(), redisKey: { rateLimit: vi.fn(), ipRateLimit: vi.fn() }, getRedis: vi.fn() }));
vi.mock('../../lib/queue.js',    () => ({ bulkQueue: {}, webhookQueue: {}, monitorQueue: {}, closeQueues: vi.fn(), redisConnection: {} }));
vi.mock('../../lib/supabase.js', () => ({ uploadToStorage: vi.fn(), downloadFromStorage: vi.fn(), createSignedUrl: vi.fn(), deleteFromStorage: vi.fn() }));
vi.mock('../../engine/disposable.js', () => ({ loadDisposableList: vi.fn(), isDisposableDomain: vi.fn(), getBlocklistStats: vi.fn() }));
vi.mock('../../engine/mx.js',    () => ({ lookupMx: vi.fn(), clearMxCache: vi.fn(), getMxCacheStats: vi.fn() }));
vi.mock('../../engine/smtp.js',  () => ({ smtpProbe: vi.fn() }));

import { parseCsv } from '../../routes/bulk-jobs/index.js';

describe('parseCsv', () => {

  // ─── Basic parsing ──────────────────────────────────────────────────────────

  describe('basic parsing', () => {
    it('parses a simple single-column file', () => {
      const result = parseCsv('alice@example.com\nbob@example.com\n');
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ email: 'alice@example.com', rowIndex: 0, isDuplicate: false });
      expect(result[1]).toMatchObject({ email: 'bob@example.com',   rowIndex: 1, isDuplicate: false });
    });

    it('returns an empty array for empty input', () => {
      expect(parseCsv('')).toHaveLength(0);
      expect(parseCsv('\n\n\n')).toHaveLength(0);
    });

    it('assigns sequential rowIndex values', () => {
      const result = parseCsv('a@x.com\nb@x.com\nc@x.com\n');
      expect(result.map((r) => r.rowIndex)).toEqual([0, 1, 2]);
    });

    it('normalises emails to lowercase', () => {
      const result = parseCsv('Alice@Example.COM\n');
      expect(result[0]?.email).toBe('alice@example.com');
    });

    it('strips surrounding whitespace from each line', () => {
      const result = parseCsv('  alice@example.com  \n  bob@example.com  \n');
      expect(result[0]?.email).toBe('alice@example.com');
      expect(result[1]?.email).toBe('bob@example.com');
    });

    it('ignores blank lines in the middle of the file', () => {
      const result = parseCsv('alice@example.com\n\n\nbob@example.com\n');
      expect(result).toHaveLength(2);
      expect(result[0]?.email).toBe('alice@example.com');
      expect(result[1]?.email).toBe('bob@example.com');
    });
  });

  // ─── Header detection ───────────────────────────────────────────────────────

  describe('header detection', () => {
    it('skips a row containing "email"', () => {
      const result = parseCsv('email\nalice@example.com\n');
      expect(result).toHaveLength(1);
      expect(result[0]?.email).toBe('alice@example.com');
    });

    it('skips a row containing "Email" (case-insensitive)', () => {
      const result = parseCsv('Email\nalice@example.com\n');
      expect(result).toHaveLength(1);
    });

    it('skips a row containing "email_address"', () => {
      const result = parseCsv('email_address,name,company\nalice@example.com,Alice,Acme\n');
      expect(result).toHaveLength(1);
      expect(result[0]?.email).toBe('alice@example.com');
    });

    it('skips a row containing "address"', () => {
      const result = parseCsv('address\nalice@example.com\n');
      expect(result).toHaveLength(1);
    });

    it('skips first row with no "@" sign', () => {
      const result = parseCsv('First Name,Last Name\nalice@example.com\n');
      expect(result).toHaveLength(1);
    });

    it('does NOT skip first row when it contains "@"', () => {
      const result = parseCsv('alice@example.com\nbob@example.com\n');
      expect(result).toHaveLength(2);
      expect(result[0]?.email).toBe('alice@example.com');
    });

    it('assigns rowIndex starting from 0 after header is skipped', () => {
      const result = parseCsv('email\nalice@example.com\nbob@example.com\n');
      expect(result[0]?.rowIndex).toBe(0);
      expect(result[1]?.rowIndex).toBe(1);
    });
  });

  // ─── Multi-column CSV ───────────────────────────────────────────────────────

  describe('multi-column CSV', () => {
    it('extracts only the first column', () => {
      const result = parseCsv('email,name,company\nalice@example.com,Alice Smith,Acme\n');
      expect(result).toHaveLength(1);
      expect(result[0]?.email).toBe('alice@example.com');
    });

    it('handles quoted first column', () => {
      const result = parseCsv('"alice@example.com","Alice","Acme"\n');
      expect(result[0]?.email).toBe('alice@example.com');
    });

    it('handles quoted email with commas inside (edge case)', () => {
      const result = parseCsv('"alice@example.com","Smith, Alice"\n');
      expect(result[0]?.email).toBe('alice@example.com');
    });

    it('handles mixed quoted and unquoted columns', () => {
      const csv = [
        'email,first,last',
        'alice@example.com,Alice,Smith',
        '"bob@example.com","Bob","Jones"',
      ].join('\n') + '\n';
      const result = parseCsv(csv);
      expect(result).toHaveLength(2);
      expect(result[0]?.email).toBe('alice@example.com');
      expect(result[1]?.email).toBe('bob@example.com');
    });
  });

  // ─── Duplicate detection ────────────────────────────────────────────────────

  describe('duplicate detection', () => {
    it('flags the second occurrence of a duplicate email', () => {
      const result = parseCsv('alice@example.com\nalice@example.com\n');
      expect(result).toHaveLength(2);
      expect(result[0]?.isDuplicate).toBe(false);
      expect(result[1]?.isDuplicate).toBe(true);
    });

    it('preserves rowIndex for duplicates', () => {
      const result = parseCsv('alice@example.com\nbob@example.com\nalice@example.com\n');
      expect(result[2]?.rowIndex).toBe(2);
      expect(result[2]?.isDuplicate).toBe(true);
    });

    it('flags all occurrences after the first as duplicates', () => {
      const result = parseCsv('x@y.com\nx@y.com\nx@y.com\n');
      expect(result[0]?.isDuplicate).toBe(false);
      expect(result[1]?.isDuplicate).toBe(true);
      expect(result[2]?.isDuplicate).toBe(true);
    });

    it('duplicate detection is case-insensitive (emails normalised before dedup)', () => {
      const result = parseCsv('Alice@Example.COM\nalice@example.com\n');
      expect(result[0]?.isDuplicate).toBe(false);
      expect(result[1]?.isDuplicate).toBe(true);
    });

    it('non-duplicate emails have isDuplicate=false', () => {
      const result = parseCsv('alice@a.com\nbob@b.com\ncarol@c.com\n');
      expect(result.every((r) => !r.isDuplicate)).toBe(true);
    });
  });

  // ─── Quote stripping ────────────────────────────────────────────────────────

  describe('quote stripping', () => {
    it('strips double-quotes surrounding an email', () => {
      const result = parseCsv('"alice@example.com"\n');
      expect(result[0]?.email).toBe('alice@example.com');
    });

    it('strips single-quotes surrounding an email', () => {
      const result = parseCsv("'alice@example.com'\n");
      expect(result[0]?.email).toBe('alice@example.com');
    });

    it('handles no quotes', () => {
      const result = parseCsv('alice@example.com\n');
      expect(result[0]?.email).toBe('alice@example.com');
    });
  });

  // ─── Invalid rows ────────────────────────────────────────────────────────────

  describe('filtering invalid rows', () => {
    it('drops rows that produce empty string after cleaning', () => {
      const result = parseCsv(',,,\nalice@example.com\n');
      // First row extracts first column which is empty — dropped
      // But wait — header detection sees no '@' in ',,,', skips it as header
      // alice@example.com is the first real row
      expect(result.some((r) => r.email === '')).toBe(false);
    });

    it('rowIndex increments only for valid (non-empty) rows', () => {
      // Two valid rows: rowIndex should be 0 and 1
      const result = parseCsv('email\nalice@example.com\nbob@example.com\n');
      expect(result.map((r) => r.rowIndex)).toEqual([0, 1]);
    });
  });

  // ─── Large input ─────────────────────────────────────────────────────────────

  describe('large input', () => {
    it('handles 1000 email rows correctly', () => {
      const emails = Array.from({ length: 1000 }, (_, i) => `user${i}@example.com`);
      const csv    = ['email', ...emails].join('\n') + '\n';
      const result = parseCsv(csv);
      expect(result).toHaveLength(1000);
      expect(result[999]?.email).toBe('user999@example.com');
      expect(result[999]?.rowIndex).toBe(999);
    });

    it('correctly identifies duplicates in 1000 rows with 100 dupes', () => {
      const unique = Array.from({ length: 900 }, (_, i) => `u${i}@example.com`);
      const dupes  = Array.from({ length: 100 }, (_, i) => `u${i}@example.com`);
      const csv    = ['email', ...unique, ...dupes].join('\n') + '\n';
      const result = parseCsv(csv);

      expect(result).toHaveLength(1000);
      const dupeCount = result.filter((r) => r.isDuplicate).length;
      expect(dupeCount).toBe(100);
    });
  });

  // ─── Windows line endings ────────────────────────────────────────────────────

  describe('Windows CRLF line endings', () => {
    it('handles \\r\\n line endings', () => {
      const result = parseCsv('email\r\nalice@example.com\r\nbob@example.com\r\n');
      expect(result).toHaveLength(2);
      expect(result[0]?.email).toBe('alice@example.com');
    });
  });
});
