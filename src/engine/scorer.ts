import type { ScorerInput, ScorerOutput, VerificationStatus } from '../types/verification.js';

/**
 * Decision table: combine all verification signals into a final status + score.
 *
 * Rules are evaluated top-down; first match wins.
 *
 * Status semantics:
 *   valid   — deliverable with high confidence; safe to send
 *   invalid — definitively undeliverable; do not send
 *   risky   — domain is reachable but bounce/spam risk is elevated
 *   unknown — cannot determine; SMTP unavailable or greylisted
 *
 * Score (0–100):
 *   Represents confidence in deliverability, not in the status bucket.
 *   Use this to rank-order results when status alone is insufficient.
 *   100 = SMTP-confirmed real mailbox, clean on all checks
 *     0 = syntax error or non-existent domain
 */
export function score(input: ScorerInput): ScorerOutput {
  const {
    syntaxValid,
    mxFound,
    isDisposable,
    isRoleAccount,
    smtpChecked,
    smtpReachable,
    isCatchAll,
    greylisted,
    spfValid,
    dmarcValid,
    blacklisted,
  } = input;

  // ── 1. Hard failures ───────────────────────────────────────────────────────
  if (!syntaxValid) return out('invalid', 'syntax_invalid', 0);
  if (!mxFound)     return out('invalid', 'no_mx_records',  5);

  // ── 1b. Blacklisted or toxic domain ──────────────────────────────────────
  if (blacklisted) return out('risky', 'blacklisted_domain', 10);
  if (input.isToxic) return out('risky', 'toxic_domain', 8);
  if (input.isAbuse) return out('risky', 'abuse_tld', 15);

  // ── 2. SMTP permanently rejected ──────────────────────────────────────────
  if (smtpChecked && smtpReachable === false && !greylisted) {
    if (isDisposable) return out('invalid', 'disposable_smtp_rejected', 3);
    return out('invalid', 'smtp_rejected', 8);
  }

  // ── 3. Greylisted — definitive existence unknown ──────────────────────────
  // The domain is live (MX found, connection accepted), but we got a 4xx at
  // RCPT TO. This is a temporary deferral, not a bounce. Caller should
  // retry after a few minutes. We return unknown rather than risky because
  // the address itself is unconfirmed.
  if (greylisted) {
    if (isDisposable)  return out('risky',   'disposable_domain',       18);
    if (isRoleAccount) return out('risky',   'role_account',            35);
    return                     out('unknown', 'smtp_greylisted',         52);
  }

  // ── 4. Disposable domains ─────────────────────────────────────────────────
  // Even if SMTP confirms it, a disposable inbox expires — mark risky.
  if (isDisposable) {
    if (smtpChecked && smtpReachable === true) {
      return out('risky', 'disposable_domain', 22);
    }
    return out('risky', 'disposable_domain', 15);
  }

  // ── 5. Catch-all server ───────────────────────────────────────────────────
  // Server accepts any recipient — specific address existence unconfirmed.
  if (isCatchAll) {
    if (isRoleAccount) return out('risky', 'catch_all_role_account', 28);
    return                    out('risky', 'catch_all',              42);
  }

  // ── 6. SMTP confirmed reachable ───────────────────────────────────────────
  if (smtpChecked && smtpReachable === true) {
    if (isRoleAccount) return out('risky', 'role_account', 58);
    return                    out('valid', null,           100);
  }

  // ── 7. SMTP not checked ───────────────────────────────────────────────────
  // MX exists and all static checks pass, but no SMTP confirmation.
  if (isRoleAccount) return out('risky',   'role_account',      38);
  return                    out('unknown', 'smtp_not_checked',   55);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function out(
  status:    VerificationStatus,
  subStatus: string | null,
  scoreVal:  number,
): ScorerOutput {
  return { status, subStatus, score: scoreVal };
}
