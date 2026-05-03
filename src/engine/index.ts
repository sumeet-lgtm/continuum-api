import { prisma } from '../lib/prisma.js';
import { checkSyntax } from './syntax.js';
import { extractDomain, extractLocal } from './domain.js';
import { lookupMx } from './mx.js';
import { isDisposableDomain } from './disposable.js';
import { isRoleAccount } from './roleAccount.js';
import { smtpProbe } from './smtp.js';
import { smtpVerifyWithCache } from './smtpCache.js';
import { checkDeliverability } from './deliverability.js';
import { score } from './scorer.js';
import { logger } from '../lib/logger.js';
import type {
  EngineInput,
  VerificationResult,
  EngineTimings,
} from '../types/verification.js';

/**
 * Full verification pipeline for a single email address.
 *
 * Stage order:
 *   1. Syntax validation    — no I/O
 *   2. Domain extraction    — no I/O
 *   3. MX lookup            — DNS (cached per domain, 5-min TTL)
 *   4. Disposable check     — in-memory Set, O(1)
 *   5. Role account check   — in-memory, O(1)
 *   [stages 4 + 5 run in parallel]
 *   6. SMTP probe           — TCP (skipped on no-MX or syntax fail)
 *   7. Scoring              — pure function
 *   8. DB persist           — async, non-blocking on failure
 *
 * Timing breakdowns per stage are logged at info level and included
 * in the structured log entry so they can be tracked in APM.
 */
export async function verifyEmail(input: EngineInput): Promise<VerificationResult> {
  const wallStart = Date.now();
  const { email, apiKeyId, bulkJobId, sourceIp } = input;

  // ── 1. Syntax ──────────────────────────────────────────────────────────────
  const t0 = Date.now();
  const syntaxResult = checkSyntax(email);
  const syntaxMs = Date.now() - t0;

  if (!syntaxResult.valid) {
    return persistAndReturn({
      email,
      domain: '',
      syntaxValid:   false,
      mxFound:       false,
      mxRecords:     [],
      isDisposable:  false,
      isRoleAccount: false,
      smtpChecked:   false,
      smtpReachable: null,
      smtpRawResponse: null,
      isCatchAll:    null,
      greylisted:    false,
      subStatus:     syntaxResult.reason ?? 'syntax_invalid',
      wallStart,
      timings: { syntaxMs, mxMs: 0, disposableMs: 0, roleMs: 0, smtpMs: 0, totalMs: 0 },
      apiKeyId, bulkJobId, sourceIp,
    });
  }

  // ── 2. Domain extraction ───────────────────────────────────────────────────
  const domain = extractDomain(email);
  const local  = extractLocal(email);

  // ── 3. MX lookup ──────────────────────────────────────────────────────────
  const t1 = Date.now();
  const mxResult = await lookupMx(domain);
  const mxMs = Date.now() - t1;

  if (!mxResult.found) {
    return persistAndReturn({
      email,
      domain,
      syntaxValid:   true,
      mxFound:       false,
      mxRecords:     [],
      isDisposable:  false,
      isRoleAccount: false,
      smtpChecked:   false,
      smtpReachable: null,
      smtpRawResponse: null,
      isCatchAll:    null,
      greylisted:    false,
      subStatus:     mxResult.error ? 'mx_lookup_error' : 'no_mx_records',
      wallStart,
      timings: { syntaxMs, mxMs, disposableMs: 0, roleMs: 0, smtpMs: 0, totalMs: 0 },
      apiKeyId, bulkJobId, sourceIp,
    });
  }

  // ── 4 + 5. Disposable + role (parallel, both in-memory) ───────────────────
  const t2 = Date.now();
  const [disposable, role] = await Promise.all([
    Promise.resolve(isDisposableDomain(domain)),
    Promise.resolve(isRoleAccount(local)),
  ]);
  const disposableMs = Date.now() - t2;
  // Role check is sub-millisecond and runs in same tick — attribute its time to disposable slot
  const roleMs = 0;

  // ── 6. SMTP probe ──────────────────────────────────────────────────────────
  const primaryMx = mxResult.records[0];
  let smtpResult = {
    checked:     false,
    reachable:   null  as boolean | null,
    isCatchAll:  null  as boolean | null,
    greylisted:  false as boolean,
    rawResponse: null  as string  | null,
    error:       null  as string  | null,
  };

  const t3 = Date.now();
  if (primaryMx) {
    try {
      smtpResult = await smtpProbe(email, primaryMx);
    } catch (err) {
      logger.error({ err, email, mxHost: primaryMx }, 'SMTP probe threw unexpectedly');
    }
  }
  const smtpMs = Date.now() - t3;

  // ── 6b. Deliverability checks (SPF/DKIM/DMARC/Blacklist) — skip for bulk to keep fast ─
  const deliverability = bulkJobId ? {
    spfValid: false, spfRecord: null, dmarcValid: false, dmarcRecord: null,
    dkimFound: false, dkimSelectors: [], blacklisted: false, blacklists: [],
  } : await checkDeliverability(domain).catch(() => ({
    spfValid: false, spfRecord: null, dmarcValid: false, dmarcRecord: null,
    dkimFound: false, dkimSelectors: [], blacklisted: false, blacklists: [],
  }));

  // ── 7. Score ───────────────────────────────────────────────────────────────
  const scored = score({
    syntaxValid:   true,
    mxFound:       true,
    isDisposable:  disposable,
    isRoleAccount: role,
    smtpChecked:   smtpResult.checked,
    smtpReachable: smtpResult.reachable,
    isCatchAll:    smtpResult.isCatchAll,
    greylisted:    smtpResult.greylisted,
    spfValid:      deliverability.spfValid,
    dmarcValid:    deliverability.dmarcValid,
    blacklisted:   deliverability.blacklisted,
  });

  // ── 8. Persist + return ────────────────────────────────────────────────────
  return persistAndReturn({
    email,
    domain,
    syntaxValid:     true,
    mxFound:         true,
    mxRecords:       mxResult.records,
    isDisposable:    disposable,
    isRoleAccount:   role,
    smtpChecked:     smtpResult.checked,
    smtpReachable:   smtpResult.reachable,
    smtpRawResponse: smtpResult.rawResponse,
    isCatchAll:      smtpResult.isCatchAll,
    greylisted:      smtpResult.greylisted,
    spfValid:        deliverability.spfValid,
    dmarcValid:      deliverability.dmarcValid,
    dkimFound:       deliverability.dkimFound,
    blacklisted:     deliverability.blacklisted,
    blacklists:      deliverability.blacklists,
    subStatus:       scored.subStatus,
    wallStart,
    timings: { syntaxMs, mxMs, disposableMs, roleMs, smtpMs, totalMs: 0 },
    apiKeyId, bulkJobId, sourceIp,
  });
}

// ─── Internal persist helper ──────────────────────────────────────────────────

interface PersistInput {
  email:           string;
  domain:          string;
  syntaxValid:     boolean;
  mxFound:         boolean;
  mxRecords:       string[];
  isDisposable:    boolean;
  isRoleAccount:   boolean;
  smtpChecked:     boolean;
  smtpReachable:   boolean | null;
  smtpRawResponse: string  | null;
  isCatchAll:      boolean | null;
  greylisted:      boolean;
  spfValid?:       boolean;
  dmarcValid?:     boolean;
  dkimFound?:      boolean;
  blacklisted?:    boolean;
  blacklists?:     string[];
  subStatus:       string  | null;
  wallStart:       number;
  timings:         Omit<EngineTimings, 'totalMs'> & { totalMs: number };
  apiKeyId:        string;
  bulkJobId:       string | undefined;
  sourceIp:        string | undefined;
}

async function persistAndReturn(raw: PersistInput): Promise<VerificationResult> {
  const durationMs = Date.now() - raw.wallStart;
  raw.timings.totalMs = durationMs;

  const scored = score({
    syntaxValid:   raw.syntaxValid,
    mxFound:       raw.mxFound,
    isDisposable:  raw.isDisposable,
    isRoleAccount: raw.isRoleAccount,
    smtpChecked:   raw.smtpChecked,
    smtpReachable: raw.smtpReachable,
    isCatchAll:    raw.isCatchAll,
    greylisted:    raw.greylisted,
  });

  // Prefer the more specific subStatus set earlier (e.g. actual syntax error
  // message) over the generic scorer subStatus.
  const subStatus = raw.subStatus ?? scored.subStatus;

  let record: { id: string; checkedAt: Date };

  try {
    record = await prisma.verification.create({
      data: {
        email:           raw.email,
        domain:          raw.domain,
        status:          scored.status,
        subStatus,
        syntaxValid:     raw.syntaxValid,
        mxFound:         raw.mxFound,
        mxRecords:       raw.mxRecords,
        isDisposable:    raw.isDisposable,
        isRoleAccount:   raw.isRoleAccount,
        smtpChecked:     raw.smtpChecked,
        smtpReachable:   raw.smtpReachable,
        smtpRawResponse: raw.smtpRawResponse,
        isCatchAll:      raw.isCatchAll,
        greylisted:      raw.greylisted,
        score:           scored.score,
        durationMs,
        apiKeyId:        raw.apiKeyId,
        bulkJobId:       raw.bulkJobId ?? null,
        sourceIp:        raw.sourceIp  ?? null,
      },
      select: { id: true, checkedAt: true },
    });
  } catch (err) {
    // DB write failure — surface the result to the caller anyway;
    // a synthetic ID keeps the response shape intact.
    logger.error({ err, email: raw.email }, 'Failed to persist verification result');
    record = { id: `ephemeral_${Date.now()}`, checkedAt: new Date() };
  }

  logger.info(
    {
      id:         record.id,
      email:      raw.email,
      status:     scored.status,
      subStatus,
      score:      scored.score,
      durationMs,
      timings:    raw.timings,
    },
    'Verification complete',
  );

  return {
    id:        record.id,
    email:     raw.email,
    domain:    raw.domain,
    status:    scored.status,
    subStatus,
    checks: {
      syntaxValid:   raw.syntaxValid,
      mxFound:       raw.mxFound,
      mxRecords:     raw.mxRecords,
      isDisposable:  raw.isDisposable,
      isRoleAccount: raw.isRoleAccount,
      smtpChecked:   raw.smtpChecked,
      smtpReachable: raw.smtpReachable,
      isCatchAll:    raw.isCatchAll,
      greylisted:    raw.greylisted,
    },
    score:      scored.score,
    durationMs,
    checkedAt:  record.checkedAt,
  };
}
