import { describe, it, expect, vi } from 'vitest';
import { signOAuthState, verifyOAuthState } from '../../lib/oauth/state.js';

describe('OAuth state sign/verify', () => {
  it('round-trips a valid state back to the same apiKeyId', () => {
    const state = signOAuthState('apikey_123');
    const result = verifyOAuthState(state);
    expect(result).toEqual({ apiKeyId: 'apikey_123' });
  });

  it('rejects a tampered state (payload changed, signature stale)', () => {
    const state = signOAuthState('apikey_123');
    const decoded = Buffer.from(state, 'base64url').toString('utf8');
    const tampered = decoded.replace('apikey_123', 'apikey_attacker');
    const tamperedState = Buffer.from(tampered).toString('base64url');
    expect(verifyOAuthState(tamperedState)).toBeNull();
  });

  it('rejects garbage input instead of throwing', () => {
    expect(verifyOAuthState('not-a-real-state')).toBeNull();
    expect(verifyOAuthState('')).toBeNull();
  });

  it('rejects an expired state', () => {
    const realNow = Date.now;
    vi.spyOn(Date, 'now').mockReturnValue(realNow() - 20 * 60 * 1000); // signed 20 min ago
    const state = signOAuthState('apikey_123');
    vi.spyOn(Date, 'now').mockRestore();

    expect(verifyOAuthState(state)).toBeNull();
  });
});
