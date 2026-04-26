import { describe, it, expect } from 'vitest';
import {
  extractDomain,
  extractLocal,
  normalizeDomain,
  getRegistrableDomain,
} from '../../engine/domain.js';

describe('extractDomain', () => {
  it('extracts domain from a simple email', () => {
    expect(extractDomain('alice@example.com')).toBe('example.com');
  });

  it('lowercases the domain', () => {
    expect(extractDomain('alice@EXAMPLE.COM')).toBe('example.com');
  });

  it('strips trailing FQDN dot', () => {
    expect(extractDomain('alice@example.com.')).toBe('example.com');
  });

  it('handles subdomain addresses', () => {
    expect(extractDomain('user@mail.example.com')).toBe('mail.example.com');
  });

  it('uses the last @ when multiple are present', () => {
    // Technically invalid, but extractDomain should be robust
    expect(extractDomain('"user@domain"@example.com')).toBe('example.com');
  });

  it('throws if no @ is present', () => {
    expect(() => extractDomain('nodomain')).toThrow('@');
  });
});

describe('extractLocal', () => {
  it('extracts and lowercases the local part', () => {
    expect(extractLocal('Alice@example.com')).toBe('alice');
  });

  it('handles plus-tag addressing', () => {
    expect(extractLocal('user+tag@example.com')).toBe('user+tag');
  });

  it('handles dots in local part', () => {
    expect(extractLocal('first.last@example.com')).toBe('first.last');
  });

  it('throws if no @ is present', () => {
    expect(() => extractLocal('noatsign')).toThrow('@');
  });
});

describe('normalizeDomain', () => {
  it('lowercases', () => {
    expect(normalizeDomain('EXAMPLE.COM')).toBe('example.com');
  });

  it('trims whitespace', () => {
    expect(normalizeDomain('  example.com  ')).toBe('example.com');
  });

  it('strips trailing dot', () => {
    expect(normalizeDomain('example.com.')).toBe('example.com');
  });

  it('handles already-normalized input', () => {
    expect(normalizeDomain('example.com')).toBe('example.com');
  });
});

describe('getRegistrableDomain', () => {
  it('returns domain as-is when it has exactly two labels', () => {
    expect(getRegistrableDomain('example.com')).toBe('example.com');
  });

  it('strips one subdomain level', () => {
    expect(getRegistrableDomain('mail.example.com')).toBe('example.com');
  });

  it('strips multiple subdomain levels', () => {
    expect(getRegistrableDomain('a.b.c.example.com')).toBe('example.com');
  });

  it('handles two-part TLD co.uk correctly', () => {
    expect(getRegistrableDomain('example.co.uk')).toBe('example.co.uk');
  });

  it('strips subdomain with co.uk TLD', () => {
    expect(getRegistrableDomain('mail.example.co.uk')).toBe('example.co.uk');
  });

  it('handles com.au', () => {
    expect(getRegistrableDomain('user.example.com.au')).toBe('example.com.au');
  });

  it('handles com.br', () => {
    expect(getRegistrableDomain('lists.empresa.com.br')).toBe('empresa.com.br');
  });

  it('handles co.in', () => {
    expect(getRegistrableDomain('mail.company.co.in')).toBe('company.co.in');
  });

  it('returns the domain unchanged for single-label (edge case)', () => {
    expect(getRegistrableDomain('localhost')).toBe('localhost');
  });

  it('normalizes before computing', () => {
    expect(getRegistrableDomain('MAIL.EXAMPLE.COM')).toBe('example.com');
  });

  // Disposable domain matching relies on this for subdomain variants
  it('maps mail.mailinator.com to mailinator.com', () => {
    expect(getRegistrableDomain('mail.mailinator.com')).toBe('mailinator.com');
  });

  it('maps lists.guerrillamail.com to guerrillamail.com', () => {
    expect(getRegistrableDomain('lists.guerrillamail.com')).toBe('guerrillamail.com');
  });
});
