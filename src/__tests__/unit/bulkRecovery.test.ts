import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock all I/O ─────────────────────────────────────────────────────────────

const findMany = vi.fn();
const update   = vi.fn();
const fakeTx   = { bulkJob: { findMany, update } };

vi.mock('../../lib/tenantContext.js', () => ({
  withRlsBypass: vi.fn((fn: (tx: unknown) => unknown) => fn(fakeTx)),
  withTenant:    vi.fn((_id: string, fn: (tx: unknown) => unknown) => fn(fakeTx)),
}));

vi.mock('../../lib/prisma.js', () => ({ prisma: { $disconnect: vi.fn() } }));
vi.mock('../../lib/supabase.js', () => ({ downloadFromStorage: vi.fn(), uploadToStorage: vi.fn() }));
vi.mock('../../lib/queue.js', () => ({
  QUEUE_BULK:      'continuum:bulk',
  webhookQueue:    { add: vi.fn() },
  redisConnection: {},
}));
vi.mock('../../engine/index.js', () => ({ verifyEmail: vi.fn() }));
vi.mock('../../engine/disposable.js', () => ({ loadDisposableList: vi.fn() }));

const queueAdd    = vi.fn();
const queueGetJob = vi.fn();
const queueClose  = vi.fn();
vi.mock('bullmq', () => ({
  Worker: class { on = vi.fn(); close = vi.fn(); },
  Queue:  class { add = queueAdd; getJob = queueGetJob; close = queueClose; },
}));

import { recoverStalledJobs } from '../../workers/bulkWorker.js';

const job = (id: string, status: 'pending' | 'processing') => ({
  id, status, fileName: 'list.csv', apiKeyId: 'key-1', storagePath: `uploads/${id}.csv`,
});

const queueEntry = (state: string) => ({ getState: vi.fn().mockResolvedValue(state), remove: vi.fn() });

beforeEach(() => {
  vi.clearAllMocks();
  queueGetJob.mockResolvedValue(undefined);
});

describe('recoverStalledJobs', () => {
  it('queries both stalled processing jobs and orphaned pending jobs', async () => {
    findMany.mockResolvedValue([]);
    await recoverStalledJobs();
    const where = findMany.mock.calls[0]![0].where;
    expect(where.OR).toEqual([
      { status: 'processing', startedAt: { lt: expect.any(Date) } },
      { status: 'pending',    createdAt: { lt: expect.any(Date) } },
    ]);
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('re-enqueues an orphaned pending job whose queue entry is gone, without touching its DB row', async () => {
    findMany.mockResolvedValue([job('a', 'pending')]);
    await recoverStalledJobs();
    expect(update).not.toHaveBeenCalled();
    expect(queueAdd).toHaveBeenCalledWith(
      'process-bulk',
      { jobId: 'a', apiKeyId: 'key-1', storagePath: 'uploads/a.csv', fileName: 'list.csv' },
      { jobId: 'bulk-a' },
    );
  });

  it('removes a dead failed entry first — otherwise the same-jobId add is a silent no-op', async () => {
    const dead = queueEntry('failed');
    queueGetJob.mockResolvedValue(dead);
    findMany.mockResolvedValue([job('b', 'pending')]);
    await recoverStalledJobs();
    expect(dead.remove).toHaveBeenCalled();
    expect(queueAdd).toHaveBeenCalledTimes(1);
  });

  it.each(['active', 'waiting', 'delayed'])('leaves a job alone when its queue entry is %s', async (state) => {
    const live = queueEntry(state);
    queueGetJob.mockResolvedValue(live);
    findMany.mockResolvedValue([job('c', 'processing')]);
    await recoverStalledJobs();
    expect(live.remove).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('resets a stalled processing job to pending (keeping counts) before re-enqueuing', async () => {
    findMany.mockResolvedValue([job('d', 'processing')]);
    await recoverStalledJobs();
    expect(update).toHaveBeenCalledWith({ where: { id: 'd' }, data: { status: 'pending', startedAt: null } });
    expect(queueAdd).toHaveBeenCalledTimes(1);
  });

  it('one job failing to recover does not stop the rest of the sweep', async () => {
    queueGetJob.mockRejectedValueOnce(new Error('redis blip')).mockResolvedValue(undefined);
    findMany.mockResolvedValue([job('e', 'pending'), job('f', 'pending')]);
    await recoverStalledJobs();
    expect(queueAdd).toHaveBeenCalledTimes(1);
    expect(queueAdd.mock.calls[0]![2]).toEqual({ jobId: 'bulk-f' });
    expect(queueClose).toHaveBeenCalledTimes(1);
  });
});
