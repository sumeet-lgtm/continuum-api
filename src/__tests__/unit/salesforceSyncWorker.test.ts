import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    salesforceConnection: { findMany: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    salesforceLeadSync:   { findMany: vi.fn().mockResolvedValue([]), upsert: vi.fn(), update: vi.fn() },
    lead:                 { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({}) },
    mailbox:              { findMany: vi.fn().mockResolvedValue([]) },
    replyEvent:           { findMany: vi.fn().mockResolvedValue([]) },
    sequenceEnrollment:   { updateMany: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({ on: vi.fn(), close: vi.fn() })),
  Queue:  vi.fn().mockImplementation(() => ({ add: vi.fn(), close: vi.fn() })),
}));

vi.mock('../../lib/queue.js', () => ({
  QUEUE_SALESFORCE_SYNC: 'continuum-salesforce-sync',
  redisConnection: {},
}));

vi.mock('../../lib/oauth/salesforce.js', () => ({
  getSalesforceAccessToken: vi.fn().mockResolvedValue('fake-access-token'),
}));

vi.mock('../../lib/crypto.js', () => ({
  decryptValue: vi.fn().mockReturnValue('fake-refresh-token'),
}));

vi.mock('../../lib/salesforceApi.js', () => ({
  findLeadByEmail: vi.fn(),
  createLead: vi.fn(),
  updateLead: vi.fn(),
  logActivity: vi.fn(),
  queryLeadsById: vi.fn().mockResolvedValue([]),
  SalesforceApiError: class SalesforceApiError extends Error {
    status: number;
    constructor(message: string, status: number) { super(message); this.status = status; }
  },
}));

import { prisma } from '../../lib/prisma.js';
import * as sfApi from '../../lib/salesforceApi.js';

const mockConnFindMany = vi.mocked(prisma.salesforceConnection.findMany);
const mockLeadFindMany = vi.mocked(prisma.lead.findMany);
const mockSyncFindMany = vi.mocked(prisma.salesforceLeadSync.findMany);
const mockSyncUpsert   = vi.mocked(prisma.salesforceLeadSync.upsert);
const mockLeadUpdateMany = vi.mocked(prisma.lead.updateMany);
const mockEnrollmentUpdateMany = vi.mocked(prisma.sequenceEnrollment.updateMany);
const mockFindLeadByEmail = vi.mocked(sfApi.findLeadByEmail);
const mockCreateLead = vi.mocked(sfApi.createLead);
const mockUpdateLead = vi.mocked(sfApi.updateLead);
const mockQueryLeadsById = vi.mocked(sfApi.queryLeadsById);

function makeConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-1',
    apiKeyId: 'key-1',
    instanceUrl: 'https://test.my.salesforce.com',
    refreshTokenEnc: 'enc',
    syncEnabled: true,
    lastPushedAt: null,
    lastPulledAt: null,
    ...overrides,
  };
}

function makeLead(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lead-1',
    apiKeyId: 'key-1',
    email: 'lead@example.com',
    firstName: 'Ada',
    lastName: 'Lovelace',
    company: 'Acme Inc',
    title: 'Engineer',
    status: 'active',
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConnFindMany.mockResolvedValue([]);
  mockLeadFindMany.mockResolvedValue([]);
  mockSyncFindMany.mockResolvedValue([]);
  mockQueryLeadsById.mockResolvedValue([]);
});

describe('processSalesforceSyncTick — pushing leads', () => {
  it('creates a new Salesforce Lead for a Continuum lead with no prior sync, falling back to the email domain for a missing company', async () => {
    mockConnFindMany.mockResolvedValue([makeConnection()] as never);
    mockLeadFindMany.mockResolvedValue([makeLead({ company: null })] as never);
    mockFindLeadByEmail.mockResolvedValue(null);
    mockCreateLead.mockResolvedValue('00Qxx0000001');

    const { processSalesforceSyncTick } = await import('../../workers/salesforceSyncWorker.js');
    await processSalesforceSyncTick();

    expect(mockCreateLead).toHaveBeenCalledWith(
      'https://test.my.salesforce.com',
      'fake-access-token',
      expect.objectContaining({ Email: 'lead@example.com', Company: 'Example' }),
    );
    expect(mockSyncUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ salesforceId: '00Qxx0000001' }),
      }),
    );
  });

  it('reuses an existing Salesforce Lead found by email instead of creating a duplicate', async () => {
    mockConnFindMany.mockResolvedValue([makeConnection()] as never);
    mockLeadFindMany.mockResolvedValue([makeLead()] as never);
    mockFindLeadByEmail.mockResolvedValue({ id: '00Qxx0000002', status: 'Open', lastModified: new Date().toISOString(), converted: false, convertedContactId: null });

    const { processSalesforceSyncTick } = await import('../../workers/salesforceSyncWorker.js');
    await processSalesforceSyncTick();

    expect(mockCreateLead).not.toHaveBeenCalled();
    expect(mockSyncUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ salesforceId: '00Qxx0000002' }) }),
    );
  });

  it('updates in place (no lookup, no create) for a lead that already has a sync record', async () => {
    const oldPush = new Date(Date.now() - 1000);
    mockConnFindMany.mockResolvedValue([makeConnection()] as never);
    mockLeadFindMany.mockResolvedValue([makeLead({ updatedAt: new Date() })] as never);
    mockSyncFindMany.mockResolvedValue([
      { apiKeyId: 'key-1', leadEmail: 'lead@example.com', salesforceId: '00Qxx0000003', lastPushedAt: oldPush },
    ] as never);

    const { processSalesforceSyncTick } = await import('../../workers/salesforceSyncWorker.js');
    await processSalesforceSyncTick();

    expect(mockFindLeadByEmail).not.toHaveBeenCalled();
    expect(mockCreateLead).not.toHaveBeenCalled();
    expect(mockUpdateLead).toHaveBeenCalledWith('https://test.my.salesforce.com', 'fake-access-token', '00Qxx0000003', expect.any(Object));
  });
});

describe('processSalesforceSyncTick — pulling status back', () => {
  it('pauses the active sequence enrollment and marks the lead do_not_contact when Salesforce Status is a stop status', async () => {
    mockConnFindMany.mockResolvedValue([makeConnection()] as never);
    mockSyncFindMany.mockResolvedValue([
      { id: 'sync-1', apiKeyId: 'key-1', leadEmail: 'lead@example.com', salesforceId: '00Qxx0000004', sfObjectType: 'Lead', lastSfStatus: 'Open', lastPushedAt: new Date() },
    ] as never);
    mockQueryLeadsById.mockResolvedValue([
      { Id: '00Qxx0000004', Status: 'Unqualified', LastModifiedDate: new Date().toISOString(), IsConverted: false, ConvertedContactId: null },
    ] as never);

    const { processSalesforceSyncTick } = await import('../../workers/salesforceSyncWorker.js');
    await processSalesforceSyncTick();

    expect(mockLeadUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { apiKeyId: 'key-1', email: 'lead@example.com' }, data: { status: 'do_not_contact' } }),
    );
    expect(mockEnrollmentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ email: 'lead@example.com', status: 'active' }), data: { status: 'paused' } }),
    );
  });

  it('does nothing when the Salesforce status is unchanged and the lead is not converted', async () => {
    mockConnFindMany.mockResolvedValue([makeConnection()] as never);
    mockSyncFindMany.mockResolvedValue([
      { id: 'sync-1', apiKeyId: 'key-1', leadEmail: 'lead@example.com', salesforceId: '00Qxx0000005', sfObjectType: 'Lead', lastSfStatus: 'Working', lastPushedAt: new Date() },
    ] as never);
    mockQueryLeadsById.mockResolvedValue([
      { Id: '00Qxx0000005', Status: 'Working', LastModifiedDate: new Date().toISOString(), IsConverted: false, ConvertedContactId: null },
    ] as never);

    const { processSalesforceSyncTick } = await import('../../workers/salesforceSyncWorker.js');
    await processSalesforceSyncTick();

    expect(mockLeadUpdateMany).not.toHaveBeenCalled();
    expect(mockEnrollmentUpdateMany).not.toHaveBeenCalled();
  });
});

describe('processSalesforceSyncTick — connection scope', () => {
  it('only queries syncEnabled connections', async () => {
    mockConnFindMany.mockResolvedValue([]);

    const { processSalesforceSyncTick } = await import('../../workers/salesforceSyncWorker.js');
    await processSalesforceSyncTick();

    expect(mockConnFindMany).toHaveBeenCalledWith({ where: { syncEnabled: true } });
  });
});
