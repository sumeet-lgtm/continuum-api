import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMock = vi.fn();
vi.mock('@aws-sdk/client-sesv2', () => {
  class FakeSESv2Client { send = sendMock; }
  class FakeGetEmailIdentityCommand { constructor(public input: unknown) {} }
  return { SESv2Client: FakeSESv2Client, GetEmailIdentityCommand: FakeGetEmailIdentityCommand };
});

vi.mock('../../lib/prisma.js', () => ({
  prisma: { sendingDomain: { update: vi.fn() } },
}));
vi.mock('../../lib/deliverability.js', () => ({ getDomainHealth: vi.fn() }));
vi.mock('../../lib/audit.js', () => ({ logAudit: vi.fn() }));
vi.mock('../../lib/webhooks.js', () => ({ dispatchWebhook: vi.fn().mockResolvedValue(undefined), buildEventId: (event: string, id: string) => `${event}:${id}` }));
vi.mock('../../config.js', () => ({
  config: { AWS_ACCESS_KEY_ID: 'test-key', AWS_SECRET_ACCESS_KEY: 'test-secret', AWS_REGION: 'us-east-1' },
}));

import { verifyDomain } from '../../lib/domainVerify.js';
import { prisma } from '../../lib/prisma.js';
import { getDomainHealth } from '../../lib/deliverability.js';
import { dispatchWebhook } from '../../lib/webhooks.js';

const mockUpdate = vi.mocked(prisma.sendingDomain.update);
const mockGetHealth = vi.mocked(getDomainHealth);
const mockDispatch = vi.mocked(dispatchWebhook);

function makeDomain(overrides: Partial<Parameters<typeof verifyDomain>[0]> = {}) {
  return {
    id: 'dom-1', apiKeyId: 'key-1', name: 'wyberai.com', region: 'us-east-1',
    dkimStatus: 'pending', verifiedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdate.mockImplementation(({ data }) => Promise.resolve({ id: 'dom-1', name: 'wyberai.com', ...data } as never));
});

describe('verifyDomain', () => {
  it('marks the domain verified and fires domain.verified once SPF+DKIM+DMARC all pass', async () => {
    mockGetHealth.mockResolvedValue({ spf: { valid: true }, dkim: { valid: true }, dmarc: { valid: true } } as never);
    sendMock.mockResolvedValue({ DkimAttributes: { Status: 'SUCCESS' } });

    const { updated, justVerified } = await verifyDomain(makeDomain());

    expect(justVerified).toBe(true);
    expect(updated.status).toBe('verified');
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'domain.verified', payload: expect.objectContaining({ domain: 'wyberai.com' }) }),
    );
  });

  it('checks live SES DKIM status even when our own DNS-based dkim check says invalid — this is the actual bug this module exists to handle correctly', async () => {
    // Our own health check can't always see the DKIM record (or SES hasn't
    // finished propagating it internally) even though the DNS TXT record
    // itself is already live — SES's own async verification is the real
    // source of truth for DKIM specifically.
    mockGetHealth.mockResolvedValue({ spf: { valid: true }, dkim: { valid: false }, dmarc: { valid: true } } as never);
    sendMock.mockResolvedValue({ DkimAttributes: { Status: 'SUCCESS' } });

    const { updated, justVerified } = await verifyDomain(makeDomain());

    expect(justVerified).toBe(true);
    expect(updated.status).toBe('verified');
  });

  it('stays pending when SES has not finished its own DKIM verification yet, and does not fire the webhook', async () => {
    mockGetHealth.mockResolvedValue({ spf: { valid: true }, dkim: { valid: false }, dmarc: { valid: true } } as never);
    sendMock.mockResolvedValue({ DkimAttributes: { Status: 'PENDING' } });

    const { updated, justVerified } = await verifyDomain(makeDomain());

    expect(justVerified).toBe(false);
    expect(updated.status).toBe('pending');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('does not re-fire domain.verified on a later recheck of an already-verified domain', async () => {
    mockGetHealth.mockResolvedValue({ spf: { valid: true }, dkim: { valid: true }, dmarc: { valid: true } } as never);
    sendMock.mockResolvedValue({ DkimAttributes: { Status: 'SUCCESS' } });

    const { justVerified } = await verifyDomain(makeDomain({ verifiedAt: new Date('2026-01-01') }));

    expect(justVerified).toBe(false);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('does not let a webhook dispatch failure break the verification result', async () => {
    mockGetHealth.mockResolvedValue({ spf: { valid: true }, dkim: { valid: true }, dmarc: { valid: true } } as never);
    sendMock.mockResolvedValue({ DkimAttributes: { Status: 'SUCCESS' } });
    mockDispatch.mockRejectedValueOnce(new Error('webhook endpoint down'));

    const { updated, justVerified } = await verifyDomain(makeDomain());

    expect(justVerified).toBe(true);
    expect(updated.status).toBe('verified');
  });
});
