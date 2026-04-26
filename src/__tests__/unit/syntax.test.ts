import { describe, it, expect } from 'vitest';
import { checkSyntax } from '../../engine/syntax.js';
import { valid, invalid } from '../fixtures/emails.js';

describe('checkSyntax', () => {

  // ─── Valid cases ────────────────────────────────────────────────────────────

  describe('valid emails', () => {
    it('accepts a simple email', () => {
      expect(checkSyntax(valid.simple)).toMatchObject({ valid: true, reason: null });
    });

    it('accepts subdomain addressing', () => {
      expect(checkSyntax(valid.subdomain).valid).toBe(true);
    });

    it('accepts plus-tag addressing', () => {
      expect(checkSyntax(valid.plusTag).valid).toBe(true);
    });

    it('accepts hyphenated domain', () => {
      expect(checkSyntax(valid.hyphenDomain).valid).toBe(true);
    });

    it('accepts numeric local part', () => {
      expect(checkSyntax(valid.numericLocal).valid).toBe(true);
    });

    it('accepts local part of exactly 64 characters', () => {
      expect(checkSyntax(valid.longLocal).valid).toBe(true);
    });

    it('accepts dots in local part', () => {
      expect(checkSyntax(valid.dotLocal).valid).toBe(true);
    });

    it('accepts all RFC 5321 special characters in local part', () => {
      expect(checkSyntax(valid.specialChars).valid).toBe(true);
    });

    it('accepts FQDN trailing dot in domain', () => {
      expect(checkSyntax(valid.trailingDot).valid).toBe(true);
    });

    it('accepts quoted local part', () => {
      expect(checkSyntax('"quoted local"@example.com').valid).toBe(true);
    });

    it('accepts quoted local with escaped quote', () => {
      expect(checkSyntax('"quo\\"ted"@example.com').valid).toBe(true);
    });

    it('accepts multi-level subdomain', () => {
      expect(checkSyntax('user@a.b.c.example.com').valid).toBe(true);
    });

    it('accepts new-style TLDs like .io .dev .app', () => {
      expect(checkSyntax('user@example.io').valid).toBe(true);
      expect(checkSyntax('user@example.dev').valid).toBe(true);
      expect(checkSyntax('user@example.app').valid).toBe(true);
    });

    it('accepts xn-- punycode labels', () => {
      expect(checkSyntax('user@xn--nxasmq6b.com').valid).toBe(true);
    });

    it('trims surrounding whitespace before validating', () => {
      expect(checkSyntax('  alice@example.com  ').valid).toBe(true);
    });
  });

  // ─── Invalid cases ──────────────────────────────────────────────────────────

  describe('invalid emails', () => {
    it('rejects email with no @ sign', () => {
      const r = checkSyntax(invalid.noAt);
      expect(r.valid).toBe(false);
      expect(r.reason).toMatch(/@/);
    });

    it('rejects email with multiple @ signs', () => {
      const r = checkSyntax(invalid.doubleAt);
      expect(r.valid).toBe(false);
    });

    it('rejects empty local part', () => {
      const r = checkSyntax(invalid.emptyLocal);
      expect(r.valid).toBe(false);
      expect(r.reason).toMatch(/empty|local/i);
    });

    it('rejects empty domain part', () => {
      const r = checkSyntax(invalid.emptyDomain);
      expect(r.valid).toBe(false);
    });

    it('rejects local part longer than 64 characters', () => {
      const r = checkSyntax(invalid.localTooLong);
      expect(r.valid).toBe(false);
      expect(r.reason).toMatch(/64/);
    });

    it('rejects local part starting with a dot', () => {
      const r = checkSyntax(invalid.dotStartLocal);
      expect(r.valid).toBe(false);
      expect(r.reason).toMatch(/start with a dot/i);
    });

    it('rejects local part ending with a dot', () => {
      const r = checkSyntax(invalid.dotEndLocal);
      expect(r.valid).toBe(false);
      expect(r.reason).toMatch(/end with a dot/i);
    });

    it('rejects consecutive dots in local part', () => {
      const r = checkSyntax(invalid.doubleDotLocal);
      expect(r.valid).toBe(false);
      expect(r.reason).toMatch(/consecutive/i);
    });

    it('rejects numeric-only TLD', () => {
      const r = checkSyntax(invalid.numericTld);
      expect(r.valid).toBe(false);
      expect(r.reason).toMatch(/TLD/i);
    });

    it('rejects single-label domain (no dot)', () => {
      const r = checkSyntax(invalid.singleLabelDomain);
      expect(r.valid).toBe(false);
    });

    it('rejects IP address literals', () => {
      const r = checkSyntax(invalid.ipLiteral);
      expect(r.valid).toBe(false);
      expect(r.reason).toMatch(/IP address literal/i);
    });

    it('rejects domain with consecutive dots (empty label)', () => {
      const r = checkSyntax(invalid.emptyLabel);
      expect(r.valid).toBe(false);
    });

    it('rejects domain label starting with hyphen', () => {
      const r = checkSyntax(invalid.hyphenStartLabel);
      expect(r.valid).toBe(false);
      expect(r.reason).toMatch(/hyphen/i);
    });

    it('rejects domain label ending with hyphen', () => {
      const r = checkSyntax(invalid.hyphenEndLabel);
      expect(r.valid).toBe(false);
      expect(r.reason).toMatch(/hyphen/i);
    });

    it('rejects empty string', () => {
      expect(checkSyntax('').valid).toBe(false);
    });

    it('rejects whitespace-only string', () => {
      expect(checkSyntax('   ').valid).toBe(false);
    });

    it('rejects non-ASCII characters', () => {
      const r = checkSyntax(invalid.nonAscii);
      expect(r.valid).toBe(false);
      expect(r.reason).toMatch(/non-ASCII/i);
    });

    it('rejects total email length > 254', () => {
      const local  = 'a'.repeat(64);
      const domain = 'b'.repeat(63) + '.' + 'c'.repeat(63) + '.' + 'd'.repeat(63) + '.com';
      const email  = local + '@' + domain;
      expect(email.length).toBeGreaterThan(254);
      expect(checkSyntax(email).valid).toBe(false);
    });

    it('returns valid=false with a non-null reason for every invalid case', () => {
      for (const [key, email] of Object.entries(invalid)) {
        const r = checkSyntax(email as string);
        if (r.valid) {
          throw new Error(`Expected "${key}" ("${email}") to be invalid but got valid=true`);
        }
        expect(r.reason, `reason should be set for "${key}"`).not.toBeNull();
      }
    });
  });

  // ─── Edge cases ─────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('returns { valid: false } for non-string input coerced by JS', () => {
      // TypeScript would catch this at compile time, but runtime check matters
      expect(checkSyntax(null as unknown as string).valid).toBe(false);
    });

    it('treats an email with only spaces before @ as invalid', () => {
      expect(checkSyntax('   @example.com').valid).toBe(false);
    });

    it('single character local part is valid', () => {
      expect(checkSyntax('a@example.com').valid).toBe(true);
    });

    it('single character labels in domain are valid (e.g. a.io)', () => {
      expect(checkSyntax('user@a.io').valid).toBe(true);
    });
  });
});
