/**
 * Look-alike / typosquat domain detection.
 *
 * Flags domains that are suspiciously close to a major mailbox provider —
 * either by edit distance ("gmial.com"), homoglyph substitution
 * ("gmaiI.com" with a capital i, "rnicrosoft.com" with rn/m), or by nesting
 * the real brand as a subdomain label ahead of an unrelated registrable
 * domain ("outlook.com.login-verify.ru"). None of this depends on a
 * third-party API — it's a static reference list plus string comparison,
 * evaluated locally in the same process as syntax/MX checks.
 *
 * This does NOT flag every domain a sender might legitimately use (e.g.
 * a company's own corporate domain) — only domains that are deceptively
 * close to one of the handful of providers that dominate real-world
 * mailbox volume, where a near-miss is far more likely to be a typo or a
 * phishing/spoofing attempt than a coincidence.
 */

// Major mailbox providers worth protecting against typosquats. Kept to
// providers with enough real-world share that a look-alike is actually
// likely to fool someone, not an exhaustive brand list.
const PROTECTED_DOMAINS = [
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'protonmail.com', 'proton.me', 'gmx.com', 'gmx.de',
  'zoho.com', 'yandex.com', 'yandex.ru', 'mail.com', 'mail.ru',
  'fastmail.com', 'rediffmail.com', 'qq.com', '163.com', '126.com',
  'naver.com', 'daum.net', 'comcast.net', 'verizon.net', 'att.net',
] as const;

// Homoglyph normalization — collapse characters commonly substituted in
// typosquats to the character they're impersonating, so "gmaiI.com"
// (capital I) and "gmail.com" normalize to the same string.
const HOMOGLYPH_MAP: Record<string, string> = {
  '0': 'o', '1': 'l', '!': 'i', '|': 'l',
  '5': 's', '3': 'e', '@': 'a', '$': 's',
};

// Distinctive brand names worth checking for subdomain-nesting tricks
// ("gmail.com.verify-account.ru"). Deliberately a subset of PROTECTED_DOMAINS
// — generic dictionary words like "mail", "live", or "me" show up constantly
// as legitimate subdomain labels (mail.acmecorp.com) with zero connection to
// the provider of the same name, so nesting detection on them would be
// mostly false positives. Edit-distance and homoglyph checks below still
// run against the full PROTECTED_DOMAINS list, since those require a
// near-exact whole-domain match and don't have the same false-positive risk.
const NESTING_BRANDS = new Set([
  'gmail', 'googlemail', 'yahoo', 'outlook', 'hotmail', 'icloud',
  'protonmail', 'yandex', 'rediffmail', 'fastmail',
]);

function normalizeHomoglyphs(s: string): string {
  let out = s.toLowerCase();
  for (const [from, to] of Object.entries(HOMOGLYPH_MAP)) {
    out = out.split(from).join(to);
  }
  // rn -> m and vv -> w are two-character substitutions that read as a
  // single character at a glance — collapse them after the 1:1 map.
  out = out.replace(/rn/g, 'm').replace(/vv/g, 'w');
  return out;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,      // deletion
        curr[j - 1] + 1,  // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

export interface LookalikeResult {
  isLookalike: boolean;
  impersonates: string | null;
  reason: 'edit_distance' | 'homoglyph' | 'subdomain_nesting' | null;
}

export function checkLookalike(domain: string): LookalikeResult {
  const lower = domain.toLowerCase();

  // Exact match to a protected domain is legitimate, not a look-alike.
  if ((PROTECTED_DOMAINS as readonly string[]).includes(lower)) {
    return { isLookalike: false, impersonates: null, reason: null };
  }

  // ── Subdomain nesting: a distinctive brand name appears as one of the
  // domain's labels, but the domain's actual registrable suffix is
  // something else entirely, e.g. "gmail.com.account-verify.ru" (labels:
  // gmail / com / account-verify / ru — "com" here is just a label, not
  // the TLD) or "login-outlook.security-check.net".
  //
  // A real subdomain of the brand's own domain — "mail.gmail.com" — is
  // excluded by checking the domain's actual trailing labels against the
  // protected domain, not by substring search (which a decoy domain can
  // trivially satisfy by embedding the brand's full domain up front).
  const labels = lower.split('.');
  for (const protectedDomain of PROTECTED_DOMAINS) {
    const brand = protectedDomain.split('.')[0]!; // "gmail", "outlook", ...
    if (!NESTING_BRANDS.has(brand)) continue;

    const protectedLabels = protectedDomain.split('.');
    const trailingSuffix = labels.slice(-protectedLabels.length).join('.');
    const isRealSubdomain = trailingSuffix === protectedDomain;
    if (isRealSubdomain) continue;

    if (labels.includes(brand)) {
      return { isLookalike: true, impersonates: protectedDomain, reason: 'subdomain_nesting' };
    }
  }

  // ── Edit distance + homoglyph match against each protected domain.
  const normalized = normalizeHomoglyphs(lower);
  for (const protectedDomain of PROTECTED_DOMAINS) {
    if (lower === protectedDomain) continue;

    // Raw edit distance catches simple typos: gmial.com, gmai.com, gmaill.com
    const rawDist = levenshtein(lower, protectedDomain);
    const threshold = protectedDomain.length <= 8 ? 1 : 2;
    if (rawDist > 0 && rawDist <= threshold) {
      return { isLookalike: true, impersonates: protectedDomain, reason: 'edit_distance' };
    }

    // Homoglyph-normalized exact match catches character substitution:
    // gma1l.com, rnicrosoft.com-style tricks on any protected domain that
    // itself contains "m", vv/rn tricks, etc.
    if (normalized === protectedDomain && lower !== protectedDomain) {
      return { isLookalike: true, impersonates: protectedDomain, reason: 'homoglyph' };
    }
  }

  return { isLookalike: false, impersonates: null, reason: null };
}
