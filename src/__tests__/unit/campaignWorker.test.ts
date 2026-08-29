import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    campaign:           { findUnique: vi.fn(), update: vi.fn() },
    contactListMembership: { findMany: vi.fn().mockResolvedValue([]) },
    suppression:        { findMany: vi.fn().mockResolvedValue([]) },
    campaignRecipient:  { createMany: vi.fn(), updateMany: vi.fn() },
    sendMessage:        { create: vi.fn().mockResolvedValue({}) },
    $disconnect:        vi.fn(),
  },
}));

vi.mock('../../lib/queue.js', () => ({
  QUEUE_CAMPAIGN:  'continuum:campaign',
  redisConnection: {},
}));

vi.mock('../../lib/ses.js', () => ({ sendViaSes: vi.fn() }));
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

function makeCampaign(overrides: Record<string, unknown> = {}) {
  return {
    id: 'camp-001',
    apiKeyId: 'key-001',
    status: 'sending',
    listIds: ['list-1'],
    excludeListIds: [],
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
});
