import { describe, it, expect, beforeAll } from 'vitest';
import { isDisposableDomain, loadDisposableList, getBlocklistStats } from '../../engine/disposable.js';

// Load the blocklist once before all tests
beforeAll(() => {
  loadDisposableList();
});

describe('isDisposableDomain', () => {

  // ─── Known disposable providers ────────────────────────────────────────────

  describe('known disposable providers', () => {
    const knownDisposable = [
      'mailinator.com',
      'guerrillamail.com',
      'guerrillamail.net',
      'guerrillamail.org',
      'yopmail.com',
      'trashmail.com',
      'trashmail.net',
      '10minutemail.com',
      'tempmail.com',
      'temp-mail.org',
      'discard.email',
      'maildrop.cc',
      'mailsac.com',
    ];

    for (const domain of knownDisposable) {
      it(`detects "${domain}" as disposable`, () => {
        expect(isDisposableDomain(domain)).toBe(true);
      });
    }
  });

  // ─── Subdomain variants ────────────────────────────────────────────────────

  describe('subdomain variants', () => {
    it('detects subdomain of mailinator.com', () => {
      expect(isDisposableDomain('mail.mailinator.com')).toBe(true);
    });

    it('detects subdomain of guerrillamail.com', () => {
      expect(isDisposableDomain('lists.guerrillamail.com')).toBe(true);
    });

    it('detects deep subdomain', () => {
      expect(isDisposableDomain('a.b.mailinator.com')).toBe(true);
    });
  });

  // ─── Case insensitivity ────────────────────────────────────────────────────

  describe('case insensitivity', () => {
    it('detects uppercase domain', () => {
      expect(isDisposableDomain('MAILINATOR.COM')).toBe(true);
    });

    it('detects mixed-case domain', () => {
      expect(isDisposableDomain('Mailinator.Com')).toBe(true);
    });
  });

  // ─── Real domains — must NOT be flagged ───────────────────────────────────

  describe('real email providers are not flagged', () => {
    const realDomains = [
      'gmail.com',
      'yahoo.com',
      'outlook.com',
      'hotmail.com',
      'icloud.com',
      'protonmail.com',
      'fastmail.com',
      'example.com',
      'company.io',
      'startup.co',
      'university.edu',
    ];

    for (const domain of realDomains) {
      it(`does NOT flag "${domain}" as disposable`, () => {
        expect(isDisposableDomain(domain)).toBe(false);
      });
    }
  });

  // ─── Blocklist stats ───────────────────────────────────────────────────────

  describe('getBlocklistStats', () => {
    it('returns non-zero exact count after loading', () => {
      const stats = getBlocklistStats();
      expect(stats.exact).toBeGreaterThan(50);
    });

    it('returns an object with exact and wildcard keys', () => {
      const stats = getBlocklistStats();
      expect(stats).toHaveProperty('exact');
      expect(stats).toHaveProperty('wildcard');
    });
  });

  // ─── Edge cases ─────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty string', () => {
      expect(isDisposableDomain('')).toBe(false);
    });

    it('handles domain with only TLD', () => {
      expect(isDisposableDomain('com')).toBe(false);
    });

    it('handles whitespace-padded domain', () => {
      // Internal normalization should strip it
      expect(isDisposableDomain('  mailinator.com  ')).toBe(true);
    });
  });
});
