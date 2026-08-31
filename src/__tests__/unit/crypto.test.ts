import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import {
  generateApiKey,
  hashApiKey,
  getKeyPrefix,
  signWebhookPayload,
  verifyWebhookSignature,
  generateWebhookSecret,
} from '../../lib/crypto.js';

describe('generateApiKey', () => {
  it('generates a key with the cnt_ prefix', () => {
    const key = generateApiKey();
    expect(key).toMatch(/^cnt_/);
  });

  it('generates a key of expected length', () => {
    const key = generateApiKey();
    // "cnt_" + 48 hex chars = 52 total
    expect(key.length).toBe(52);
  });

  it('generates unique keys each time', () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateApiKey()));
    expect(keys.size).toBe(100);
  });

  it('contains only alphanumeric chars after the prefix', () => {
    const key = generateApiKey();
    expect(key.slice(4)).toMatch(/^[0-9a-f]+$/);
  });
});

describe('hashApiKey', () => {
  it('returns a 64-character hex string', () => {
    const hash = hashApiKey('cnt_test_key');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same input', () => {
    const key = 'cnt_test_abc123';
    expect(hashApiKey(key)).toBe(hashApiKey(key));
  });

  it('produces different hashes for different keys', () => {
    expect(hashApiKey('cnt_key_one')).not.toBe(hashApiKey('cnt_key_two'));
  });

  it('is plain unsalted SHA-256 of the raw key (documented behavior, not a salted hash)', () => {
    // Despite API_KEY_SALT's name, it is NOT mixed into key hashing — this
    // pins that down so a future change to hashApiKey is deliberate, not
    // accidental. Not a real weakness on its own: generated keys already
    // carry 24 random bytes of entropy. See .env.example's API_KEY_SALT note.
    const raw = 'cnt_raw_key_value';
    const expected = createHash('sha256').update(raw).digest('hex');
    expect(hashApiKey(raw)).toBe(expected);
  });
});

describe('getKeyPrefix', () => {
  it('returns the first 12 characters of the key', () => {
    const key = 'cnt_a1b2c3d4e5f6g7h8';
    expect(getKeyPrefix(key)).toBe('cnt_a1b2c3d4');
  });

  it('includes the cnt_ prefix', () => {
    const key = generateApiKey();
    expect(getKeyPrefix(key)).toMatch(/^cnt_/);
  });
});

describe('signWebhookPayload', () => {
  const secret = 'test-webhook-secret-32chars-xxxxxx';
  const body   = '{"event":"test","id":"abc"}';

  it('returns a sha256= prefixed signature', () => {
    const sig = signWebhookPayload(secret, body);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('is deterministic for same secret and body', () => {
    expect(signWebhookPayload(secret, body)).toBe(signWebhookPayload(secret, body));
  });

  it('produces different signatures for different bodies', () => {
    const sig1 = signWebhookPayload(secret, '{"a":1}');
    const sig2 = signWebhookPayload(secret, '{"a":2}');
    expect(sig1).not.toBe(sig2);
  });

  it('produces different signatures for different secrets', () => {
    const sig1 = signWebhookPayload('secret1', body);
    const sig2 = signWebhookPayload('secret2', body);
    expect(sig1).not.toBe(sig2);
  });
});

describe('verifyWebhookSignature', () => {
  const secret = 'test-webhook-secret-32chars-xxxxxx';
  const body   = '{"event":"test","id":"abc"}';

  it('returns true for a correct signature', () => {
    const sig = signWebhookPayload(secret, body);
    expect(verifyWebhookSignature(secret, body, sig)).toBe(true);
  });

  it('returns false for a tampered body', () => {
    const sig     = signWebhookPayload(secret, body);
    const tampered = '{"event":"test","id":"TAMPERED"}';
    expect(verifyWebhookSignature(secret, tampered, sig)).toBe(false);
  });

  it('returns false for a wrong secret', () => {
    const sig = signWebhookPayload(secret, body);
    expect(verifyWebhookSignature('wrong-secret', body, sig)).toBe(false);
  });

  it('returns false for a truncated signature', () => {
    const sig = signWebhookPayload(secret, body).slice(0, 20);
    expect(verifyWebhookSignature(secret, body, sig)).toBe(false);
  });

  it('returns false for an empty signature', () => {
    expect(verifyWebhookSignature(secret, body, '')).toBe(false);
  });

  it('returns false for a completely arbitrary string', () => {
    expect(verifyWebhookSignature(secret, body, 'sha256=0000000000')).toBe(false);
  });
});

describe('generateWebhookSecret', () => {
  it('returns a 64-character hex string', () => {
    const secret = generateWebhookSecret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates unique secrets each time', () => {
    const secrets = new Set(Array.from({ length: 50 }, () => generateWebhookSecret()));
    expect(secrets.size).toBe(50);
  });
});
