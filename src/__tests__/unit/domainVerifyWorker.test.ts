import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/queue.js', () => ({ QUEUE_DOMAIN_VERIFY: 'continuum-domain-verify', redisConnection: {} }));
vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({ on: vi.fn(), close: vi.fn() })),
  Queue: vi.fn().mockImplementation(() => ({ add: vi.fn(), close: vi.fn() })),
}));
vi.mock('../../lib/prisma.js', () => ({
  prisma: { sendingDomain: { findMany: vi.fn() } },
}));
vi.mock('../../lib/domainVerify.js', () => ({ verifyDomain: vi.fn() }));

import { processDomainVerifyTick } from '../../workers/domainVerifyWorker.js';
import { prisma } from '../../lib/prisma.js';
import { verifyDomain } from '../../lib/domainVerify.js';

const mockFindMany = vi.mocked(prisma.sendingDomain.findMany);
const mockVerifyDomain = vi.mocked(verifyDomain);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('processDomainVerifyTick', () => {
  it('does nothing when there are no pending domains', async () => {
    mockFindMany.mockResolvedValue([] as never);
    await processDomainVerifyTick();
    expect(mockVerifyDomain).not.toHaveBeenCalled();
  });

  it('rechecks every pending domain across every customer — the actual gap this fixes: nothing did this before', async () => {
    mockFindMany.mockResolvedValue([
      { id: 'dom-1', apiKeyId: 'key-1', name: 'wyberai.com', region: 'us-east-1', dkimStatus: 'pending', verifiedAt: null },
      { id: 'dom-2', apiKeyId: 'key-2', name: 'other.com', region: 'us-east-1', dkimStatus: 'pending', verifiedAt: null },
    ] as never);
    mockVerifyDomain.mockResolvedValue({ updated: {} as never, health: {} as never, justVerified: false });

    await processDomainVerifyTick();

    expect(mockVerifyDomain).toHaveBeenCalledTimes(2);
    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: 'pending' } }));
  });

  it('keeps checking the remaining domains even when one fails (a bad domain must not block everyone else in the same tick)', async () => {
    mockFindMany.mockResolvedValue([
      { id: 'dom-1', apiKeyId: 'key-1', name: 'broken.com', region: 'us-east-1', dkimStatus: 'pending', verifiedAt: null },
      { id: 'dom-2', apiKeyId: 'key-2', name: 'fine.com', region: 'us-east-1', dkimStatus: 'pending', verifiedAt: null },
    ] as never);
    mockVerifyDomain
      .mockRejectedValueOnce(new Error('SES throttled'))
      .mockResolvedValueOnce({ updated: {} as never, health: {} as never, justVerified: true });

    await expect(processDomainVerifyTick()).resolves.not.toThrow();
    expect(mockVerifyDomain).toHaveBeenCalledTimes(2);
  });
});
