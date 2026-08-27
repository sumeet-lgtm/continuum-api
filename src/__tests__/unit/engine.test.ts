import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VerificationResult } from '../../types/verification.js';

// ─── Mock all I/O dependencies ────────────────────────────────────────────────

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    verification: {
      create: vi.fn().mockResolvedValue({
        id: 'test-id-001',
        checkedAt: new Date('2026-04-24T10:00:00Z'),
      }),
    },
  },
}));

vi.mock('../../engine/mx.js', () => ({
  lookupMx: vi.fn(),
  clearMxCache: vi.fn(),
  getMxCacheStats: vi.fn().mockReturnValue({ size: 0, maxSize: 10000 }),
}));

vi.mock('../../engine/smtp.js', () => ({
  smtpProbe: vi.fn().mockResolvedValue({
    checked:     false,
    reachable:   null,
    isCatchAll:  null,
    greylisted:  false,
    rawResponse: null,
    error:       'SMTP disabled',
  }),
}));

vi.mock('../../engine/disposable.js', () => ({
  isDisposableDomain:  vi.fn().mockReturnValue(false),
  loadDisposableList:  vi.fn(),
  getBlocklistStats:   vi.fn().mockReturnValue({ exact: 0, wildcard: 0 }),
}));

import { verifyEmail } from '../../engine/index.js';
import { lookupMx } from '../../engine/mx.js';
import { smtpProbe } from '../../engine/smtp.js';
import { isDisposableDomain } from '../../engine/disposable.js';
import { prisma } from '../../lib/prisma.js';

const mockLookupMx         = vi.mocked(lookupMx);
const mockSmtpProbe        = vi.mocked(smtpProbe);
const mockIsDisposable     = vi.mocked(isDisposableDomain);
const mockCreate           = vi.mocked(prisma.verification.create);

const baseInput = {
  email:     'alice@example.com',
  apiKeyId:  'key-abc-123',
  bulkJobId: undefined as string | undefined,
  sourceIp:  '1.2.3.4' as string | undefined,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockMxFound(records = ['mx1.example.com']) {
  mockLookupMx.mockResolvedValue({ found: true, records, error: null });
}

function mockMxNotFound() {
  mockLookupMx.mockResolvedValue({ found: false, records: [], error: null });
}

function mockSmtpAccepted() {
  mockSmtpProbe.mockResolvedValue({
    checked: true, reachable: true, isCatchAll: false,
    greylisted: false, rawResponse: '250 OK', error: null,
  });
}

function mockSmtpRejected() {
  mockSmtpProbe.mockResolvedValue({
    checked: true, reachable: false, isCatchAll: null,
    greylisted: false, rawResponse: '550 No such user', error: null,
  });
}

function mockSmtpCatchAll() {
  mockSmtpProbe.mockResolvedValue({
    checked: true, reachable: true, isCatchAll: true,
    greylisted: false, rawResponse: '250 OK', error: null,
  });
}

function mockSmtpGreylisted() {
  mockSmtpProbe.mockResolvedValue({
    checked: true, reachable: null, isCatchAll: null,
    greylisted: true, rawResponse: '451 Try again', error: 'smtp_greylisted',
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('verifyEmail engine pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockResolvedValue({ id: 'test-id-001', checkedAt: new Date('2026-04-24T10:00:00Z') } as never);
    mockIsDisposable.mockReturnValue(false);
    // Restore default smtp mock: not checked (disabled in test env)
    mockSmtpProbe.mockResolvedValue({
      checked: false, reachable: null, isCatchAll: null,
      greylisted: false, rawResponse: null, error: 'SMTP disabled',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ─── Syntax failures ────────────────────────────────────────────────────

  describe('syntax failures', () => {
    it('returns invalid immediately for bad syntax without hitting DNS', async () => {
      const result = await verifyEmail({ ...baseInput, email: 'notanemail' });

      expect(result.status).toBe('invalid');
      expect(result.checks.syntaxValid).toBe(false);
      expect(result.domain).toBe('');
      expect(mockLookupMx).not.toHaveBeenCalled();
      expect(mockSmtpProbe).not.toHaveBeenCalled();
    });

    it('sets subStatus on syntax failure', async () => {
      const result = await verifyEmail({ ...baseInput, email: 'bad@' });
      expect(result.subStatus).not.toBeNull();
    });

    it('persists syntax-invalid result to DB', async () => {
      await verifyEmail({ ...baseInput, email: 'bademail' });
      expect(mockCreate).toHaveBeenCalledOnce();
      const data = mockCreate.mock.calls[0]![0].data;
      expect(data.syntaxValid).toBe(false);
      expect(data.status).toBe('invalid');
    });
  });

  // ─── MX failures ────────────────────────────────────────────────────────

  describe('MX failures', () => {
    it('returns invalid when no MX records found', async () => {
      mockMxNotFound();
      const result = await verifyEmail(baseInput);

      expect(result.status).toBe('invalid');
      expect(result.checks.mxFound).toBe(false);
      expect(result.subStatus).toBe('no_mx_records');
      expect(mockSmtpProbe).not.toHaveBeenCalled();
    });

    it('returns mx_lookup_error subStatus when DNS returns an error', async () => {
      mockLookupMx.mockResolvedValue({ found: false, records: [], error: 'DNS timeout' });
      const result = await verifyEmail(baseInput);

      expect(result.subStatus).toBe('mx_lookup_error');
    });

    it('persists no-MX result to DB', async () => {
      mockMxNotFound();
      await verifyEmail(baseInput);

      const data = mockCreate.mock.calls[0]![0].data;
      expect(data.mxFound).toBe(false);
      expect(data.status).toBe('invalid');
    });
  });

  // ─── Full pipeline — valid result ────────────────────────────────────────

  describe('full pipeline — valid email', () => {
    it('returns valid status when MX found and SMTP confirms', async () => {
      mockMxFound();
      mockSmtpAccepted();

      const result = await verifyEmail(baseInput);

      expect(result.status).toBe('valid');
      expect(result.checks.mxFound).toBe(true);
      expect(result.checks.smtpChecked).toBe(true);
      expect(result.checks.smtpReachable).toBe(true);
      expect(result.checks.greylisted).toBe(false);
      expect(result.score).toBe(100);
    });

    it('calls smtpProbe with the highest-priority MX host', async () => {
      mockMxFound(['mx1.example.com', 'mx2.example.com']);
      mockSmtpAccepted();

      await verifyEmail(baseInput);

      expect(mockSmtpProbe).toHaveBeenCalledWith(
        'alice@example.com',
        'mx1.example.com',
      );
    });

    it('includes the normalized email in the result', async () => {
      mockMxFound();
      mockSmtpAccepted();

      const result = await verifyEmail({ ...baseInput, email: 'alice@example.com' });
      expect(result.email).toBe('alice@example.com');
    });

    it('extracts the domain correctly', async () => {
      mockMxFound();
      mockSmtpAccepted();

      const result = await verifyEmail(baseInput);
      expect(result.domain).toBe('example.com');
    });

    it('returns a valid checkedAt date', async () => {
      mockMxFound();
      mockSmtpAccepted();

      const result = await verifyEmail(baseInput);
      expect(result.checkedAt).toBeInstanceOf(Date);
    });

    it('durationMs is a non-negative integer', async () => {
      mockMxFound();
      mockSmtpAccepted();

      const result = await verifyEmail(baseInput);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(result.durationMs)).toBe(true);
    });
  });

  // ─── SMTP rejection ──────────────────────────────────────────────────────

  describe('SMTP rejected', () => {
    it('returns invalid when SMTP permanently rejects the address', async () => {
      mockMxFound();
      mockSmtpRejected();

      const result = await verifyEmail(baseInput);

      expect(result.status).toBe('invalid');
      expect(result.checks.smtpReachable).toBe(false);
      expect(result.subStatus).toBe('smtp_rejected');
    });
  });

  // ─── Catch-all ───────────────────────────────────────────────────────────

  describe('catch-all domains', () => {
    it('returns risky with catch_all subStatus', async () => {
      mockMxFound();
      mockSmtpCatchAll();

      const result = await verifyEmail(baseInput);

      expect(result.status).toBe('risky');
      expect(result.checks.isCatchAll).toBe(true);
      expect(result.subStatus).toBe('catch_all');
    });
  });

  // ─── Greylisting ─────────────────────────────────────────────────────────

  describe('greylisted', () => {
    it('returns unknown with smtp_greylisted subStatus', async () => {
      mockMxFound();
      mockSmtpGreylisted();

      const result = await verifyEmail(baseInput);

      expect(result.status).toBe('unknown');
      expect(result.checks.greylisted).toBe(true);
      expect(result.subStatus).toBe('smtp_greylisted');
    });

    it('persists greylisted=true to DB', async () => {
      mockMxFound();
      mockSmtpGreylisted();

      await verifyEmail(baseInput);
      const data = mockCreate.mock.calls[0]![0].data;
      expect(data.greylisted).toBe(true);
    });
  });

  // ─── Disposable domain ────────────────────────────────────────────────────

  describe('disposable domains', () => {
    it('returns risky with disposable_domain subStatus', async () => {
      mockMxFound();
      mockIsDisposable.mockReturnValue(true);
      mockSmtpAccepted();

      const result = await verifyEmail({ ...baseInput, email: 'user@mailinator.com' });

      expect(result.status).toBe('risky');
      expect(result.checks.isDisposable).toBe(true);
      expect(result.subStatus).toBe('disposable_domain');
    });
  });

  // ─── Role accounts ────────────────────────────────────────────────────────

  describe('role accounts', () => {
    it('returns risky with role_account subStatus for admin@', async () => {
      mockMxFound();
      mockSmtpAccepted();

      const result = await verifyEmail({ ...baseInput, email: 'admin@example.com' });

      expect(result.status).toBe('risky');
      expect(result.checks.isRoleAccount).toBe(true);
      expect(result.subStatus).toBe('role_account');
    });

    it('returns risky for noreply@', async () => {
      mockMxFound();
      mockSmtpAccepted();

      const result = await verifyEmail({ ...baseInput, email: 'noreply@example.com' });
      expect(result.status).toBe('risky');
    });
  });

  // ─── SMTP not checked ────────────────────────────────────────────────────

  describe('SMTP not checked', () => {
    it('returns unknown for clean email with no SMTP data', async () => {
      mockMxFound();
      // Default mock returns smtpChecked=false

      const result = await verifyEmail(baseInput);

      expect(result.status).toBe('unknown');
      expect(result.subStatus).toBe('smtp_not_checked');
    });
  });

  // ─── DB persistence ──────────────────────────────────────────────────────

  describe('database persistence', () => {
    it('always calls prisma.verification.create once per verification', async () => {
      mockMxFound();
      mockSmtpAccepted();

      await verifyEmail(baseInput);
      expect(mockCreate).toHaveBeenCalledOnce();
    });

    it('persists greylisted field', async () => {
      mockMxFound();
      mockSmtpAccepted();

      await verifyEmail(baseInput);
      const data = mockCreate.mock.calls[0]![0].data;
      expect(data).toHaveProperty('greylisted');
    });

    it('persists all check fields to DB', async () => {
      mockMxFound();
      mockSmtpAccepted();

      await verifyEmail(baseInput);
      const { data } = mockCreate.mock.calls[0]![0];

      expect(data).toMatchObject({
        email:        'alice@example.com',
        domain:       'example.com',
        syntaxValid:  true,
        mxFound:      true,
        smtpChecked:  true,
        smtpReachable: true,
        isCatchAll:   false,
        greylisted:   false,
        status:       'valid',
      });
    });

    it('passes bulkJobId to DB when provided', async () => {
      mockMxFound();
      mockSmtpAccepted();

      await verifyEmail({ ...baseInput, bulkJobId: 'bulk-xyz-789' });
      const data = mockCreate.mock.calls[0]![0].data;
      expect(data.bulkJobId).toBe('bulk-xyz-789');
    });

    it('passes null bulkJobId to DB when not provided', async () => {
      mockMxFound();
      mockSmtpAccepted();

      await verifyEmail({ ...baseInput, bulkJobId: undefined });
      const data = mockCreate.mock.calls[0]![0].data;
      expect(data.bulkJobId).toBeNull();
    });

    it('returns ephemeral ID and still returns result when DB write fails', async () => {
      mockMxFound();
      mockSmtpAccepted();
      mockCreate.mockRejectedValueOnce(new Error('DB connection lost'));

      const result = await verifyEmail(baseInput);

      // Result is still returned with an ephemeral ID
      expect(result).toBeDefined();
      expect(result.id).toMatch(/^ephemeral_/);
      expect(result.status).toBe('valid');
    });
  });

  // ─── Result shape ─────────────────────────────────────────────────────────

  describe('result shape', () => {
    it('result contains all required fields', async () => {
      mockMxFound();
      mockSmtpAccepted();

      const result: VerificationResult = await verifyEmail(baseInput);

      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('email');
      expect(result).toHaveProperty('domain');
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('subStatus');
      expect(result).toHaveProperty('checks');
      expect(result).toHaveProperty('score');
      expect(result).toHaveProperty('durationMs');
      expect(result).toHaveProperty('checkedAt');
    });

    it('checks object contains all required fields including greylisted', async () => {
      mockMxFound();
      mockSmtpAccepted();

      const result = await verifyEmail(baseInput);

      expect(result.checks).toHaveProperty('syntaxValid');
      expect(result.checks).toHaveProperty('mxFound');
      expect(result.checks).toHaveProperty('mxRecords');
      expect(result.checks).toHaveProperty('isDisposable');
      expect(result.checks).toHaveProperty('isRoleAccount');
      expect(result.checks).toHaveProperty('smtpChecked');
      expect(result.checks).toHaveProperty('smtpReachable');
      expect(result.checks).toHaveProperty('isCatchAll');
      expect(result.checks).toHaveProperty('greylisted');
    });
  });
});
