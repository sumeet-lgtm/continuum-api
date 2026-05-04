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

export async function smtpVerifyWithCache(email: string): Promise<SmtpCacheResult> {
  // 1. Check cache first
  const cached = await getCached(email);
  if (cached) {
    logger.debug({ email }, 'SMTP cache hit');
    return { ...cached, fromCache: true, rawResponse: '' };
  }

  // 2. No cache — call MillionVerifier
  if (!config.MILLIONVERIFIER_API_KEY) {
    return { checked: false, reachable: null, isCatchAll: null, greylisted: false, fromCache: false, rawResponse: '', error: 'No SMTP API key configured' };
  }

  const mvResult = await callMillionVerifier(email);
  
  // 3. Store in cache
  if (mvResult.checked) {
    await storeCache(email, mvResult);
  }

  return { ...mvResult, fromCache: false };
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

    await prisma.smtpCache.upsert({
      where: { email: email.toLowerCase() },
      create: {
        email:      email.toLowerCase(),
        reachable:  result.reachable,
        isCatchAll: result.isCatchAll,
        resultCode: 0,
        result:     result.reachable === true ? 'ok' : result.reachable === false ? 'error' : 'unknown',
        checkedAt:  now,
        expiresAt,
      },
      update: {
        reachable:  result.reachable,
        isCatchAll: result.isCatchAll,
        checkedAt:  now,
        expiresAt,
      },
    });
  } catch (err) {
    logger.warn({ err, email }, 'Cache store failed — continuing without cache');
  }
}

// ─── MillionVerifier API call ─────────────────────────────────────────────────

async function callMillionVerifier(email: string): Promise<SmtpCacheResult> {
  try {
    // Call via Cloudflare Worker proxy (Railway blocks direct access to millionverifier.com)
    const proxyUrl = config.MV_PROXY_URL ?? 'https://mv-proxy.sumit-sutar259.workers.dev';
    const proxyKey = config.MV_PROXY_KEY ?? 'cnt-mv-proxy-2026';

    const res = await fetch(`${proxyUrl}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-proxy-key': proxyKey,
      },
      body: JSON.stringify({ email, apiKey: config.DEBOUNCE_API_KEY ?? config.BOUNCER_API_KEY ?? config.MILLIONVERIFIER_API_KEY }),
      signal: AbortSignal.timeout(20_000),
    });

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

    logger.info({ email, code: data.debounce?.code, result: data.debounce?.result }, 'DeBounce response');

    if (!data.debounce || data.success !== '1') {
      return notChecked(data.error ?? 'DeBounce verification failed');
    }

    const code = data.debounce.code;

    // code 5 = Safe to Send (deliverable)
    if (code === '5') {
      return {
        checked:     true,
        reachable:   true,
        isCatchAll:  false,
        greylisted:  false,
        fromCache:   false,
        rawResponse: null,
        error:       null,
      };
    }

    // code 6 = Risky (catch-all or low quality)
    if (code === '6') {
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

    // code 8 = Do Not Send (undeliverable)
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

    // code 7 = Unknown
    return notChecked('smtp_unknown');

  } catch (err) {
    logger.error({ err, email }, 'MillionVerifier API call failed');
    return notChecked('API unreachable');
  }
}

function notChecked(error: string): SmtpCacheResult {
  return { checked: false, reachable: null, isCatchAll: null, greylisted: false, fromCache: false, rawResponse: '', error };
}
