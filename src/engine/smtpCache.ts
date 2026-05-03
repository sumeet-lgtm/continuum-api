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
      body: JSON.stringify({ email, apiKey: config.MILLIONVERIFIER_API_KEY }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      logger.warn({ status: res.status, email }, 'MillionVerifier API error');
      return notChecked('API error');
    }

    const data = await res.json() as {
      email:           string;
      result:          string;
      resultcode:      number;
      subresult:       string;
      free:            number;
      role:            number;
      mailserverdomain: string;
      credits:         number;
      error?:          string;
    };

    logger.info({ email, result: data.result, resultcode: data.resultcode, credits: data.credits }, 'MillionVerifier response');

    switch (data.resultcode) {
      case MV_RESULT.OK:
        return {
          checked:     true,
          reachable:   true,
          isCatchAll:  data.subresult === 'ok_catchall' ? true : false,
          greylisted:  false,
          fromCache:   false,
          rawResponse: null,
          error:       null,
        };

      case MV_RESULT.ERROR:
      case MV_RESULT.MAILBOX_FULL:
      case MV_RESULT.NO_MAILBOX:
      case MV_RESULT.BAD:
        return {
          checked:     true,
          reachable:   false,
          isCatchAll:  false,
          greylisted:  false,
          fromCache:   false,
          rawResponse: '',
          error:       null,
        };

      case MV_RESULT.DISPOSABLE:
        return {
          checked:     true,
          reachable:   false,
          isCatchAll:  false,
          greylisted:  false,
          fromCache:   false,
          rawResponse: '',
          error:       'disposable_email',
        };

      case MV_RESULT.UNKNOWN:
        return notChecked('smtp_unknown');
      
      default:
        // Fallback — use result string if code is unrecognized
        if (data.result === 'ok') {
          return { checked: true, reachable: true, isCatchAll: data.subresult?.includes('catchall') ?? false, greylisted: false, fromCache: false, rawResponse: null, error: null };
        }
        if (data.result === 'invalid' || data.result === 'error') {
          return { checked: true, reachable: false, isCatchAll: false, greylisted: false, fromCache: false, rawResponse: null, error: null };
        }
        return notChecked('smtp_unknown');
    }

  } catch (err) {
    logger.error({ err, email }, 'MillionVerifier API call failed');
    return notChecked('API unreachable');
  }
}

function notChecked(error: string): SmtpCacheResult {
  return { checked: false, reachable: null, isCatchAll: null, greylisted: false, fromCache: false, rawResponse: '', error };
}
