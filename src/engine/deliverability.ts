/**
 * Deliverability checks — DNS-based domain health analysis
 * 
 * Checks per domain (cached to avoid repeat lookups for bulk jobs):
 *   - SPF record exists and is valid
 *   - DMARC record exists
 *   - DKIM common selectors found
 *   - Domain blacklist check (Spamhaus ZEN, Barracuda, SORBS)
 */

import dns from 'node:dns/promises';
import { logger } from '../lib/logger.js';

export interface DeliverabilityResult {
  spfValid:       boolean;
  spfRecord:      string | null;
  dmarcValid:     boolean;
  dmarcRecord:    string | null;
  blacklisted:    boolean;
  blacklists:     string[];
  dkimFound:      boolean;
  dkimSelectors:  string[];
}

// Common DKIM selectors used by major providers
const DKIM_SELECTORS = [
  'google', 'selector1', 'selector2', 'k1', 'mail',
  'smtp', 'default', 'dkim', 's1', 's2', 'email',
  'mailjet', 'mandrill', 'sendgrid', 'amazonses',
];

// Major DNS blacklists
const BLACKLISTS = [
  { name: 'Spamhaus ZEN',   suffix: 'zen.spamhaus.org' },
  { name: 'Barracuda',      suffix: 'b.barracudacentral.org' },
  { name: 'SORBS SPAM',     suffix: 'spam.sorbs.net' },
  { name: 'SpamCop',        suffix: 'bl.spamcop.net' },
];

// Cache to avoid redundant DNS lookups for same domain in bulk jobs
const domainCache = new Map<string, DeliverabilityResult>();

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))
  ]);
}

export async function checkDeliverability(domain: string): Promise<DeliverabilityResult> {
  if (domainCache.has(domain)) {
    return domainCache.get(domain)!;
  }

  const fallbackSpf   = { valid: false, record: null };
  const fallbackDmarc = { valid: false, record: null };
  const fallbackDkim  = { found: false, selectors: [] };
  const fallbackBl    = { blacklisted: false, lists: [] };

  const [spf, dmarc, dkim, blacklist] = await Promise.allSettled([
    withTimeout(checkSpf(domain),        3000, fallbackSpf),
    withTimeout(checkDmarc(domain),      3000, fallbackDmarc),
    withTimeout(checkDkim(domain),       3000, fallbackDkim),
    withTimeout(checkBlacklists(domain), 3000, fallbackBl),
  ]);

  const result: DeliverabilityResult = {
    spfValid:      spf.status === 'fulfilled' ? spf.value.valid : false,
    spfRecord:     spf.status === 'fulfilled' ? spf.value.record : null,
    dmarcValid:    dmarc.status === 'fulfilled' ? dmarc.value.valid : false,
    dmarcRecord:   dmarc.status === 'fulfilled' ? dmarc.value.record : null,
    dkimFound:     dkim.status === 'fulfilled' ? dkim.value.found : false,
    dkimSelectors: dkim.status === 'fulfilled' ? dkim.value.selectors : [],
    blacklisted:   blacklist.status === 'fulfilled' ? blacklist.value.blacklisted : false,
    blacklists:    blacklist.status === 'fulfilled' ? blacklist.value.lists : [],
  };

  // Cache for 1 hour
  domainCache.set(domain, result);
  setTimeout(() => domainCache.delete(domain), 3_600_000);

  return result;
}

// ─── SPF ──────────────────────────────────────────────────────────────────────

async function checkSpf(domain: string): Promise<{ valid: boolean; record: string | null }> {
  try {
    const records = await dns.resolveTxt(domain);
    for (const parts of records) {
      const record = parts.join('');
      if (record.toLowerCase().startsWith('v=spf1')) {
        return { valid: true, record };
      }
    }
    return { valid: false, record: null };
  } catch {
    return { valid: false, record: null };
  }
}

// ─── DMARC ────────────────────────────────────────────────────────────────────

async function checkDmarc(domain: string): Promise<{ valid: boolean; record: string | null }> {
  try {
    const records = await dns.resolveTxt(`_dmarc.${domain}`);
    for (const parts of records) {
      const record = parts.join('');
      if (record.toLowerCase().startsWith('v=dmarc1')) {
        return { valid: true, record };
      }
    }
    return { valid: false, record: null };
  } catch {
    return { valid: false, record: null };
  }
}

// ─── DKIM ─────────────────────────────────────────────────────────────────────

async function checkDkim(domain: string): Promise<{ found: boolean; selectors: string[] }> {
  const found: string[] = [];

  await Promise.allSettled(
    DKIM_SELECTORS.map(async (selector) => {
      try {
        const records = await dns.resolveTxt(`${selector}._domainkey.${domain}`);
        if (records.length > 0) {
          const record = records[0]?.join('') ?? '';
          if (record.toLowerCase().includes('v=dkim1') || record.toLowerCase().includes('p=')) {
            found.push(selector);
          }
        }
      } catch {
        // No DKIM for this selector — normal
      }
    })
  );

  return { found: found.length > 0, selectors: found };
}

// ─── Blacklist ────────────────────────────────────────────────────────────────

async function checkBlacklists(domain: string): Promise<{ blacklisted: boolean; lists: string[] }> {
  const listed: string[] = [];

  // Resolve domain to IP for IP-based blacklist checks
  let ips: string[] = [];
  try {
    const addresses = await dns.resolve4(domain);
    ips = addresses;
  } catch {
    // Can't resolve — skip IP blacklist check
  }

  if (ips.length === 0) {
    return { blacklisted: false, lists: [] };
  }

  // Check each IP against each blacklist
  await Promise.allSettled(
    ips.flatMap(ip =>
      BLACKLISTS.map(async (bl) => {
        try {
          // Reverse the IP octets for DNSBL lookup
          const reversed = ip.split('.').reverse().join('.');
          await dns.resolve4(`${reversed}.${bl.suffix}`);
          // If resolves — IP is listed
          listed.push(bl.name);
        } catch {
          // Not listed — normal
        }
      })
    )
  );

  const unique = [...new Set(listed)];
  return { blacklisted: unique.length > 0, lists: unique };
}
