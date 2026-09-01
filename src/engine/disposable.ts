import fs from 'node:fs';
import path from 'node:path';
import { getRegistrableDomain, normalizeDomain } from './domain.js';
import { logger } from '../lib/logger.js';

const BLOCKLIST_PATH = path.resolve(process.cwd(), 'data/disposable-domains.txt');

// The loaded domain set. null = not yet loaded.
let _domainSet: Set<string> | null = null;
// Separate set for wildcard patterns (stored without leading "*.")
let _wildcardSet: Set<string> | null = null;
let _loadAttempted = false;

/**
 * Load the disposable domain blocklist into memory.
 * Idempotent — subsequent calls are no-ops.
 *
 * Lines starting with "#" are comments.
 * Lines starting with "*." are wildcard entries that match any subdomain.
 * All other lines are exact domain matches (checked against both the full
 * domain and its registrable parent).
 */
export function loadDisposableList(): void {
  if (_loadAttempted) return;
  _loadAttempted = true;
  readBlocklistFromDisk();
}

/**
 * Force a re-read of the blocklist file into memory, replacing whatever is
 * currently loaded. Used by the scheduled refresh job so a freshly-fetched
 * upstream list takes effect without a process restart.
 */
export function reloadDisposableList(): void {
  readBlocklistFromDisk();
}

function readBlocklistFromDisk(): void {
  if (!fs.existsSync(BLOCKLIST_PATH)) {
    logger.warn(
      { path: BLOCKLIST_PATH },
      'Disposable domain blocklist not found — detection disabled. ' +
        'Run: npx tsx scripts/update-disposable-list.ts',
    );
    _domainSet  = new Set();
    _wildcardSet = new Set();
    return;
  }

  try {
    const raw = fs.readFileSync(BLOCKLIST_PATH, 'utf-8');
    const exact    = new Set<string>();
    const wildcard = new Set<string>();

    for (const rawLine of raw.split('\n')) {
      const line = rawLine.trim().toLowerCase();
      if (line.length === 0 || line.startsWith('#')) continue;

      if (line.startsWith('*.')) {
        wildcard.add(line.slice(2));  // store without "*."
      } else {
        exact.add(line);
      }
    }

    _domainSet  = exact;
    _wildcardSet = wildcard;

    logger.info(
      { exact: exact.size, wildcard: wildcard.size },
      'Disposable domain blocklist loaded',
    );
  } catch (err) {
    logger.error({ err, path: BLOCKLIST_PATH }, 'Failed to load disposable domain blocklist');
    _domainSet  = new Set();
    _wildcardSet = new Set();
  }
}

/**
 * Returns true if the domain should be considered disposable.
 *
 * Check order:
 *   1. Exact match on the full domain
 *   2. Exact match on the registrable domain (catches subdomain variants)
 *   3. Wildcard match: is any suffix of the domain in the wildcard set?
 */
export function isDisposableDomain(domain: string): boolean {
  const exact    = getExactSet();
  const wildcard = getWildcardSet();

  if (exact.size === 0) return false;

  const normalized   = normalizeDomain(domain);
  const registrable  = getRegistrableDomain(normalized);

  // 1. Exact match on full domain
  if (exact.has(normalized)) return true;

  // 2. Exact match on registrable domain
  if (registrable !== normalized && exact.has(registrable)) return true;

  // 3. Wildcard match — check if any suffix is in the wildcard set
  if (wildcard.size > 0) {
    const labels = normalized.split('.');
    for (let i = 1; i < labels.length; i++) {
      const suffix = labels.slice(i).join('.');
      if (wildcard.has(suffix)) return true;
    }
  }

  return false;
}

export function getBlocklistStats(): { exact: number; wildcard: number } {
  return {
    exact:    getExactSet().size,
    wildcard: getWildcardSet().size,
  };
}

// ─── Lazy loaders ─────────────────────────────────────────────────────────────

function getExactSet(): Set<string> {
  if (!_domainSet) loadDisposableList();
  return _domainSet ?? new Set();
}

function getWildcardSet(): Set<string> {
  if (!_wildcardSet) loadDisposableList();
  return _wildcardSet ?? new Set();
}
