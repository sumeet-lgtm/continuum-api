import { describe, it, expect } from 'vitest';
import { score } from '../../engine/scorer.js';
import type { ScorerInput } from '../../types/verification.js';

// ─── Baseline input builders ─────────────────────────────────────────────────

/** A clean input with no problems and SMTP confirmed */
const clean = (overrides: Partial<ScorerInput> = {}): ScorerInput => ({
  syntaxValid:   true,
  mxFound:       true,
  isDisposable:  false,
  isRoleAccount: false,
  smtpChecked:   true,
  smtpReachable: true,
  isCatchAll:    false,
  greylisted:    false,
  ...overrides,
});

/** A clean input with SMTP disabled */
const noSmtp = (overrides: Partial<ScorerInput> = {}): ScorerInput => ({
  syntaxValid:   true,
  mxFound:       true,
  isDisposable:  false,
  isRoleAccount: false,
  smtpChecked:   false,
  smtpReachable: null,
  isCatchAll:    null,
  greylisted:    false,
  ...overrides,
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('score', () => {

  // ── Rule 1: syntax invalid ─────────────────────────────────────────────────
  describe('syntax invalid', () => {
    it('returns invalid with score 0', () => {
      const r = score(clean({ syntaxValid: false, mxFound: false }));
      expect(r.status).toBe('invalid');
      expect(r.subStatus).toBe('syntax_invalid');
      expect(r.score).toBe(0);
    });
  });

  // ── Rule 2: no MX records ──────────────────────────────────────────────────
  describe('no MX records', () => {
    it('returns invalid with low score', () => {
      const r = score(clean({ mxFound: false }));
      expect(r.status).toBe('invalid');
      expect(r.subStatus).toBe('no_mx_records');
      expect(r.score).toBeLessThanOrEqual(10);
    });
  });

  // ── Rule 3: SMTP rejected ──────────────────────────────────────────────────
  describe('SMTP rejected', () => {
    it('returns invalid when SMTP checked and not reachable', () => {
      const r = score(clean({ smtpChecked: true, smtpReachable: false, greylisted: false }));
      expect(r.status).toBe('invalid');
      expect(r.subStatus).toBe('smtp_rejected');
      expect(r.score).toBeLessThanOrEqual(15);
    });

    it('returns invalid with lower score for disposable + SMTP rejected', () => {
      const r = score(clean({
        isDisposable:  true,
        smtpChecked:   true,
        smtpReachable: false,
        greylisted:    false,
      }));
      expect(r.status).toBe('invalid');
      expect(r.subStatus).toBe('disposable_smtp_rejected');
      expect(r.score).toBeLessThan(10);
    });
  });

  // ── Rule 4: greylisted ─────────────────────────────────────────────────────
  describe('greylisted', () => {
    it('returns unknown with smtp_greylisted subStatus', () => {
      const r = score(clean({ smtpChecked: true, smtpReachable: null, greylisted: true }));
      expect(r.status).toBe('unknown');
      expect(r.subStatus).toBe('smtp_greylisted');
    });

    it('returns risky for greylisted + role account', () => {
      const r = score(clean({
        isRoleAccount: true,
        smtpChecked:   true,
        smtpReachable: null,
        greylisted:    true,
      }));
      expect(r.status).toBe('risky');
      expect(r.subStatus).toBe('role_account');
    });

    it('returns risky for greylisted + disposable', () => {
      const r = score(clean({
        isDisposable:  true,
        smtpChecked:   true,
        smtpReachable: null,
        greylisted:    true,
      }));
      expect(r.status).toBe('risky');
      expect(r.subStatus).toBe('disposable_domain');
    });
  });

  // ── Rule 5: disposable ────────────────────────────────────────────────────
  describe('disposable domains', () => {
    it('returns risky when disposable and SMTP confirms delivery', () => {
      const r = score(clean({ isDisposable: true }));
      expect(r.status).toBe('risky');
      expect(r.subStatus).toBe('disposable_domain');
      expect(r.score).toBeLessThan(30);
    });

    it('returns risky when disposable and SMTP not checked', () => {
      const r = score(noSmtp({ isDisposable: true }));
      expect(r.status).toBe('risky');
      expect(r.subStatus).toBe('disposable_domain');
    });
  });

  // ── Rule 6: catch-all ─────────────────────────────────────────────────────
  describe('catch-all servers', () => {
    it('returns risky for catch-all without role account', () => {
      const r = score(clean({ isCatchAll: true }));
      expect(r.status).toBe('risky');
      expect(r.subStatus).toBe('catch_all');
    });

    it('returns risky with catch_all_role_account for catch-all + role', () => {
      const r = score(clean({ isCatchAll: true, isRoleAccount: true }));
      expect(r.status).toBe('risky');
      expect(r.subStatus).toBe('catch_all_role_account');
      // Lower score than plain catch-all
      const catchAllScore = score(clean({ isCatchAll: true })).score;
      expect(r.score).toBeLessThan(catchAllScore);
    });
  });

  // ── Rule 7: SMTP confirmed ────────────────────────────────────────────────
  describe('SMTP confirmed reachable', () => {
    it('returns valid with score 100 for clean SMTP confirmation', () => {
      const r = score(clean());
      expect(r.status).toBe('valid');
      expect(r.subStatus).toBeNull();
      expect(r.score).toBe(100);
    });

    it('returns risky for SMTP-confirmed role account', () => {
      const r = score(clean({ isRoleAccount: true }));
      expect(r.status).toBe('risky');
      expect(r.subStatus).toBe('role_account');
      expect(r.score).toBeGreaterThan(50); // still has some confidence
    });
  });

  // ── Rule 8: SMTP not checked ──────────────────────────────────────────────
  describe('SMTP not checked', () => {
    it('returns unknown when SMTP not checked and no other red flags', () => {
      const r = score(noSmtp());
      expect(r.status).toBe('unknown');
      expect(r.subStatus).toBe('smtp_not_checked');
      expect(r.score).toBeGreaterThan(40);
      expect(r.score).toBeLessThan(70);
    });

    it('returns risky for role account when SMTP not checked', () => {
      const r = score(noSmtp({ isRoleAccount: true }));
      expect(r.status).toBe('risky');
      expect(r.subStatus).toBe('role_account');
    });
  });

  // ── Score ordering ────────────────────────────────────────────────────────
  describe('score ordering', () => {
    it('valid score > risky score > unknown score > invalid score', () => {
      const validScore   = score(clean()).score;
      const riskyScore   = score(clean({ isRoleAccount: true })).score;
      const unknownScore = score(noSmtp()).score;
      const invalidScore = score(clean({ smtpChecked: true, smtpReachable: false })).score;

      expect(validScore).toBeGreaterThan(riskyScore);
      expect(riskyScore).toBeGreaterThan(unknownScore);
      expect(unknownScore).toBeGreaterThan(invalidScore);
    });

    it('score is always in 0–100 range', () => {
      const inputs: ScorerInput[] = [
        clean(),
        clean({ isRoleAccount: true }),
        clean({ isDisposable: true }),
        clean({ isCatchAll: true }),
        clean({ smtpChecked: true, smtpReachable: false }),
        noSmtp(),
        clean({ syntaxValid: false, mxFound: false }),
        clean({ mxFound: false }),
        clean({ greylisted: true, smtpChecked: true, smtpReachable: null }),
      ];

      for (const input of inputs) {
        const { score: s } = score(input);
        expect(s, JSON.stringify(input)).toBeGreaterThanOrEqual(0);
        expect(s, JSON.stringify(input)).toBeLessThanOrEqual(100);
      }
    });
  });

  // ── Output shape ──────────────────────────────────────────────────────────
  describe('output shape', () => {
    it('always returns status, subStatus, and score', () => {
      const r = score(clean());
      expect(r).toHaveProperty('status');
      expect(r).toHaveProperty('subStatus');
      expect(r).toHaveProperty('score');
    });

    it('subStatus is null for valid clean result', () => {
      expect(score(clean()).subStatus).toBeNull();
    });

    it('subStatus is a non-empty string for all non-clean results', () => {
      const cases: ScorerInput[] = [
        clean({ syntaxValid: false, mxFound: false }),
        clean({ mxFound: false }),
        clean({ isDisposable: true }),
        clean({ isCatchAll: true }),
        clean({ smtpChecked: true, smtpReachable: false }),
        clean({ greylisted: true, smtpChecked: true, smtpReachable: null }),
        noSmtp(),
      ];

      for (const input of cases) {
        const r = score(input);
        if (r.status !== 'valid') {
          expect(r.subStatus, JSON.stringify(input)).not.toBeNull();
          expect(r.subStatus!.length).toBeGreaterThan(0);
        }
      }
    });
  });
});
