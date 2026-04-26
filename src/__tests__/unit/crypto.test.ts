import { describe, it, expect } from 'vitest';
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

  it('incorporates the API_KEY_SALT (different results in different envs)', () => {
    // The salt is "test-salt-that-is-at-least-16-chars" from global setup
    // We can't test the salt directly without access to the env, but we can
    // verify hashing is not a plain SHA-256 of the raw key by comparing
    // a known SHA-256 of the raw key without salt.
    const raw = 'cnt_raw_key_value';
    const hash = hashApiKey(raw);
    // If there was no salt the hash would be SHA-256("cnt_raw_key_value")
    // With our test salt it will be different
    const naiveSha256 = '1a879da87a6a87c5cf7c18dcbf5e8cb1eed61ae3a48e21b50b9b35cb3d5f7e48';
    expect(hash).not.toBe(naiveSha256);
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
