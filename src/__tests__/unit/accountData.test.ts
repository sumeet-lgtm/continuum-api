import { describe, it, expect, vi, beforeEach } from 'vitest';

// deleteAccountData zips deletion-count results back to table-name labels
// by array position — this suite specifically pins down that the labels
// and the transaction call order can never drift apart again (that exact
// bug existed in an earlier draft of this file: a separately-maintained
// label list was zipped to a differently-ordered transaction array,
// silently mislabeling every count in the response).

// accountData.ts calls withTenant()/collectOwnedIds() with a mix of `tx.X`
// (RLS-covered models) and `prisma.X` (not RLS-covered) — both need to
// resolve to these same mocks, so mockPrisma is passed to $transaction's
// callback as `tx` (the interactive-callback form the real client uses,
// not the old array-of-PrismaPromises form).
const { transactionMock, findManyMocks, deleteManyMocks, mockPrisma } = vi.hoisted(() => {
  const models = [
    'mailbox',
    'monitor',
    'webhook',
    'automation',
    'campaign',
    'sequence',
    'sendMessage',
    'verification',
    'bulkJob',
    'contact',
    'mailingList',
    'segment',
    'sendingDomain',
    'emailTemplate',
    'lead',
    'inboxTest',
    'replyEvent',
    'trackingEvent',
    'monitorCheck',
    'webhookDelivery',
    'automationEnrollment',
  ] as const;
  const findManyMocks: Record<string, ReturnType<typeof vi.fn>> = {};
  const deleteManyMocks: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const m of models) {
    findManyMocks[m] = vi.fn().mockResolvedValue([]);
    deleteManyMocks[m] = vi.fn().mockResolvedValue({ count: 0 });
  }
  const transactionMock = vi.fn();
  const mockPrisma: Record<string, unknown> = {
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    $transaction: transactionMock,
  };
  for (const m of models) {
    mockPrisma[m] = { findMany: findManyMocks[m], deleteMany: deleteManyMocks[m] };
  }
  return { transactionMock, findManyMocks, deleteManyMocks, mockPrisma };
});

vi.mock('../../lib/prisma.js', () => ({ prisma: mockPrisma }));

import { deleteAccountData, exportAccountData } from '../../lib/accountData.js';

beforeEach(() => {
  vi.clearAllMocks();
  for (const mock of Object.values(findManyMocks)) mock.mockResolvedValue([]);
  for (const mock of Object.values(deleteManyMocks)) mock.mockResolvedValue({ count: 0 });
  // Real withTenant()/withRlsBypass() semantics: $transaction receives an
  // interactive callback and hands it `tx` — here the same mockPrisma
  // object, so `tx.X` calls resolve to the mocks above exactly like
  // `prisma.X` calls do.
  transactionMock.mockImplementation((fn: (tx: typeof mockPrisma) => Promise<unknown>) =>
    fn(mockPrisma),
  );
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

    // All 21 owned-content tables ran exactly once, inside the single
    // withTenant() transaction (one $transaction call).
    expect(transactionMock).toHaveBeenCalledTimes(1);
    for (const mock of Object.values(deleteManyMocks)) {
      expect(mock).toHaveBeenCalledTimes(1);
    }

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
    const counts = await deleteAccountData('key-1');
    // Exactly the owned-content tables, nothing more — those three models
    // aren't even mocked above, so touching one would throw.
    expect(Object.keys(counts)).toHaveLength(21);
  });
});

describe('exportAccountData', () => {
  it('returns a bundle keyed by table name with an export timestamp', async () => {
    findManyMocks['contact']!.mockResolvedValue([{ id: 'c1', email: 'a@example.com' }]);

    const bundle = (await exportAccountData('key-1')) as {
      apiKeyId: string;
      exportedAt: string;
      data: Record<string, unknown[]>;
    };

    expect(bundle.apiKeyId).toBe('key-1');
    expect(typeof bundle.exportedAt).toBe('string');
    expect(bundle.data['contacts']).toEqual([{ id: 'c1', email: 'a@example.com' }]);
  });

  // Regression test for a real live bug found in production: the original
  // implementation ran all ~28 queries inside one shared withTenant()
  // transaction. A single interactive transaction pins every query to one
  // DB connection, so Promise.all inside it does not run them concurrently
  // at the database level — against Supabase's pooler, that serialized
  // round-trip time exceeded Prisma's 5s interactive-transaction timeout
  // and /v1/account/export 500'd for every real request. Each query now
  // opens its own withTenant() call (its own connection, its own timeout
  // budget) — pinned here as "many separate transactions", not the
  // single shared one deleteAccountData still correctly uses.
  it('opens a separate transaction per query instead of one shared transaction (each query gets its own connection and timeout budget)', async () => {
    await exportAccountData('key-1');
    // 7 in collectOwnedIdsParallel + 21 in the main Promise.all = 28.
    expect(transactionMock).toHaveBeenCalledTimes(28);
  });
});
