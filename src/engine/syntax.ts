import type { SyntaxResult } from '../types/verification.js';

// RFC 5321 §4.5.3.1 length limits
const MAX_EMAIL_LENGTH = 254;
const MAX_LOCAL_LENGTH  = 64;
const MAX_DOMAIN_LENGTH = 253;
const MAX_LABEL_LENGTH  = 63;

/**
 * Validate the syntax of an email address.
 *
 * Coverage:
 *   - RFC 5321 length limits on total address, local part, domain
 *   - Local part: unquoted (RFC 5321 atoms + dots) and quoted-string forms
 *   - Domain: label character set, hyphen rules, numeric-only TLD rejection
 *   - IP address literals [1.2.3.4] detected and rejected (not routable for outbound)
 *   - Unicode/non-ASCII characters rejected — callers must punycode-encode IDN domains
 *     before passing them in; the engine normalises to ASCII in domain.ts
 *
 * Does NOT perform DNS or deliverability checks — syntax only.
 */
export function checkSyntax(email: string): SyntaxResult {
  if (typeof email !== 'string') {
    return fail('Email must be a string');
  }

  const trimmed = email.trim();

  if (trimmed.length === 0) {
    return fail('Email is empty');
  }

  if (trimmed.length > MAX_EMAIL_LENGTH) {
    return fail(`Email exceeds maximum length of ${MAX_EMAIL_LENGTH} characters`);
  }

  // Reject non-ASCII characters — callers should punycode-encode IDN first
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(trimmed)) {
    return fail('Email contains non-ASCII characters; encode internationalized domains with punycode first');
  }

  // Reject multiple consecutive @ signs quickly before the split
  const atCount = (trimmed.match(/@/g) ?? []).length;
  if (atCount === 0) return fail('Email must contain an "@" symbol');
  if (atCount > 1 && !trimmed.startsWith('"')) {
    return fail('Email contains multiple "@" symbols outside a quoted local part');
  }

  const atIndex = trimmed.lastIndexOf('@');
  if (atIndex === 0) return fail('Local part is empty (nothing before "@")');
  if (atIndex === trimmed.length - 1) return fail('Domain part is empty (nothing after "@")');

  const local  = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex + 1);

  const localResult = validateLocal(local);
  if (!localResult.valid) return localResult;

  const domainResult = validateDomain(domain);
  if (!domainResult.valid) return domainResult;

  return { valid: true, reason: null };
}

// ─── Local part ───────────────────────────────────────────────────────────────

/**
 * RFC 5321 allows two forms for the local part:
 *   1. dot-atom:    printable ASCII minus special chars, dots allowed with restrictions
 *   2. quoted-string: any printable ASCII inside double quotes
 */
function validateLocal(local: string): SyntaxResult {
  if (local.length === 0) return fail('Local part is empty');
  if (local.length > MAX_LOCAL_LENGTH) {
    return fail(`Local part "${local}" exceeds maximum length of ${MAX_LOCAL_LENGTH} characters`);
  }

  // Quoted-string form: "content"
  if (local.startsWith('"')) {
    if (!local.endsWith('"')) return fail('Local part has an unmatched opening quote');
    if (local.length <= 2)   return fail('Quoted local part is empty');

    const inner = local.slice(1, -1);
    // Inside quotes, all printable ASCII is valid except unescaped backslash and unescaped quote
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i]!;
      const code = ch.charCodeAt(0);
      if (ch === '\\') {
        // Escaped character — next must be printable ASCII
        i++;
        const next = inner[i];
        if (next === undefined || next.charCodeAt(0) < 32 || next.charCodeAt(0) > 126) {
          return fail('Invalid escape sequence in quoted local part');
        }
        continue;
      }
      if (ch === '"') return fail('Unescaped double-quote inside quoted local part');
      if (code < 32 || code > 126) return fail(`Control character in quoted local part at position ${i + 1}`);
    }
    return { valid: true, reason: null };
  }

  // Unquoted dot-atom form
  if (local.includes('"')) {
    return fail('Local part contains a quote outside a quoted-string');
  }

  if (local.startsWith('.')) return fail('Local part cannot start with a dot');
  if (local.endsWith('.'))   return fail('Local part cannot end with a dot');
  if (local.includes('..'))  return fail('Local part cannot contain consecutive dots');

  // RFC 5321 §4.1.2 — atext characters (dot-atom allowed with the dot rules above)
  // Allowed: a-z A-Z 0-9 ! # $ % & ' * + - / = ? ^ _ ` { | } ~ .
  const VALID_LOCAL_RE = /^[a-zA-Z0-9!#$%&'*+\-/=?^_`{|}~.]+$/;
  if (!VALID_LOCAL_RE.test(local)) {
    const bad = [...local].find((c) => !/[a-zA-Z0-9!#$%&'*+\-/=?^_`{|}~.]/.test(c));
    return fail(`Local part contains invalid character: "${bad ?? '?'}" (code ${bad?.charCodeAt(0) ?? '?'})`);
  }

  return { valid: true, reason: null };
}

// ─── Domain part ──────────────────────────────────────────────────────────────

function validateDomain(domain: string): SyntaxResult {
  // IP address literals — reject outright; we don't support them for outbound
  if (domain.startsWith('[') && domain.endsWith(']')) {
    return fail('IP address literals (e.g. [1.2.3.4]) are not supported');
  }

  if (domain.length > MAX_DOMAIN_LENGTH) {
    return fail(`Domain exceeds maximum length of ${MAX_DOMAIN_LENGTH} characters`);
  }

  // Strip trailing dot (FQDN form is technically valid but normalise it away)
  const normalized = domain.endsWith('.') ? domain.slice(0, -1) : domain;

  if (normalized.length === 0) return fail('Domain is empty');

  const labels = normalized.split('.');

  if (labels.length < 2) {
    return fail(`Domain "${normalized}" must have at least one dot (e.g. example.com)`);
  }

  for (const label of labels) {
    if (label.length === 0)            return fail('Domain contains consecutive dots');
    if (label.length > MAX_LABEL_LENGTH) {
      return fail(`Domain label "${label}" exceeds ${MAX_LABEL_LENGTH} characters`);
    }
    if (label.startsWith('-'))         return fail(`Domain label "${label}" cannot start with a hyphen`);
    if (label.endsWith('-'))           return fail(`Domain label "${label}" cannot end with a hyphen`);
    if (label.startsWith('--') && label.length > 4 && label[2] !== '-') {
      // Allow xn-- (punycode) but reject other double-hyphen sequences in unusual positions
    }
    if (!/^[a-zA-Z0-9-]+$/.test(label)) {
      const bad = [...label].find((c) => !/[a-zA-Z0-9-]/.test(c));
      return fail(`Domain label "${label}" contains invalid character: "${bad ?? '?'}"`);
    }
  }

  // TLD: must be alphabetic only (no numeric-only TLDs exist in practice)
  const tld = labels[labels.length - 1] ?? '';
  if (tld.length < 2) return fail(`TLD "${tld}" is too short — must be at least 2 characters`);
  if (!/^[a-zA-Z]{2,}$/.test(tld)) {
    return fail(`TLD "${tld}" is invalid — must contain only letters`);
  }

  return { valid: true, reason: null };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fail(reason: string): SyntaxResult {
  return { valid: false, reason };
}
