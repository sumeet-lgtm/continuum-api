import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// SMTP_CHECK_ENABLED=false is set in global setup, so smtpProbe returns notChecked for all calls.
// To test actual SMTP logic we need to flip the flag and mock the net module.

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>();
  return {
    ...actual,
    default: {
      ...actual,
      Socket: vi.fn(),
    },
  };
});

import { smtpProbe, smtpProbeWithFallback } from '../../engine/smtp.js';

// Restore SMTP_CHECK_ENABLED for these tests
beforeEach(() => {
  // Re-import config will use process.env, which we override per-test
  vi.resetModules();
});

describe('smtpProbe — SMTP_CHECK_ENABLED=false', () => {
  // Global setup sets SMTP_CHECK_ENABLED=false, so all calls return notChecked

  it('returns checked=false when SMTP is disabled', async () => {
    const result = await smtpProbe('user@example.com', 'mx.example.com');
    expect(result.checked).toBe(false);
    expect(result.reachable).toBeNull();
    expect(result.isCatchAll).toBeNull();
    expect(result.greylisted).toBe(false);
    expect(result.error).toMatch(/disabled/i);
  });

  it('always returns greylisted=false when not checked', async () => {
    const result = await smtpProbe('any@any.com', 'mx.any.com');
    expect(result.greylisted).toBe(false);
  });

  it('returns rawResponse=null when not checked', async () => {
    const result = await smtpProbe('user@example.com', 'mx.example.com');
    expect(result.rawResponse).toBeNull();
  });
});

// ─── SmtpProbeResult shape contract ──────────────────────────────────────────
// These tests verify the shape of the result regardless of SMTP_CHECK_ENABLED.

describe('smtpProbe result shape', () => {
  it('always has all required fields', async () => {
    const result = await smtpProbe('user@example.com', 'mx.example.com');

    expect(result).toHaveProperty('checked');
    expect(result).toHaveProperty('reachable');
    expect(result).toHaveProperty('isCatchAll');
    expect(result).toHaveProperty('greylisted');
    expect(result).toHaveProperty('rawResponse');
    expect(result).toHaveProperty('error');
  });

  it('checked is a boolean', async () => {
    const result = await smtpProbe('user@example.com', 'mx.example.com');
    expect(typeof result.checked).toBe('boolean');
  });

  it('greylisted is a boolean', async () => {
    const result = await smtpProbe('user@example.com', 'mx.example.com');
    expect(typeof result.greylisted).toBe('boolean');
  });

  it('reachable is boolean or null', async () => {
    const result = await smtpProbe('user@example.com', 'mx.example.com');
    expect(result.reachable === null || typeof result.reachable === 'boolean').toBe(true);
  });

  it('isCatchAll is boolean or null', async () => {
    const result = await smtpProbe('user@example.com', 'mx.example.com');
    expect(result.isCatchAll === null || typeof result.isCatchAll === 'boolean').toBe(true);
  });
});

describe('smtpProbeWithFallback', () => {
  // SMTP_CHECK_ENABLED=false globally, so every host individually returns
  // checked=false — this exercises that the wrapper walks the whole list
  // and still returns a well-formed not-checked result rather than throwing.
  it('returns checked=false when every MX host is inconclusive', async () => {
    const result = await smtpProbeWithFallback('user@example.com', [
      'mx1.example.com', 'mx2.example.com', 'mx3.example.com',
    ]);
    expect(result.checked).toBe(false);
  });

  it('returns not-checked when given an empty host list', async () => {
    const result = await smtpProbeWithFallback('user@example.com', []);
    expect(result.checked).toBe(false);
  });

  it('never probes more than 3 MX hosts', async () => {
    // Indirect check: passing 5 hosts should not throw or hang — the
    // implementation caps attempts at 3. Hard to assert call count here
    // without mocking net.Socket per-host, so this is a smoke test that
    // the cap doesn't break the call for a longer-than-usual MX list.
    const result = await smtpProbeWithFallback('user@example.com', [
      'mx1.example.com', 'mx2.example.com', 'mx3.example.com', 'mx4.example.com', 'mx5.example.com',
    ]);
    expect(result).toBeDefined();
  });
});

describe('smtpProbe — major webmail providers never report catch-all', () => {
  // Gmail (and the rest of PROTECTED_DOMAINS) accepts RCPT TO for nearly any
  // syntactically valid local-part and only bounces a nonexistent mailbox
  // later, asynchronously — a real-time catch-all probe against them can't
  // detect anything meaningful and previously mislabeled ordinary valid
  // addresses as "risky: catch-all". These tests exercise the remote-probe
  // path (what production actually runs — SMTP_PROBE_URL is set there)
  // with SMTP_CHECK_ENABLED flipped on and `fetch` mocked, since the global
  // setup disables real SMTP checks for the rest of the suite.
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = originalFetch;
    vi.resetModules();
  });

  async function probeWithRemoteResult(email: string, remoteIsCatchAll: boolean) {
    process.env = {
      ...originalEnv,
      SMTP_CHECK_ENABLED: 'true',
      SMTP_PROBE_URL: 'http://fake-probe.internal',
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ checked: true, reachable: true, isCatchAll: remoteIsCatchAll, greylisted: false, error: null }),
    }) as unknown as typeof fetch;
    vi.resetModules();
    const { smtpProbe: freshSmtpProbe } = await import('../../engine/smtp.js');
    return freshSmtpProbe(email, 'mx.example.com');
  }

  it('overrides a false-positive catch-all result for gmail.com to false', async () => {
    const result = await probeWithRemoteResult('someone@gmail.com', true);
    expect(result.isCatchAll).toBe(false);
  });

  it('leaves a genuine catch-all result untouched for a non-webmail domain', async () => {
    const result = await probeWithRemoteResult('someone@some-corp-domain.com', true);
    expect(result.isCatchAll).toBe(true);
  });

  it('does not force isCatchAll to false for gmail.com when the probe already said false', async () => {
    const result = await probeWithRemoteResult('someone@gmail.com', false);
    expect(result.isCatchAll).toBe(false);
  });
});
