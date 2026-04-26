/**
 * Domain extraction and normalization utilities.
 *
 * Handles:
 *   - ASCII domains (standard)
 *   - Punycode-encoded IDN domains (xn-- labels) — decoded for display only;
 *     raw punycode form is what DNS actually resolves
 *   - Trailing dot removal (FQDN form)
 *   - Consistent lowercasing
 *   - eTLD+1 computation for disposable domain matching
 */

/**
 * Extract and normalize the domain part of an email address.
 * Assumes syntax.ts has already validated the email.
 */
export function extractDomain(email: string): string {
  const atIndex = email.lastIndexOf('@');
  if (atIndex === -1) {
    throw new Error(`extractDomain: no "@" found in "${email}"`);
  }
  return normalizeDomain(email.slice(atIndex + 1));
}

/**
 * Normalize a domain string to lowercase, trimmed, without trailing dot.
 */
export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * Extract the local part (before the last @), lowercased.
 */
export function extractLocal(email: string): string {
  const atIndex = email.lastIndexOf('@');
  if (atIndex === -1) {
    throw new Error(`extractLocal: no "@" found in "${email}"`);
  }
  return email.slice(0, atIndex).toLowerCase();
}

/**
 * Compute the registrable domain (eTLD+1) for a given domain.
 *
 * Used when matching against the disposable blocklist so that
 * "mail.mailinator.com" matches the blocklisted "mailinator.com".
 *
 * This is a hand-maintained approximation of the Public Suffix List.
 * For a production system that needs complete PSL coverage, replace
 * with the `tldts` or `psl` npm package.
 *
 * Examples:
 *   mail.example.com    → example.com
 *   lists.gmail.com     → gmail.com
 *   user.co.uk          → user.co.uk   (two-part TLD, needs 3 labels)
 *   a.b.example.co.uk   → example.co.uk
 */
export function getRegistrableDomain(domain: string): string {
  const normalized = normalizeDomain(domain);
  const labels = normalized.split('.');

  if (labels.length <= 2) return normalized;

  const lastTwo = labels.slice(-2).join('.');

  if (KNOWN_TWO_PART_TLDS.has(lastTwo)) {
    // Need 3 labels: <registrable>.<second-level>.<tld>
    if (labels.length >= 3) return labels.slice(-3).join('.');
    return normalized;
  }

  return labels.slice(-2).join('.');
}

/**
 * Strip subdomains to get the base domain used for SMTP connections.
 * Same as getRegistrableDomain but we expose it separately for clarity.
 */
export function getSmtpDomain(domain: string): string {
  return getRegistrableDomain(domain);
}

// ─── Known two-part TLDs ─────────────────────────────────────────────────────

const KNOWN_TWO_PART_TLDS = new Set([
  // United Kingdom
  'co.uk', 'me.uk', 'org.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk',
  'ac.uk', 'gov.uk', 'nhs.uk', 'police.uk', 'mod.uk',
  // Australia
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
  // Brazil
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br', 'mil.br',
  // India
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in', 'nic.in',
  // Japan
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'ad.jp', 'ed.jp',
  // New Zealand
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz', 'school.nz',
  // South Africa
  'co.za', 'net.za', 'org.za', 'gov.za', 'ac.za', 'web.za',
  // Singapore
  'com.sg', 'net.sg', 'org.sg', 'gov.sg', 'edu.sg',
  // Hong Kong
  'com.hk', 'net.hk', 'org.hk', 'gov.hk', 'edu.hk', 'idv.hk',
  // Argentina
  'com.ar', 'net.ar', 'org.ar', 'gov.ar', 'edu.ar',
  // Mexico
  'com.mx', 'net.mx', 'org.mx', 'gob.mx', 'edu.mx',
  // Kenya
  'co.ke', 'net.ke', 'org.ke', 'go.ke', 'ac.ke',
  // Tanzania
  'co.tz', 'net.tz', 'org.tz', 'go.tz', 'ac.tz',
  // Pakistan
  'com.pk', 'net.pk', 'org.pk', 'gov.pk', 'edu.pk',
  // Colombia
  'com.co', 'net.co', 'org.co', 'gov.co', 'edu.co',
]);
