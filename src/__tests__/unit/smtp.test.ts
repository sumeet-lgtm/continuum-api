import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { smtpProbe } from '../../engine/smtp.js';

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
