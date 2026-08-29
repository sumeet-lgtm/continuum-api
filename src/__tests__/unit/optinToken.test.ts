import { describe, it, expect } from 'vitest';
import { generateOptinToken, verifyOptinToken } from '../../lib/optinToken.js';
import { hmacSign } from '../../lib/crypto.js';
import { config } from '../../config.js';

describe('optinToken', () => {
  it('round-trips a valid token', () => {
    const token = generateOptinToken('contact-123', 'list-abc');
    const result = verifyOptinToken(token);
    expect(result).toEqual({ contactId: 'contact-123', listId: 'list-abc' });
  });

  it('rejects a token with a tampered payload', () => {
    const token = generateOptinToken('contact-123', 'list-abc');
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const parts = decoded.split('.');
    // Swap the contact id but keep the original signature — a forged token
    const tampered = [`contact-999`, parts[1], parts[2], parts[3]].join('.');
    const forgedToken = Buffer.from(tampered).toString('base64url');
    expect(verifyOptinToken(forgedToken)).toBeNull();
  });

  it('rejects a token with a tampered signature', () => {
    const token = generateOptinToken('contact-123', 'list-abc');
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const parts = decoded.split('.');
    const tampered = [parts[0], parts[1], parts[2], 'forged-signature'].join('.');
    const forgedToken = Buffer.from(tampered).toString('base64url');
    expect(verifyOptinToken(forgedToken)).toBeNull();
  });

  it('rejects an expired token even with a correct signature', () => {
    // Construct a token exactly the way generateOptinToken does, but with
    // an expiry in the past — proves the expiry check itself is enforced,
    // not just piggybacking on a bad signature. OPTIN_SECRET isn't set in
    // the test env, so secret() falls back to API_KEY_SALT, same as the
    // module under test resolves to.
    const contactId = 'contact-123';
    const listId = 'list-abc';
    const pastExpiry = Date.now() - 1000;
    const payload = `${contactId}.${listId}.${pastExpiry}`;
    const sig = hmacSign(config.API_KEY_SALT, payload);
    const token = Buffer.from(`${payload}.${sig}`).toString('base64url');

    expect(verifyOptinToken(token)).toBeNull();
  });

  it('rejects malformed tokens without throwing', () => {
    expect(verifyOptinToken('not-valid-base64url-!!!')).toBeNull();
    expect(verifyOptinToken('')).toBeNull();
    expect(verifyOptinToken(Buffer.from('too.few.parts').toString('base64url'))).toBeNull();
  });

  it('different contact/list pairs produce different tokens', () => {
    const a = generateOptinToken('contact-1', 'list-a');
    const b = generateOptinToken('contact-2', 'list-a');
    expect(a).not.toBe(b);
  });
});
