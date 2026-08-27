/**
 * Toxic/abuse email domain detection.
 *
 * Flags domains that are:
 * - Known abuse/spam-trap domains
 * - Associated with known complainers
 * - High-risk TLDs with no legitimate email use
 * - Temporary/anonymous forwarding services
 *
 * Unlike disposable (single-use inboxes), toxic means the ADDRESS EXISTS
 * but sending to it will hurt your sender reputation — either because it's
 * a spam trap, a known complainer, or a pristine trap seeded by blacklist orgs.
 */

// Known toxic/spam-trap domain patterns (domain suffix match)
const TOXIC_DOMAINS = new Set([
  // Pristine spam traps (never signed up anywhere)
  'spamtrap.ro', 'spamtrap.net', 'spam.la', 'spamgourmet.com',
  'spamgourmet.net', 'spamgourmet.org', 'spaml.de', 'spamtraps.de',
  // Known abuse seeding domains
  'abuse.ch', 'abuse.io', 'spamcop.net',
  // Honey pot domains used by anti-spam orgs
  'spambouncers.net', 'spambouncer.org', 'nullbox.info',
  // Known for very high complaint rates
  'dodgit.com', 'spam4.me', 'rejectmail.com', 'nomail.pw',
  'trbvm.com', 'binkmail.com', 'tempr.email', 'spam.su',
]);

// Known abuser/complainer TLDs — email from these generates disproportionate complaints
const ABUSE_TLDS = new Set([
  '.cf', '.ga', '.gq', '.ml', '.tk', // Freenom TLDs with near-zero legitimate use
]);

// Patterns that indicate likely spam-trap usage (regex match on full domain)
const TOXIC_PATTERNS = [
  /^(spam|trap|abuse|honeypot|spamtrap)\./i,
  /\.(spam|trap|abuse)$/i,
];

export interface ToxicCheckResult {
  isToxic: boolean;
  isAbuse: boolean;
  reason:  string | null;
}

export function checkToxic(domain: string): ToxicCheckResult {
  const lower = domain.toLowerCase();

  // Exact domain match against known toxic list
  if (TOXIC_DOMAINS.has(lower)) {
    return { isToxic: true, isAbuse: false, reason: 'known_toxic_domain' };
  }

  // TLD check for known abuser registries
  for (const tld of ABUSE_TLDS) {
    if (lower.endsWith(tld)) {
      return { isToxic: false, isAbuse: true, reason: 'high_complaint_tld' };
    }
  }

  // Pattern match
  for (const pattern of TOXIC_PATTERNS) {
    if (pattern.test(lower)) {
      return { isToxic: true, isAbuse: false, reason: 'toxic_pattern' };
    }
  }

  return { isToxic: false, isAbuse: false, reason: null };
}
