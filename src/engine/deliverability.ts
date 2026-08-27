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

// Major DNS blacklists — IP-based (DNSBL)
const IP_BLACKLISTS = [
  { name: 'Spamhaus ZEN',        suffix: 'zen.spamhaus.org' },
  { name: 'Spamhaus SBL',        suffix: 'sbl.spamhaus.org' },
  { name: 'Spamhaus XBL',        suffix: 'xbl.spamhaus.org' },
  { name: 'Barracuda',           suffix: 'b.barracudacentral.org' },
  { name: 'SORBS SPAM',          suffix: 'spam.sorbs.net' },
  { name: 'SORBS DUHL',          suffix: 'dul.sorbs.net' },
  { name: 'SpamCop',             suffix: 'bl.spamcop.net' },
  { name: 'SURBL',               suffix: 'multi.surbl.org' },
  { name: 'URIBL',               suffix: 'multi.uribl.com' },
  { name: 'NiX Spam',            suffix: 'ix.dnsbl.manitu.net' },
  { name: 'LASHBACK',            suffix: 'ubl.unsubscore.com' },
  { name: 'PSBL',                suffix: 'psbl.surriel.com' },
  { name: 'Truncate',            suffix: 'truncate.gbudb.net' },
  { name: 'WPBL',                suffix: 'db.wpbl.info' },
  { name: 'Invaluement IVMSIP',  suffix: 'sip.invaluement.com' },
];

// Domain-based blacklists (URIBL-style, lookup by domain)
const DOMAIN_BLACKLISTS = [
  { name: 'SURBL Domain',        suffix: 'multi.surbl.org' },
  { name: 'URIBL Domain',        suffix: 'multi.uribl.com' },
  { name: 'dbl.spamhaus.org',    suffix: 'dbl.spamhaus.org' },
  { name: 'Spamhaus DBL',        suffix: 'dbl.spamhaus.org' },
  { name: 'URIBL Black',         suffix: 'black.uribl.com' },
];

// Keep the old name for backward compatibility inside this module
const BLACKLISTS = IP_BLACKLISTS;

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

// ─── Comprehensive domain blacklist check (for monitoring) ────────────────────

export interface DomainBlacklistResult {
  domain: string;
  ips: string[];
  blacklisted: boolean;
  ipListings: Array<{ blacklist: string; ip: string }>;
  domainListings: string[];
  checkedAt: Date;
  totalChecked: number;
}

export async function checkDomainBlacklists(domain: string): Promise<DomainBlacklistResult> {
  const checkedAt = new Date();
  const ipListings: Array<{ blacklist: string; ip: string }> = [];
  const domainListings: string[] = [];

  let ips: string[] = [];
  try {
    ips = await dns.resolve4(domain);
  } catch { /* no A record */ }

  const checks: Array<Promise<void>> = [];

  // IP-based checks
  for (const ip of ips) {
    for (const bl of IP_BLACKLISTS) {
      checks.push((async () => {
        try {
          const reversed = ip.split('.').reverse().join('.');
          await dns.resolve4(`${reversed}.${bl.suffix}`);
          ipListings.push({ blacklist: bl.name, ip });
        } catch { /* not listed */ }
      })());
    }
  }

  // Domain-based checks
  for (const bl of DOMAIN_BLACKLISTS) {
    checks.push((async () => {
      try {
        await dns.resolve4(`${domain}.${bl.suffix}`);
        domainListings.push(bl.name);
      } catch { /* not listed */ }
    })());
  }

  await Promise.allSettled(checks);

  return {
    domain,
    ips,
    blacklisted: ipListings.length > 0 || domainListings.length > 0,
    ipListings,
    domainListings: [...new Set(domainListings)],
    checkedAt,
    totalChecked: IP_BLACKLISTS.length * ips.length + DOMAIN_BLACKLISTS.length,
  };
}
