import { describe, it, expect } from 'vitest';
import { checkLookalike } from '../../engine/lookalike.js';

describe('checkLookalike', () => {
  it('does not flag exact protected domains', () => {
    expect(checkLookalike('gmail.com').isLookalike).toBe(false);
    expect(checkLookalike('outlook.com').isLookalike).toBe(false);
  });

  it('does not flag unrelated legitimate domains', () => {
    expect(checkLookalike('acme.com').isLookalike).toBe(false);
    expect(checkLookalike('continuumapi.com').isLookalike).toBe(false);
  });

  it('flags single-character typos by edit distance', () => {
    const r = checkLookalike('gmial.com');
    expect(r.isLookalike).toBe(true);
    expect(r.impersonates).toBe('gmail.com');
    expect(r.reason).toBe('edit_distance');
  });

  it('flags dropped-letter typos', () => {
    expect(checkLookalike('gmai.com').isLookalike).toBe(true);
    expect(checkLookalike('outlok.com').isLookalike).toBe(true);
  });

  it('flags homoglyph substitution', () => {
    const r = checkLookalike('gma1l.com');
    expect(r.isLookalike).toBe(true);
    expect(r.impersonates).toBe('gmail.com');
  });

  it('flags rn/m substitution', () => {
    // "corn" contains "rn", which reads as "m" at a glance — a classic
    // typosquat of yahoo.com (also within edit-distance-1, so either
    // detector catching it is a correct outcome).
    const r = checkLookalike('yahoo.corn');
    expect(r.isLookalike).toBe(true);
    expect(r.impersonates).toBe('yahoo.com');
  });

  it('flags subdomain nesting that impersonates a brand', () => {
    const r = checkLookalike('gmail.com.account-verify.ru');
    expect(r.isLookalike).toBe(true);
    expect(r.impersonates).toBe('gmail.com');
    expect(r.reason).toBe('subdomain_nesting');
  });

  it('does not flag a real subdomain of the protected domain itself', () => {
    // Not realistic for consumer webmail providers, but the detector should
    // not misfire on legitimate same-domain subdomains in general.
    expect(checkLookalike('mail.gmail.com').isLookalike).toBe(false);
  });

  it('does not flag domains that merely contain a short brand-like substring', () => {
    // "aol" is intentionally excluded from nesting checks via length guard
    // to avoid flagging every domain containing common short substrings.
    expect(checkLookalike('aolympics.com').isLookalike).toBe(false);
  });
});
