import { describe, it, expect } from 'vitest';
import { isRoleAccount } from '../../engine/roleAccount.js';
import { roleAccounts, notRoleAccounts } from '../fixtures/emails.js';

describe('isRoleAccount', () => {

  // ─── RFC 2142 mandatory mailboxes ──────────────────────────────────────────

  describe('RFC 2142 mandatory mailboxes', () => {
    const rfc2142 = [
      'postmaster', 'hostmaster', 'webmaster',
      'abuse', 'security', 'usenet', 'news', 'uucp', 'ftp',
    ];

    for (const local of rfc2142) {
      it(`detects "${local}" as a role account`, () => {
        expect(isRoleAccount(local)).toBe(true);
      });
    }
  });

  // ─── No-reply variants ─────────────────────────────────────────────────────

  describe('no-reply variants', () => {
    const variants = [
      'noreply', 'no-reply', 'no_reply', 'no.reply',
      'donotreply', 'do-not-reply', 'do_not_reply',
    ];

    for (const local of variants) {
      it(`detects "${local}" as a role account`, () => {
        expect(isRoleAccount(local)).toBe(true);
      });
    }
  });

  // ─── Support & service ─────────────────────────────────────────────────────

  describe('support and service variants', () => {
    const locals = [
      'support', 'help', 'helpdesk', 'care',
      'customerservice', 'customer-service', 'customersupport',
      'service', 'services', 'techsupport',
    ];

    for (const local of locals) {
      it(`detects "${local}" as a role account`, () => {
        expect(isRoleAccount(local)).toBe(true);
      });
    }
  });

  // ─── Generic contact ───────────────────────────────────────────────────────

  describe('generic contact names', () => {
    const locals = ['info', 'contact', 'hello', 'general', 'enquiries', 'inquiry'];

    for (const local of locals) {
      it(`detects "${local}" as a role account`, () => {
        expect(isRoleAccount(local)).toBe(true);
      });
    }
  });

  // ─── Administrative ────────────────────────────────────────────────────────

  describe('administrative accounts', () => {
    const locals = [
      'admin', 'billing', 'accounts', 'finance', 'payroll',
      'hr', 'legal', 'compliance', 'office', 'reception',
    ];

    for (const local of locals) {
      it(`detects "${local}" as a role account`, () => {
        expect(isRoleAccount(local)).toBe(true);
      });
    }
  });

  // ─── Numeric-suffix stripping ──────────────────────────────────────────────

  describe('numeric suffix stripping', () => {
    it('detects "admin2" as a role account', () => {
      expect(isRoleAccount('admin2')).toBe(true);
    });

    it('detects "info123" as a role account', () => {
      expect(isRoleAccount('info123')).toBe(true);
    });

    it('detects "support01" as a role account', () => {
      expect(isRoleAccount('support01')).toBe(true);
    });

    it('detects "noreply99" as a role account', () => {
      expect(isRoleAccount('noreply99')).toBe(true);
    });
  });

  // ─── Compound patterns ─────────────────────────────────────────────────────

  describe('compound role patterns', () => {
    it('detects "info-team" as a role account', () => {
      expect(isRoleAccount('info-team')).toBe(true);
    });

    it('detects "support.eu" as a role account', () => {
      expect(isRoleAccount('support.eu')).toBe(true);
    });

    it('detects "customer-support" as a role account', () => {
      expect(isRoleAccount('customer-support')).toBe(true);
    });

    it('detects "mailer-daemon" as a role account', () => {
      expect(isRoleAccount('mailer-daemon')).toBe(true);
    });

    it('detects "bounces" as a role account', () => {
      expect(isRoleAccount('bounces')).toBe(true);
    });
  });

  // ─── Localized role names ──────────────────────────────────────────────────

  describe('localized role names', () => {
    it('detects German "kontakt"', () => {
      expect(isRoleAccount('kontakt')).toBe(true);
    });

    it('detects Spanish "soporte"', () => {
      expect(isRoleAccount('soporte')).toBe(true);
    });

    it('detects Portuguese "suporte"', () => {
      expect(isRoleAccount('suporte')).toBe(true);
    });

    it('detects French "aide"', () => {
      expect(isRoleAccount('aide')).toBe(true);
    });
  });

  // ─── Case insensitivity ────────────────────────────────────────────────────

  describe('case insensitivity', () => {
    it('detects "ADMIN" (uppercase)', () => {
      expect(isRoleAccount('ADMIN')).toBe(true);
    });

    it('detects "NoReply" (mixed case)', () => {
      expect(isRoleAccount('NoReply')).toBe(true);
    });

    it('detects "Support" (capitalized)', () => {
      expect(isRoleAccount('Support')).toBe(true);
    });
  });

  // ─── True negatives — real personal addresses ──────────────────────────────

  describe('real personal local parts should NOT be role accounts', () => {
    const personals = [
      'alice', 'bob', 'john.doe', 'jane_smith', 'user123',
      'first.last', 'jdoe', 'ceo', 'founder',
      'p.jones', 'mary', 'mike2023',
    ];

    for (const local of personals) {
      it(`does NOT flag "${local}" as a role account`, () => {
        expect(isRoleAccount(local)).toBe(false);
      });
    }
  });

  // ─── Fixture alignment ─────────────────────────────────────────────────────

  describe('fixture emails', () => {
    for (const [key, email] of Object.entries(roleAccounts)) {
      it(`role fixture "${key}" (${email}) is detected`, () => {
        const local = email.split('@')[0] ?? '';
        expect(isRoleAccount(local), `expected "${local}" to be a role account`).toBe(true);
      });
    }

    for (const [key, email] of Object.entries(notRoleAccounts)) {
      it(`non-role fixture "${key}" (${email}) is NOT detected`, () => {
        const local = email.split('@')[0] ?? '';
        expect(isRoleAccount(local), `expected "${local}" NOT to be a role account`).toBe(false);
      });
    }
  });
});
