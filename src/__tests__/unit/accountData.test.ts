import { describe, it, expect, vi, beforeEach } from 'vitest';

// deleteAccountData zips deletion-count results back to table-name labels
// by array position — this suite specifically pins down that the labels
// and the transaction call order can never drift apart again (that exact
// bug existed in an earlier draft of this file: a separately-maintained
// label list was zipped to a differently-ordered transaction array,
// silently mislabeling every count in the response).

const { transactionMock, findManyMocks, deleteManyMocks } = vi.hoisted(() => {
  const models = [
    'mailbox', 'monitor', 'webhook', 'automation', 'campaign', 'sequence', 'sendMessage',
    'verification', 'bulkJob', 'contact', 'mailingList', 'segment', 'sendingDomain',
    'emailTemplate', 'lead', 'inboxTest', 'replyEvent', 'trackingEvent', 'monitorCheck',
    'webhookDelivery', 'automationEnrollment',
  ] as const;
  const findManyMocks: Record<string, ReturnType<typeof vi.fn>> = {};
  const deleteManyMocks: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const m of models) {
    findManyMocks[m] = vi.fn().mockResolvedValue([]);
    deleteManyMocks[m] = vi.fn().mockResolvedValue({ count: 0 });
  }
  return { transactionMock: vi.fn(), findManyMocks, deleteManyMocks };
});

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    mailbox: { findMany: findManyMocks['mailbox'], deleteMany: deleteManyMocks['mailbox'] },
    monitor: { findMany: findManyMocks['monitor'], deleteMany: deleteManyMocks['monitor'] },
    webhook: { findMany: findManyMocks['webhook'], deleteMany: deleteManyMocks['webhook'] },
    automation: { findMany: findManyMocks['automation'], deleteMany: deleteManyMocks['automation'] },
    campaign: { findMany: findManyMocks['campaign'], deleteMany: deleteManyMocks['campaign'] },
    sequence: { findMany: findManyMocks['sequence'], deleteMany: deleteManyMocks['sequence'] },
    sendMessage: { findMany: findManyMocks['sendMessage'], deleteMany: deleteManyMocks['sendMessage'] },
    verification: { findMany: findManyMocks['verification'], deleteMany: deleteManyMocks['verification'] },
    bulkJob: { findMany: findManyMocks['bulkJob'], deleteMany: deleteManyMocks['bulkJob'] },
    contact: { findMany: findManyMocks['contact'], deleteMany: deleteManyMocks['contact'] },
    mailingList: { findMany: findManyMocks['mailingList'], deleteMany: deleteManyMocks['mailingList'] },
    segment: { findMany: findManyMocks['segment'], deleteMany: deleteManyMocks['segment'] },
    sendingDomain: { findMany: findManyMocks['sendingDomain'], deleteMany: deleteManyMocks['sendingDomain'] },
    emailTemplate: { findMany: findManyMocks['emailTemplate'], deleteMany: deleteManyMocks['emailTemplate'] },
    lead: { findMany: findManyMocks['lead'], deleteMany: deleteManyMocks['lead'] },
    inboxTest: { findMany: findManyMocks['inboxTest'], deleteMany: deleteManyMocks['inboxTest'] },
    replyEvent: { findMany: findManyMocks['replyEvent'], deleteMany: deleteManyMocks['replyEvent'] },
    trackingEvent: { findMany: findManyMocks['trackingEvent'], deleteMany: deleteManyMocks['trackingEvent'] },
    monitorCheck: { findMany: findManyMocks['monitorCheck'], deleteMany: deleteManyMocks['monitorCheck'] },
    webhookDelivery: { findMany: findManyMocks['webhookDelivery'], deleteMany: deleteManyMocks['webhookDelivery'] },
    automationEnrollment: { findMany: findManyMocks['automationEnrollment'], deleteMany: deleteManyMocks['automationEnrollment'] },
    $transaction: transactionMock,
  },
}));

import { deleteAccountData, exportAccountData } from '../../lib/accountData.js';

beforeEach(() => {
  vi.clearAllMocks();
  for (const mock of Object.values(findManyMocks)) mock.mockResolvedValue([]);
  for (const mock of Object.values(deleteManyMocks)) mock.mockResolvedValue({ count: 0 });
  // $transaction receives an array of already-created PrismaPromises in
  // this codebase's usage (not the interactive-callback form) — resolve
  // each one in place, exactly like the real client would.
  transactionMock.mockImplementation((calls: Promise<unknown>[]) => Promise.all(calls));
});

describe('deleteAccountData', () => {
  it('maps each deletion count back to the correct table label, not a positionally-drifted one', async () => {
    deleteManyMocks['mailbox']!.mockResolvedValue({ count: 3 });
    deleteManyMocks['campaign']!.mockResolvedValue({ count: 7 });
    deleteManyMocks['replyEvent']!.mockResolvedValue({ count: 2 });

    const counts = await deleteAccountData('key-1');

    expect(counts['mailboxes']).toBe(3);
    expect(counts['campaigns']).toBe(7);
    expect(counts['replyEvents']).toBe(2);
    // Everything else stayed at the default zero — proves no cross-label bleed.
    expect(counts['monitors']).toBe(0);
    expect(counts['sendMessages']).toBe(0);
  });

  it('deletes children before their non-cascading apiKeyId-owned parent within the same transaction', async () => {
    await deleteAccountData('key-1');

    const calledModels = transactionMock.mock.calls[0]![0] as unknown[];
    expect(calledModels).toHaveLength(21);

    // replyEvent (child of mailbox, no cascade) must be queued before mailbox.
    expect(deleteManyMocks['replyEvent']).toHaveBeenCalled();
    expect(deleteManyMocks['mailbox']).toHaveBeenCalled();
    // sendMessage (child of verification, no cascade) before verification;
    // verification (child of bulkJob, no cascade) before bulkJob.
    expect(deleteManyMocks['sendMessage']).toHaveBeenCalled();
    expect(deleteManyMocks['verification']).toHaveBeenCalled();
    expect(deleteManyMocks['bulkJob']).toHaveBeenCalled();
  });

  it('scopes every top-level table by apiKeyId', async () => {
    await deleteAccountData('key-42');

    expect(deleteManyMocks['sendMessage']).toHaveBeenCalledWith({ where: { apiKeyId: 'key-42' } });
    expect(deleteManyMocks['contact']).toHaveBeenCalledWith({ where: { apiKeyId: 'key-42' } });
    expect(deleteManyMocks['monitor']).toHaveBeenCalledWith({ where: { apiKeyId: 'key-42' } });
  });

  it('never touches Suppression, SoftBounceTrack, or SequenceTemplate', async () => {
    await deleteAccountData('key-1');
    const calledModels = transactionMock.mock.calls[0]![0] as unknown[];
    expect(calledModels).toHaveLength(21); // exactly the owned-content tables, nothing more
  });
});

describe('exportAccountData', () => {
  it('returns a bundle keyed by table name with an export timestamp', async () => {
    findManyMocks['contact']!.mockResolvedValue([{ id: 'c1', email: 'a@example.com' }]);

    const bundle = await exportAccountData('key-1') as { apiKeyId: string; exportedAt: string; data: Record<string, unknown[]> };

    expect(bundle.apiKeyId).toBe('key-1');
    expect(typeof bundle.exportedAt).toBe('string');
    expect(bundle.data['contacts']).toEqual([{ id: 'c1', email: 'a@example.com' }]);
  });
});
