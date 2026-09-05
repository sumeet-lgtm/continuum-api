import { describe, it, expect } from 'vitest';
import { generateDkimKeyPair, pemToRawBase64, decryptPrivateKey } from '../../lib/dkim.js';

// SES's BYODKIM DomainSigningPrivateKey field validates against this exact
// pattern server-side — passing the full PEM string (with -----BEGIN/END
// headers and newlines) fails it on every call. This was silently caught
// and swallowed by every call site, meaning no domain ever actually
// registered with SES for its whole history. Found live 2026-09-05 while
// investigating why wyberai.com's DKIM was stuck "pending" despite
// correct DNS records: SES had no record of the domain at all.
const SES_RAW_KEY_PATTERN = /^[a-zA-Z0-9+/]+={0,2}$/;

describe('pemToRawBase64', () => {
  it('strips PEM headers, footers, and newlines from a real generated private key', () => {
    const kp = generateDkimKeyPair('test-secret');
    const raw = pemToRawBase64(kp.rawPrivateKey);

    expect(raw).not.toMatch(/BEGIN|END|PRIVATE KEY/);
    expect(raw).not.toMatch(/[\r\n]/);
    expect(SES_RAW_KEY_PATTERN.test(raw)).toBe(true);
  });

  it('strips PEM headers/footers from a public key too (same format family)', () => {
    const kp = generateDkimKeyPair('test-secret');
    const raw = pemToRawBase64(kp.publicKey);

    expect(raw).not.toMatch(/BEGIN|END|PUBLIC KEY/);
    expect(SES_RAW_KEY_PATTERN.test(raw)).toBe(true);
  });

  it('round-trips through encrypt/decrypt and still satisfies the SES pattern', () => {
    const secret = 'another-test-secret';
    const kp = generateDkimKeyPair(secret);
    const decrypted = decryptPrivateKey(kp.privateKeyEnc, secret);

    expect(decrypted).toBe(kp.rawPrivateKey);
    expect(SES_RAW_KEY_PATTERN.test(pemToRawBase64(decrypted))).toBe(true);
  });

  it('is idempotent-ish: stripping an already-raw base64 string leaves it unchanged', () => {
    const raw = 'YWJjZGVmZ2hpams=';
    expect(pemToRawBase64(raw)).toBe(raw);
  });
});
