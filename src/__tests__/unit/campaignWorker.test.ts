import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    campaign:           { findUnique: vi.fn(), update: vi.fn() },
    contactListMembership: { findMany: vi.fn().mockResolvedValue([]) },
    suppression:        { findMany: vi.fn().mockResolvedValue([]) },
    campaignRecipient:  { createMany: vi.fn(), updateMany: vi.fn() },
    sendMessage:        { create: vi.fn().mockResolvedValue({}) },
    apiKey:             { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    $disconnect:        vi.fn(),
  },
}));

vi.mock('../../lib/queue.js', () => ({
  QUEUE_CAMPAIGN:  'continuum:campaign',
  redisConnection: {},
}));

vi.mock('../../lib/ses.js', () => ({ sendViaSes: vi.fn(), isSesConfigured: vi.fn().mockReturnValue(true) }));
vi.mock('../../lib/unsubscribe.js', () => ({
  generateUnsubToken: vi.fn().mockReturnValue('tok'),
  generateUnsubHtml:  vi.fn().mockReturnValue(''),
}));
vi.mock('../../lib/tracking.js', () => ({
  generateOpenToken:  vi.fn().mockReturnValue(''),
  generateClickToken: vi.fn().mockReturnValue(''),
  injectTracking:     vi.fn((html: string) => html),
}));
vi.mock('../../lib/spintax.js', () => ({
  processTemplate: vi.fn((s: string) => s),
}));

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({ on: vi.fn(), close: vi.fn() })),
  Queue:  vi.fn().mockImplementation(() => ({ add: vi.fn(), close: vi.fn() })),
}));

import { processCampaign } from '../../workers/campaignWorker.js';
import { prisma } from '../../lib/prisma.js';
import { sendViaSes } from '../../lib/ses.js';

const mockCampaignFind    = vi.mocked(prisma.campaign.findUnique);
const mockCampaignUpdate  = vi.mocked(prisma.campaign.update);
const mockMemberships     = vi.mocked(prisma.contactListMembership.findMany);
const mockSendSes         = vi.mocked(sendViaSes);
const mockRecipientUpdate = vi.mocked(prisma.campaignRecipient.updateMany);
const mockSendMessageCreate = vi.mocked(prisma.sendMessage.create);
const mockApiKeyFind        = vi.mocked(prisma.apiKey.findUnique);
const mockApiKeyUpdate      = vi.mocked(prisma.apiKey.update);

function makeCampaign(overrides: Record<string, unknown> = {}) {
  return {
    id: 'camp-001',
    apiKeyId: 'key-001',
    status: 'sending',
    listIds: ['list-1'],
    excludeListIds: [],
    segmentIds: [],
    fromName: 'Acme',
    fromEmail: 'hello@acme.com',
    subject: 'Hi there',
    htmlBody: '<p>hi</p>',
    textBody: null,
    trackOpens: false,
    trackClicks: false,
    replyTo: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMemberships.mockResolvedValue([
    { contact: { email: 'lead@example.com', firstName: 'Lead', lastName: null } },
  ] as never);
  mockSendSes.mockResolvedValue({ sesMessageId: 'ses-campaign-1' } as never);
  mockRecipientUpdate.mockResolvedValue({ count: 1 } as never);
  mockCampaignUpdate.mockResolvedValue({} as never);
  // Plenty of send quota left by default — tests that care about the quota
  // gate override this explicitly.
  mockApiKeyFind.mockResolvedValue({ plan: 'free', monthlySendLimit: null, currentMonthSendUsage: 0 } as never);
});

describe('processCampaign — bounce tracking', () => {
  it('registers each send as a SendMessage row so the bounce webhook can find it', async () => {
    mockCampaignFind.mockResolvedValue(makeCampaign() as never);

    await processCampaign({ data: { campaignId: 'camp-001', apiKeyId: 'key-001' } } as never);

    expect(mockSendMessageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          apiKeyId: 'key-001',
          to: 'lead@example.com',
          sesMessageId: 'ses-campaign-1',
          status: 'sent',
        }),
      }),
    );
  });

  it('does not throw the whole send if registering the SendMessage row fails', async () => {
    mockCampaignFind.mockResolvedValue(makeCampaign() as never);
    mockSendMessageCreate.mockRejectedValue(new Error('db down'));

    await expect(
      processCampaign({ data: { campaignId: 'camp-001', apiKeyId: 'key-001' } } as never),
    ).resolves.not.toThrow();

    // The actual send + recipient status update must still have gone through
    expect(mockSendSes).toHaveBeenCalledTimes(1);
    expect(mockRecipientUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'sent' }) }),
    );
  });

  it('does nothing for a cancelled campaign', async () => {
    mockCampaignFind.mockResolvedValue(makeCampaign({ status: 'cancelled' }) as never);

    await processCampaign({ data: { campaignId: 'camp-001', apiKeyId: 'key-001' } } as never);

    expect(mockSendSes).not.toHaveBeenCalled();
    expect(mockSendMessageCreate).not.toHaveBeenCalled();
  });

  // Regression guard for a real bug found via live testing: every `break` in
  // the send loop (cancelled mid-send, bounce auto-pause, quota auto-pause)
  // only exited the loop — execution then fell into an unconditional
  // "mark sent + fire campaign.sent" block right after, silently overwriting
  // whatever status the break had just set. Bounce auto-pause and mid-send
  // cancellation had therefore never actually stuck in production.
  it('auto-pauses on high bounce rate mid-send and does not get overwritten back to sent', async () => {
    // First findUnique call is the top-of-function full-record read; the
    // second is the per-chunk status/bounceCount/sentCount re-check inside
    // the loop — must trip sentCount >= 50 and bouncePct > 5% to pause.
    mockCampaignFind
      .mockResolvedValueOnce(makeCampaign() as never)
      .mockResolvedValueOnce({ status: 'sending', bounceCount: 10, sentCount: 60 } as never);

    await processCampaign({ data: { campaignId: 'camp-001', apiKeyId: 'key-001' } } as never);

    expect(mockSendSes).not.toHaveBeenCalled();
    const lastCall = mockCampaignUpdate.mock.calls.at(-1);
    expect(lastCall?.[0]).toEqual(
      expect.objectContaining({ data: expect.objectContaining({ status: 'paused_bounce' }) }),
    );
  });

  it('stops mid-send when cancelled and does not get overwritten back to sent', async () => {
    mockCampaignFind
      .mockResolvedValueOnce(makeCampaign() as never)
      .mockResolvedValueOnce({ status: 'cancelled', bounceCount: 0, sentCount: 0 } as never);

    await processCampaign({ data: { campaignId: 'camp-001', apiKeyId: 'key-001' } } as never);

    expect(mockSendSes).not.toHaveBeenCalled();
    // No pause-status update happens for cancellation (the status is already
    // 'cancelled' from whoever cancelled it) — the fix must mean no update
    // call ever sets it back to 'sent'.
    const sentCalls = mockCampaignUpdate.mock.calls.filter(
      (call) => (call[0] as { data?: { status?: string } })?.data?.status === 'sent',
    );
    expect(sentCalls).toHaveLength(0);
  });
});

describe('processCampaign — monthly send quota', () => {
  // Every other send surface (/v1/send, batch send, sequence steps) already
  // enforces this; campaigns were the one path that could blow straight
  // through it — sends here never checked or incremented the key's
  // currentMonthSendUsage at all.
  it('auto-pauses instead of sending when the key has already used its full monthly send quota', async () => {
    mockCampaignFind.mockResolvedValue(makeCampaign() as never);
    mockApiKeyFind.mockResolvedValue({ plan: 'free', monthlySendLimit: null, currentMonthSendUsage: 1000 } as never);

    await processCampaign({ data: { campaignId: 'camp-001', apiKeyId: 'key-001' } } as never);

    expect(mockSendSes).not.toHaveBeenCalled();
    expect(mockCampaignUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'paused_quota' }) }),
    );
    // Regression guard: the loop's `break` used to only exit the loop, and
    // execution fell through into an unconditional "mark sent" update right
    // after — so a campaign could hit paused_quota and then get silently
    // flipped back to 'sent' a moment later, in the same run. Assert the
    // *last* update call is the pause, not a later 'sent' overwrite.
    const lastCall = mockCampaignUpdate.mock.calls.at(-1);
    expect(lastCall?.[0]).toEqual(
      expect.objectContaining({ data: expect.objectContaining({ status: 'paused_quota' }) }),
    );
  });

  it('sends normally and records usage when quota has room', async () => {
    mockCampaignFind.mockResolvedValue(makeCampaign() as never);
    mockApiKeyFind.mockResolvedValue({ plan: 'free', monthlySendLimit: null, currentMonthSendUsage: 5 } as never);

    await processCampaign({ data: { campaignId: 'camp-001', apiKeyId: 'key-001' } } as never);

    expect(mockSendSes).toHaveBeenCalledTimes(1);
    expect(mockApiKeyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'key-001' } }),
    );
  });

  it('caps the chunk to exactly what remains of quota rather than sending the whole chunk or none of it', async () => {
    mockCampaignFind.mockResolvedValue(makeCampaign() as never);
    mockMemberships.mockResolvedValue([
      { contact: { email: 'a@example.com', firstName: 'A', lastName: null } },
      { contact: { email: 'b@example.com', firstName: 'B', lastName: null } },
      { contact: { email: 'c@example.com', firstName: 'C', lastName: null } },
    ] as never);
    // 1 remaining of a 1000 limit — only the first of 3 recipients should send.
    mockApiKeyFind.mockResolvedValue({ plan: 'free', monthlySendLimit: null, currentMonthSendUsage: 999 } as never);

    await processCampaign({ data: { campaignId: 'camp-001', apiKeyId: 'key-001' } } as never);

    expect(mockSendSes).toHaveBeenCalledTimes(1);
  });
});
