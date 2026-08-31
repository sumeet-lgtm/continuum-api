import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// config.ts is a singleton that validates process.env at import time, so
// each case here needs a fresh module registry and its own env snapshot.
const REQUIRED_BASE_ENV = {
  DATABASE_URL: 'postgresql://test:test@localhost:5432/continuum_test',
  REDIS_URL: 'redis://localhost:6379',
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key-minimum-32-chars-long',
  API_KEY_SALT: 'a-real-production-salt-not-the-dev-default-1234',
};

const ALL_PRODUCTION_SECRETS = {
  DOMAIN_KEY_SECRET: 'a'.repeat(32),
  UNSUBSCRIBE_SECRET: 'b'.repeat(32),
  TRACKING_SECRET: 'c'.repeat(32),
  MAILBOX_CREDS_SECRET: 'd'.repeat(32),
  OPTIN_SECRET: 'e'.repeat(32),
  SESSION_SECRET: 'f'.repeat(32),
};

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  vi.resetModules();
});

afterEach(() => {
  process.env = originalEnv;
});

async function loadConfigWithEnv(env: Record<string, string | undefined>): Promise<{ ok: true } | { ok: false; error: Error }> {
  process.env = { ...originalEnv, ...env } as NodeJS.ProcessEnv;
  // Delete keys explicitly set to undefined so they read as truly unset,
  // not the string "undefined".
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
  }
  try {
    await import('../../config.js');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err as Error };
  }
}

describe('config production validation', () => {
  it('loads fine in test/development without any of the per-purpose crypto secrets set', async () => {
    const result = await loadConfigWithEnv({
      NODE_ENV: 'test',
      ...REQUIRED_BASE_ENV,
      DOMAIN_KEY_SECRET: undefined,
      UNSUBSCRIBE_SECRET: undefined,
      TRACKING_SECRET: undefined,
      MAILBOX_CREDS_SECRET: undefined,
      OPTIN_SECRET: undefined,
    });
    expect(result.ok).toBe(true);
  });

  it('refuses to start in production when the crypto secrets are unset', async () => {
    const result = await loadConfigWithEnv({
      NODE_ENV: 'production',
      ...REQUIRED_BASE_ENV,
      DOMAIN_KEY_SECRET: undefined,
      UNSUBSCRIBE_SECRET: undefined,
      TRACKING_SECRET: undefined,
      MAILBOX_CREDS_SECRET: undefined,
      OPTIN_SECRET: undefined,
      SESSION_SECRET: undefined,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/DOMAIN_KEY_SECRET/);
      expect(result.error.message).toMatch(/UNSUBSCRIBE_SECRET/);
      expect(result.error.message).toMatch(/TRACKING_SECRET/);
      expect(result.error.message).toMatch(/MAILBOX_CREDS_SECRET/);
      expect(result.error.message).toMatch(/OPTIN_SECRET/);
    }
  });

  it('refuses to start in production when SESSION_SECRET is still the dev default', async () => {
    const result = await loadConfigWithEnv({
      NODE_ENV: 'production',
      ...REQUIRED_BASE_ENV,
      ...ALL_PRODUCTION_SECRETS,
      SESSION_SECRET: 'dev-session-secret-at-least-32-chars-long',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/SESSION_SECRET/);
  });

  it('refuses to start in production when API_KEY_SALT is still the dev default', async () => {
    const result = await loadConfigWithEnv({
      NODE_ENV: 'production',
      ...REQUIRED_BASE_ENV,
      ...ALL_PRODUCTION_SECRETS,
      API_KEY_SALT: 'dev-salt-change-in-production',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/API_KEY_SALT/);
  });

  it('starts in production once every secret is set to a real, non-default value', async () => {
    const result = await loadConfigWithEnv({
      NODE_ENV: 'production',
      ...REQUIRED_BASE_ENV,
      ...ALL_PRODUCTION_SECRETS,
    });
    expect(result.ok).toBe(true);
  });
});
