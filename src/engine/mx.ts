import dns from 'node:dns/promises';
import type { MxLookupResult } from '../types/verification.js';
import { logger } from '../lib/logger.js';

const MX_LOOKUP_TIMEOUT_MS = 5_000;
const MX_LOOKUP_RETRIES    = 2;
const RETRY_DELAY_BASE_MS  = 150;

// In-process TTL cache: domain → { result, expiresAt }
// Prevents hammering the same domain in bulk runs.
// TTL is intentionally short — 5 minutes — so transient DNS failures
// don't poison results across a long-running job.
interface CacheEntry {
  result: MxLookupResult;
  expiresAt: number;
}
const mxCache = new Map<string, CacheEntry>();
const MX_CACHE_TTL_MS  = 5 * 60_000; // 5 minutes
const MX_CACHE_MAX_SIZE = 10_000;

/**
 * Look up MX records for a domain with TTL-based in-process caching.
 *
 * Records are sorted by priority ascending (lowest number = highest priority).
 * On ENOTFOUND / ENODATA → returns found=false, error=null (definitive negative).
 * On timeout or transient errors → retries up to MX_LOOKUP_RETRIES times.
 */
export async function lookupMx(domain: string): Promise<MxLookupResult> {
  const cached = getCached(domain);
  if (cached) return cached;

  const result = await lookupMxUncached(domain);
  setCached(domain, result);
  return result;
}

async function lookupMxUncached(domain: string): Promise<MxLookupResult> {
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= MX_LOOKUP_RETRIES; attempt++) {
    try {
      const records = await withTimeout(
        dns.resolveMx(domain),
        MX_LOOKUP_TIMEOUT_MS,
        `MX lookup timed out after ${MX_LOOKUP_TIMEOUT_MS}ms`,
      );

      if (!records || records.length === 0) {
        return { found: false, records: [], error: null };
      }

      const sorted = [...records]
        .sort((a, b) => a.priority - b.priority)
        .map((r) => r.exchange.replace(/\.$/, '').toLowerCase())
        .filter((host) => host.length > 0 && host !== '.');

      if (sorted.length === 0) {
        // Edge case: all records had empty exchange fields
        return { found: false, records: [], error: null };
      }

      return { found: true, records: sorted, error: null };

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (isDefinitiveNegative(err)) {
        return { found: false, records: [], error: null };
      }

      lastError = message;
      logger.debug({ domain, attempt, error: message }, 'MX lookup error — retrying');

      if (attempt < MX_LOOKUP_RETRIES) {
        await sleep(RETRY_DELAY_BASE_MS * attempt);
      }
    }
  }

  return {
    found: false,
    records: [],
    error: lastError ?? 'MX lookup failed after retries',
  };
}

/**
 * Check whether a domain resolves at all (A or AAAA record).
 * Used to distinguish "domain exists but configured with no MX" from
 * "domain simply doesn't exist".
 * 
 * A domain with an A record but no MX may still accept email via the
 * implicit MX rule (RFC 5321 §5.1), but this is extremely rare in practice
 * and we do not attempt to probe it — we return mxFound=false.
 */
export async function domainExistsInDns(domain: string): Promise<boolean> {
  for (const type of ['A', 'AAAA'] as const) {
    try {
      await withTimeout(dns.resolve(domain, type), 3_000, 'DNS resolve timed out');
      return true;
    } catch {
      // Try next record type
    }
  }
  return false;
}

/**
 * Evict all entries from the MX cache.
 * Used in tests and to force fresh lookups after blocklist updates.
 */
export function clearMxCache(): void {
  mxCache.clear();
}

export function getMxCacheStats(): { size: number; maxSize: number } {
  return { size: mxCache.size, maxSize: MX_CACHE_MAX_SIZE };
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

function getCached(domain: string): MxLookupResult | null {
  const entry = mxCache.get(domain);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    mxCache.delete(domain);
    return null;
  }
  return entry.result;
}

function setCached(domain: string, result: MxLookupResult): void {
  // Evict oldest entry if at capacity (FIFO approximation)
  if (mxCache.size >= MX_CACHE_MAX_SIZE) {
    const firstKey = mxCache.keys().next().value;
    if (firstKey !== undefined) mxCache.delete(firstKey);
  }
  mxCache.set(domain, { result, expiresAt: Date.now() + MX_CACHE_TTL_MS });
}

// ─── DNS error classification ─────────────────────────────────────────────────

/**
 * DNS error codes that definitively mean "this domain has no MX records" —
 * retrying will not help.
 */
function isDefinitiveNegative(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return (
    code === 'ENOTFOUND'  || // Domain does not exist in DNS
    code === 'ENODATA'    || // Domain exists but no records of this type
    code === 'ESERVFAIL'  || // Authoritative server returned SERVFAIL
    code === 'EREFUSED'   || // DNS server refused the query
    code === 'ENOTIMP'    || // DNS feature not implemented
    code === 'EBADNAME'      // Malformed domain name
  );
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (val)         => { clearTimeout(timer); resolve(val); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
