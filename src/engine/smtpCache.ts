/**
 * SMTP verification via MillionVerifier API with caching
 * 
 * Cache strategy:
 *   valid/ok results    → cache 30 days
 *   invalid results     → cache 7 days (domains can recover)
 *   unknown results     → cache 1 day (retry sooner)
 * 
 * Shared cache across ALL users — builds proprietary dataset over time.
 * As cache grows, marginal cost per verification approaches zero.
 */

import { prisma } from '../lib/prisma.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { isFreeEmailProvider } from './lookalike.js';
import { paidProviderLimiter } from '../lib/concurrencyLimiter.js';

export interface SmtpCacheResult {
  checked:     boolean;
  reachable:   boolean | null;
  isCatchAll:  boolean | null;
  greylisted:  boolean;
  fromCache:   boolean;
  rawResponse: string | null;
  error:       string | null;
}

// MillionVerifier result codes
const MV_RESULT = {
  OK:           1, // valid mailbox
  ERROR:        2, // invalid/doesn't exist
  UNKNOWN:      3, // can't determine
  DISPOSABLE:   4, // disposable email
  MAILBOX_FULL: 5, // invalid — mailbox disabled
  NO_MAILBOX:   6, // no mailbox found
  BAD:          7, // bad email
} as const;

// Cache TTL in milliseconds
const TTL = {
  VALID:   30 * 24 * 60 * 60 * 1000, // 30 days
  INVALID:  7 * 24 * 60 * 60 * 1000, // 7 days
  UNKNOWN:  1 * 24 * 60 * 60 * 1000, // 1 day
};

// Exported so the engine can check/populate the same cache around its own
// SMTP probe too — a hit here means neither a real socket probe nor a
// provider call is needed at all, which is the actual "less third-party
// dependency" win: not just preferring our own probe when we do check, but
// checking less often in the first place as the cache warms up.
export const getSmtpCache = getCached;
export const setSmtpCache = storeCache;

/**
 * Drop a cached SMTP verdict outright. Used when a real send outcome
 * (an actual SES bounce) contradicts what the cache says — ground truth
 * from a real delivery attempt beats a point-in-time probe, cached or not.
 */
export async function invalidateSmtpCache(email: string): Promise<void> {
  await prisma.smtpCache.delete({ where: { email: email.toLowerCase() } }).catch(() => {});
}

export async function smtpVerifyWithCache(email: string): Promise<SmtpCacheResult> {
  // 1. Check cache first
  const cached = await getCached(email);
  if (cached) {
    logger.debug({ email }, 'SMTP cache hit');
    return { ...cached, fromCache: true, rawResponse: '' };
  }

  // 2. No cache — try ZeroBounce first when configured (paid credits,
  // called directly, no proxy needed), falling back to the existing
  // proxy-routed DeBounce/Bouncer/MillionVerifier chain whenever
  // ZeroBounce doesn't produce a usable verdict (unconfigured,
  // unreachable, rate-limited past retries, or genuinely "unknown") —
  // one provider's outage or low balance no longer takes the whole
  // SMTP-check layer down with it.
  //
  // Gated behind the shared paidProviderLimiter (max 4 concurrent,
  // process-wide) so that bulk jobs can run their own free SMTP probes at
  // much higher concurrency without also blowing through DeBounce's rate
  // limit — only the emails that actually reach this paid fallback queue
  // behind the tight budget; everyone else's own-probe result isn't
  // throttled by a limit that exists for a vendor they never call.
  let result: SmtpCacheResult = await paidProviderLimiter(async () => {
    if (config.ZEROBOUNCE_API_KEY) {
      const zb = await callZeroBounce(email);
      if (zb.checked) return zb;
      return callMillionVerifier(email);
    }
    return callMillionVerifier(email);
  });

  // 3. Store in cache
  if (result.checked) {
    await storeCache(email, result);
  }

  return { ...result, fromCache: false };
}

// ─── Cache helpers ─────────────────────────────────────────────────────────────

async function getCached(email: string): Promise<Omit<SmtpCacheResult, 'fromCache'> | null> {
  try {
    const cached = await prisma.smtpCache.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (!cached) return null;
    if (new Date() > cached.expiresAt) {
      // Expired — delete and return null
      await prisma.smtpCache.delete({ where: { email: email.toLowerCase() } }).catch(() => {});
      return null;
    }

    return {
      checked:     true,
      reachable:   cached.reachable,
      isCatchAll:  cached.isCatchAll,
      greylisted:  false,
      rawResponse: null,
      error:       null,
    };
  } catch (err) {
    logger.warn({ err, email }, 'Cache lookup failed');
    return null;
  }
}

async function storeCache(email: string, result: SmtpCacheResult): Promise<void> {
  try {
    const now = new Date();
    let ttl = TTL.UNKNOWN;

    if (result.reachable === true)  ttl = TTL.VALID;
    if (result.reachable === false) ttl = TTL.INVALID;

    const expiresAt = new Date(now.getTime() + ttl);

    // The single choke point every caller's catch-all verdict passes
    // through on its way into the shared cache — own-probe results,
    // ZeroBounce, and MillionVerifier all land here. Correcting it once
    // here (rather than in each caller, or only on the response after
    // storing) means a bad verdict can never actually reach the cache in
    // the first place, for any current or future source. See engine/index.ts
    // for why: major webmail providers accept RCPT TO for nearly any
    // syntactically valid local-part and only bounce a nonexistent mailbox
    // later, asynchronously, so no real-time SMTP-layer signal can detect
    // a genuine catch-all on them.
    const isCatchAll = result.isCatchAll && isFreeEmailProvider(email.split('@')[1] ?? '')
      ? false
      : result.isCatchAll;

    await prisma.smtpCache.upsert({
      where: { email: email.toLowerCase() },
      create: {
        email:      email.toLowerCase(),
        reachable:  result.reachable,
        isCatchAll,
        resultCode: 0,
        result:     result.reachable === true ? 'ok' : result.reachable === false ? 'error' : 'unknown',
        checkedAt:  now,
        expiresAt,
      },
      update: {
        reachable:  result.reachable,
        isCatchAll,
        checkedAt:  now,
        expiresAt,
      },
    });
  } catch (err) {
    logger.warn({ err, email }, 'Cache store failed — continuing without cache');
  }
}

// ─── MillionVerifier API call ─────────────────────────────────────────────────

// The provider (DeBounce) rate-limits concurrent traffic and returns 429. A
// 429 means "ask again", NOT "this address is unverifiable" — so we retry with
// backoff+jitter instead of mislabeling the address as unknown. This was the
// bug that made bulk jobs come back ~50% "unknown" under load.
const SMTP_MAX_ATTEMPTS = 4;
const SMTP_RETRY_BASE_MS = 700;

function isRateLimitError(text: string): boolean {
  return /\b429\b|rate.?limit|too many/i.test(text);
}

async function callMillionVerifier(email: string): Promise<SmtpCacheResult> {
  // Call via Cloudflare Worker proxy (Railway blocks direct access to the providers)
  const proxyUrl = config.MV_PROXY_URL;
  const proxyKey = config.MV_PROXY_KEY;
  const apiKey   = config.DEBOUNCE_API_KEY ?? config.BOUNCER_API_KEY ?? config.MILLIONVERIFIER_API_KEY;

  if (!proxyUrl || !proxyKey || !apiKey) {
    logger.warn('SMTP proxy not configured (MV_PROXY_URL/MV_PROXY_KEY/provider API key) — skipping SMTP check');
    return notChecked('SMTP provider not configured');
  }

  let lastError = 'API unreachable';

  for (let attempt = 1; attempt <= SMTP_MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      const delay = SMTP_RETRY_BASE_MS * 2 ** (attempt - 2) + Math.random() * 400;
      await new Promise((r) => setTimeout(r, delay));
    }

    try {
      const res = await fetch(`${proxyUrl}/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-proxy-key': proxyKey,
        },
        body: JSON.stringify({ email, apiKey }),
        signal: AbortSignal.timeout(20_000),
      });

      // Provider rate limit or upstream error → retryable
      if (res.status === 429 || res.status >= 500) {
        lastError = `provider ${res.status}`;
        continue;
      }
      if (!res.ok) {
        logger.warn({ status: res.status, email }, 'MillionVerifier API error');
        return notChecked('API error');
      }

      // DeBounce response format
      const data = await res.json() as {
        debounce?: {
          email:            string;
          code:             string; // '5'=deliverable, '6'=risky, '7'=unknown, '8'=undeliverable
          role:             string;
          free_email:       string;
          result:           string; // 'Safe to Send', 'Risky', 'Unknown', 'Do Not Send'
          reason:           string;
          send_transactional: string;
          did_you_mean:     string;
        };
        success?: string;
        balance?: string;
        error?:   string;
      };

      // DeBounce can return HTTP 200 with an error field on rate limit
      if (data.error && isRateLimitError(String(data.error))) {
        lastError = 'provider 429';
        continue;
      }

      if (!data.debounce || data.success !== '1') {
        return notChecked(data.error ?? 'DeBounce verification failed');
      }

      const code = data.debounce.code;
      const reason = data.debounce.reason ?? '';

      // DeBounce codes: 1/2/5 = Safe · 4/6 = Risky (accept-all) · 8 = Undeliverable · 3/7 = Unknown

      if (code === '1' || code === '2' || code === '5') {
        return {
          checked:     true,
          reachable:   true,
          isCatchAll:  reason.toLowerCase().includes('accept all') || reason.toLowerCase().includes('catch'),
          greylisted:  false,
          fromCache:   false,
          rawResponse: null,
          error:       null,
        };
      }

      if (code === '4' || code === '6') {
        return {
          checked:     true,
          reachable:   true,
          isCatchAll:  true,
          greylisted:  false,
          fromCache:   false,
          rawResponse: null,
          error:       null,
        };
      }

      if (code === '8') {
        return {
          checked:     true,
          reachable:   false,
          isCatchAll:  false,
          greylisted:  false,
          fromCache:   false,
          rawResponse: null,
          error:       null,
        };
      }

      // code 3 or 7 = genuinely Unknown (provider couldn't determine)
      return notChecked('smtp_unknown');

    } catch (err) {
      // Timeout / network blip → retryable
      lastError = err instanceof Error ? err.message : 'API unreachable';
    }
  }

  logger.warn({ email, lastError, attempts: SMTP_MAX_ATTEMPTS }, 'SMTP check exhausted retries');
  return notChecked(lastError);
}

// ─── ZeroBounce API call ──────────────────────────────────────────────────────
// Called directly over HTTPS — unlike DeBounce/Bouncer/MillionVerifier,
// ZeroBounce's validate endpoint is a standard public API with no need to
// route through the Cloudflare Worker proxy.

async function callZeroBounce(email: string): Promise<SmtpCacheResult> {
  const apiKey = config.ZEROBOUNCE_API_KEY;
  if (!apiKey) return notChecked('ZeroBounce not configured');

  let lastError = 'API unreachable';

  for (let attempt = 1; attempt <= SMTP_MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      const delay = SMTP_RETRY_BASE_MS * 2 ** (attempt - 2) + Math.random() * 400;
      await new Promise((r) => setTimeout(r, delay));
    }

    try {
      const url = `https://api.zerobounce.net/v2/validate?api_key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });

      if (res.status === 429 || res.status >= 500) {
        lastError = `provider ${res.status}`;
        continue;
      }
      if (!res.ok) {
        logger.warn({ status: res.status, email }, 'ZeroBounce API error');
        return notChecked('API error');
      }

      const data = await res.json() as {
        address?: string;
        status?: string; // valid|invalid|catch-all|unknown|spamtrap|abuse|do_not_mail|disposable|toxic
        sub_status?: string;
        error?: string;
      };

      if (data.error && isRateLimitError(String(data.error))) {
        lastError = 'provider 429';
        continue;
      }
      if (!data.status) {
        return notChecked(data.error ?? 'ZeroBounce verification failed');
      }

      switch (data.status) {
        case 'valid':
          return { checked: true, reachable: true, isCatchAll: false, greylisted: false, fromCache: false, rawResponse: null, error: null };

        case 'catch-all':
          return { checked: true, reachable: true, isCatchAll: true, greylisted: false, fromCache: false, rawResponse: null, error: null };

        case 'invalid':
        case 'spamtrap':
        case 'abuse':
        case 'do_not_mail':
          return { checked: true, reachable: false, isCatchAll: false, greylisted: false, fromCache: false, rawResponse: null, error: null };

        // 'unknown' and anything undocumented — genuinely inconclusive,
        // not a confident verdict either way.
        default:
          return notChecked('smtp_unknown');
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'API unreachable';
    }
  }

  logger.warn({ email, lastError, attempts: SMTP_MAX_ATTEMPTS }, 'ZeroBounce check exhausted retries');
  return notChecked(lastError);
}

function notChecked(error: string): SmtpCacheResult {
  return { checked: false, reachable: null, isCatchAll: null, greylisted: false, fromCache: false, rawResponse: '', error };
}
