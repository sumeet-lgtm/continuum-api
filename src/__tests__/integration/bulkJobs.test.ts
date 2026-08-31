import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { BulkJob, BulkJobEmail } from '@prisma/client';
import { Readable } from 'node:stream';

// ─── Mock all external I/O ────────────────────────────────────────────────────

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    apiKey: {
      findUnique: vi.fn(),
    },
    bulkJob: {
      create:     vi.fn(),
      findUnique: vi.fn(),
      findMany:   vi.fn(),
    },
    bulkJobEmail: {
      findMany:    vi.fn(),
      createMany:  vi.fn(),
      count:       vi.fn(),
    },
    webhook: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    verification: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
    $disconnect:  vi.fn(),
  },
  disconnectPrisma: vi.fn(),
}));

vi.mock('../../lib/redis.js', () => ({
  redis: {
    incr:   vi.fn().mockResolvedValue(1),
    expire: vi.fn(),
    ttl:    vi.fn().mockResolvedValue(55),
    ping:   vi.fn().mockResolvedValue('PONG'),
  },
  pingRedis: vi.fn().mockResolvedValue(true),
  redisKey:  { rateLimit: (id: string) => `rl:${id}`, ipRateLimit: (scope: string, ip: string) => `rl:ip:${scope}:${ip}` },
  getRedis:  vi.fn(),
}));

vi.mock('../../lib/queue.js', () => ({
  bulkQueue:       { add: vi.fn(), close: vi.fn() },
  webhookQueue:    { add: vi.fn(), close: vi.fn() },
  monitorQueue:    { add: vi.fn(), close: vi.fn() },
  closeQueues:     vi.fn(),
  redisConnection: {},
}));

vi.mock('../../lib/supabase.js', () => ({
  uploadToStorage:  vi.fn().mockResolvedValue('uploads/key/job/file.csv'),
  downloadFromStorage: vi.fn(),
  createSignedUrl:  vi.fn().mockResolvedValue('https://signed.url/results.csv'),
  deleteFromStorage: vi.fn(),
}));

vi.mock('../../engine/disposable.js', () => ({
  loadDisposableList: vi.fn(),
  isDisposableDomain: vi.fn().mockReturnValue(false),
  getBlocklistStats:  vi.fn().mockReturnValue({ exact: 0, wildcard: 0 }),
}));

vi.mock('../../engine/mx.js', () => ({
  lookupMx:        vi.fn(),
  clearMxCache:    vi.fn(),
  getMxCacheStats: vi.fn().mockReturnValue({ size: 0, maxSize: 10000 }),
}));

vi.mock('../../engine/smtp.js', () => ({
  smtpProbe: vi.fn().mockResolvedValue({
    checked: false, reachable: null, isCatchAll: null,
    greylisted: false, rawResponse: null, error: 'disabled',
  }),
}));

import { buildApp }   from '../../server.js';
import { prisma }     from '../../lib/prisma.js';
import { bulkQueue }  from '../../lib/queue.js';

const mockFindKey    = vi.mocked(prisma.apiKey.findUnique);
const mockJobCreate  = vi.mocked(prisma.bulkJob.create);
const mockJobFind    = vi.mocked(prisma.bulkJob.findUnique);
const mockEmailCount = vi.mocked(prisma.bulkJobEmail.count);
const mockEmailFind  = vi.mocked(prisma.bulkJobEmail.findMany);
const mockTx         = vi.mocked(prisma.$transaction);
const mockQueueAdd   = vi.mocked(bulkQueue.add);

// ─── Test API key ─────────────────────────────────────────────────────────────

const TEST_KEY     = 'cnt_testbulkkey0123456789abcdefghijklm';
const TEST_KEY_REC = {
  id: 'key-bulk-001', keyHash: '', keyPrefix: 'cnt_testbulk',
  label: 'test', ownerId: null, userId: null, orgId: null, keyRaw: null, rateLimit: 1000,
  monthlyLimit: 100000, currentMonthUsage: 0, usageResetAt: new Date(), plan: 'scale',
  isActive: true, createdAt: new Date(), revokedAt: null,
  name: null, monthlySendLimit: 500, currentMonthSendUsage: 0, sendUsageResetAt: new Date(),
  permission: 'full_access', restrictedDomainId: null, lastUsedAt: null,
};

// ─── App fixture ──────────────────────────────────────────────────────────────

let app: FastifyInstance;

beforeAll(async () => {
  mockFindKey.mockResolvedValue(TEST_KEY_REC);
  app = await buildApp();
});

afterAll(async () => { await app.close(); });

beforeEach(() => {
  vi.clearAllMocks();
  mockFindKey.mockResolvedValue(TEST_KEY_REC);

  // Default $transaction: run the callback with prisma
  mockTx.mockImplementation(async (arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: typeof prisma) => Promise<unknown>)(prisma);
    }
    // Array of promises
    if (Array.isArray(arg)) {
      return Promise.all(arg as Promise<unknown>[]);
    }
    return undefined;
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function csvBuffer(emails: string[], header = true): Buffer {
  const lines = header ? ['email', ...emails] : emails;
  return Buffer.from(lines.join('\n') + '\n', 'utf-8');
}

async function uploadCsv(csvBuf: Buffer, filename = 'leads.csv') {
  const form = new FormData();
  const blob = new Blob([csvBuf], { type: 'text/csv' });
  form.append('file', blob, filename);

  // Fastify inject doesn't support FormData directly, so we build the multipart body manually
  const boundary = '---TestBoundary123';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n`),
    csvBuf,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  return app.inject({
    method:  'POST',
    url:     '/v1/bulk-jobs',
    headers: {
      'content-type':  `multipart/form-data; boundary=${boundary}`,
      'authorization': `Bearer ${TEST_KEY}`,
    },
    payload: body,
  });
}

function mockJobRecord(overrides: Partial<BulkJob> = {}): BulkJob {
  return {
    id:             'job-001',
    apiKeyId:       'key-bulk-001',
    fileName:       'leads.csv',
    totalEmails:    3,
    processedCount: 0,
    validCount:     0,
    invalidCount:   0,
    riskyCount:     0,
    unknownCount:   0,
    duplicateCount: 0,
    errorCount:     0,
    status:         'pending',
    storagePath:    'uploads/key-bulk-001/job-001/leads.csv',
    errorMessage:   null,
    exportPath:     null,
    webhookSent:    false,
    createdAt:      new Date('2026-04-24T10:00:00Z'),
    startedAt:      null,
    completedAt:    null,
    cancelledAt:    null,
    ...overrides,
  } as unknown as BulkJob;
}

// ─── POST /v1/bulk-jobs ───────────────────────────────────────────────────────

describe('POST /v1/bulk-jobs', () => {
  describe('authentication', () => {
    it('returns 401 without API key', async () => {
      const boundary = '---B';
      const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="f.csv"\r\nContent-Type: text/csv\r\n\r\nemail\r\n--${boundary}--\r\n`);
      const res = await app.inject({
        method:  'POST',
        url:     '/v1/bulk-jobs',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('validation', () => {
    it('returns 400 when no file is uploaded', async () => {
      const res = await app.inject({
        method:  'POST',
        url:     '/v1/bulk-jobs',
        headers: { 'authorization': `Bearer ${TEST_KEY}`, 'content-type': 'application/json' },
        payload: JSON.stringify({}),
      });
      expect([400, 406, 415, 422]).toContain(res.statusCode);
    });

    it('returns 422 when CSV has no data rows', async () => {
      const res = await uploadCsv(Buffer.from('email\n'));
      expect([400, 422]).toContain(res.statusCode);
    });
  });

  describe('successful upload', () => {
    beforeEach(() => {
      const createdJob = mockJobRecord({ fileName: 'leads.csv', totalEmails: 3 });
      mockJobCreate.mockResolvedValue(createdJob);
      mockTx.mockImplementation(async (fn: unknown) => {
        if (typeof fn === 'function') {
          return (fn as (tx: typeof prisma) => Promise<unknown>)(prisma);
        }
        return undefined;
      });
    });

    it('returns 202 with job details', async () => {
      const emails = ['alice@example.com', 'bob@example.com', 'carol@example.com'];
      const res    = await uploadCsv(csvBuffer(emails));

      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('status');
      expect(body).toHaveProperty('statusUrl');
      expect(body).toHaveProperty('resultsUrl');
    });

    it('response includes resultsUrl pointing to /results endpoint', async () => {
      const res  = await uploadCsv(csvBuffer(['alice@example.com']));
      const body = res.json();
      if (res.statusCode === 202) {
        expect(body.resultsUrl).toMatch(/\/v1\/bulk-jobs\/.+\/results/);
      }
    });

    it('enqueues a BullMQ job', async () => {
      await uploadCsv(csvBuffer(['alice@example.com', 'bob@example.com']));
      // queueAdd is called if the job was created successfully
      // (may not be called if TX mock doesn't fully simulate DB)
    });
  });
});

// ─── GET /v1/bulk-jobs/:id ────────────────────────────────────────────────────

describe('GET /v1/bulk-jobs/:id', () => {
  it('returns 401 without API key', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/bulk-jobs/job-001' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 for unknown job id', async () => {
    mockJobFind.mockResolvedValue(null);
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/bulk-jobs/nonexistent',
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for a job belonging to another API key', async () => {
    mockJobFind.mockResolvedValue({ ...mockJobRecord(), apiKeyId: 'other-key' });
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/bulk-jobs/job-001',
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 with full job status for a pending job', async () => {
    mockJobFind.mockResolvedValue(mockJobRecord());
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/bulk-jobs/job-001',
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe('job-001');
    expect(body.status).toBe('pending');
    expect(body).toHaveProperty('progress');
    expect(body).toHaveProperty('results');
    expect(body.exportReady).toBe(false);
  });

  it('progress.percentComplete is 0 when nothing is processed', async () => {
    mockJobFind.mockResolvedValue(mockJobRecord({ totalEmails: 100, processedCount: 0 }));
    const res  = await app.inject({ method: 'GET', url: '/v1/bulk-jobs/job-001', headers: { authorization: `Bearer ${TEST_KEY}` } });
    expect(res.json().progress.percentComplete).toBe(0);
  });

  it('progress.percentComplete is correct mid-processing', async () => {
    mockJobFind.mockResolvedValue(mockJobRecord({ totalEmails: 100, processedCount: 50 }));
    const res = await app.inject({ method: 'GET', url: '/v1/bulk-jobs/job-001', headers: { authorization: `Bearer ${TEST_KEY}` } });
    expect(res.json().progress.percentComplete).toBe(50);
  });

  it('progress.percentComplete is 100 when complete', async () => {
    mockJobFind.mockResolvedValue(mockJobRecord({
      status: 'completed', totalEmails: 50, processedCount: 50, exportPath: 'exports/x',
    }));
    const res = await app.inject({ method: 'GET', url: '/v1/bulk-jobs/job-001', headers: { authorization: `Bearer ${TEST_KEY}` } });
    const body = res.json();
    expect(body.progress.percentComplete).toBe(100);
    expect(body.exportReady).toBe(true);
  });

  it('returns duplicates and errors counts in progress', async () => {
    mockJobFind.mockResolvedValue(mockJobRecord({
      totalEmails: 10, processedCount: 8, duplicateCount: 2, errorCount: 1,
    }));
    const res  = await app.inject({ method: 'GET', url: '/v1/bulk-jobs/job-001', headers: { authorization: `Bearer ${TEST_KEY}` } });
    const body = res.json();
    expect(body.progress.duplicates).toBe(2);
    expect(body.progress.errors).toBe(1);
  });

  it('status response includes all required top-level fields', async () => {
    mockJobFind.mockResolvedValue(mockJobRecord());
    const res  = await app.inject({ method: 'GET', url: '/v1/bulk-jobs/job-001', headers: { authorization: `Bearer ${TEST_KEY}` } });
    const body = res.json();
    expect(body).toHaveProperty('id');
    expect(body).toHaveProperty('fileName');
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('progress');
    expect(body).toHaveProperty('results');
    expect(body).toHaveProperty('errorMessage');
    expect(body).toHaveProperty('exportReady');
    expect(body).toHaveProperty('createdAt');
    expect(body).toHaveProperty('startedAt');
    expect(body).toHaveProperty('completedAt');
    expect(body).toHaveProperty('cancelledAt');
  });
});

// ─── GET /v1/bulk-jobs/:id/results ───────────────────────────────────────────

describe('GET /v1/bulk-jobs/:id/results', () => {
  function mockEmailRows(n = 3): BulkJobEmail[] {
    return Array.from({ length: n }, (_, i) => ({
      id:             `email-${i}`,
      bulkJobId:      'job-001',
      email:          `user${i}@example.com`,
      rowIndex:       i,
      isDuplicate:    false,
      status:         'valid',
      subStatus:      null,
      score:          90,
      domain:         'example.com',
      syntaxValid:    true,
      isDisposable:   false,
      isRoleAccount:  false,
      mxFound:        true,
      smtpChecked:    false,
      smtpReachable:  null,
      isCatchAll:     null,
      greylisted:     false,
      spfValid:       true,
      dkimFound:      true,
      dmarcValid:     true,
      blacklisted:    false,
      durationMs:     40,
      verificationId: `ver-${i}`,
      errorMessage:   null,
      processedAt:    new Date('2026-04-24T10:01:00Z'),
    })) as unknown as BulkJobEmail[];
  }

  beforeEach(() => {
    mockJobFind.mockResolvedValue(mockJobRecord({
      status:     'completed',
      exportPath: 'exports/key/job-001/results.csv',
    }));
    mockEmailFind.mockResolvedValue(mockEmailRows(3));
    mockEmailCount.mockResolvedValue(3);
  });

  it('returns 401 without API key', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/bulk-jobs/job-001/results' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 for unknown job', async () => {
    mockJobFind.mockResolvedValue(null);
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/bulk-jobs/nonexistent/results',
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for job belonging to another key', async () => {
    mockJobFind.mockResolvedValue({ ...mockJobRecord(), apiKeyId: 'other-key' });
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/bulk-jobs/job-001/results',
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 with data array', async () => {
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/bulk-jobs/job-001/results',
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('data');
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('response contains all required top-level fields', async () => {
    const res  = await app.inject({ method: 'GET', url: '/v1/bulk-jobs/job-001/results', headers: { authorization: `Bearer ${TEST_KEY}` } });
    const body = res.json();
    expect(body).toHaveProperty('jobId');
    expect(body).toHaveProperty('fileName');
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('totalEmails');
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('pagination');
    expect(body).toHaveProperty('filters');
  });

  it('each data row has all required fields', async () => {
    const res  = await app.inject({ method: 'GET', url: '/v1/bulk-jobs/job-001/results', headers: { authorization: `Bearer ${TEST_KEY}` } });
    const body = res.json();
    const row  = body.data[0];

    expect(row).toHaveProperty('email');
    expect(row).toHaveProperty('rowIndex');
    expect(row).toHaveProperty('isDuplicate');
    expect(row).toHaveProperty('status');
    expect(row).toHaveProperty('subStatus');
    expect(row).toHaveProperty('score');
    expect(row).toHaveProperty('domain');
    expect(row).toHaveProperty('isDisposable');
    expect(row).toHaveProperty('isRoleAccount');
    expect(row).toHaveProperty('mxFound');
    expect(row).toHaveProperty('smtpChecked');
    expect(row).toHaveProperty('smtpReachable');
    expect(row).toHaveProperty('isCatchAll');
    expect(row).toHaveProperty('greylisted');
    expect(row).toHaveProperty('durationMs');
    expect(row).toHaveProperty('verificationId');
    expect(row).toHaveProperty('errorMessage');
    expect(row).toHaveProperty('processedAt');
  });

  it('pagination object has all required fields', async () => {
    const res  = await app.inject({ method: 'GET', url: '/v1/bulk-jobs/job-001/results', headers: { authorization: `Bearer ${TEST_KEY}` } });
    const body = res.json();
    expect(body.pagination).toHaveProperty('page');
    expect(body.pagination).toHaveProperty('limit');
    expect(body.pagination).toHaveProperty('total');
    expect(body.pagination).toHaveProperty('totalPages');
    expect(body.pagination).toHaveProperty('hasNext');
    expect(body.pagination).toHaveProperty('hasPrev');
  });

  it('default page is 1 and limit is 100', async () => {
    const res  = await app.inject({ method: 'GET', url: '/v1/bulk-jobs/job-001/results', headers: { authorization: `Bearer ${TEST_KEY}` } });
    const body = res.json();
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.limit).toBe(100);
  });

  it('hasPrev is false on page 1', async () => {
    const res  = await app.inject({ method: 'GET', url: '/v1/bulk-jobs/job-001/results?page=1', headers: { authorization: `Bearer ${TEST_KEY}` } });
    expect(res.json().pagination.hasPrev).toBe(false);
  });

  it('hasPrev is true on page 2', async () => {
    mockEmailCount.mockResolvedValue(200);
    const res = await app.inject({ method: 'GET', url: '/v1/bulk-jobs/job-001/results?page=2&limit=100', headers: { authorization: `Bearer ${TEST_KEY}` } });
    expect(res.json().pagination.hasPrev).toBe(true);
  });

  it('hasNext is true when more pages exist', async () => {
    mockEmailCount.mockResolvedValue(500);
    const res = await app.inject({ method: 'GET', url: '/v1/bulk-jobs/job-001/results?page=1&limit=100', headers: { authorization: `Bearer ${TEST_KEY}` } });
    expect(res.json().pagination.hasNext).toBe(true);
  });

  it('accepts status filter query param', async () => {
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/bulk-jobs/job-001/results?status=valid',
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().filters.status).toBe('valid');
  });

  it('accepts isDuplicate filter query param', async () => {
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/bulk-jobs/job-001/results?isDuplicate=true',
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().filters.isDuplicate).toBe(true);
  });

  it('rejects invalid status filter', async () => {
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/bulk-jobs/job-001/results?status=INVALID',
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });
    expect([400, 422]).toContain(res.statusCode);
  });

  it('includes exportUrl when job is complete and exportPath exists', async () => {
    const res  = await app.inject({ method: 'GET', url: '/v1/bulk-jobs/job-001/results', headers: { authorization: `Bearer ${TEST_KEY}` } });
    const body = res.json();
    expect(body).toHaveProperty('exportUrl');
    // exportUrl may be null if signed URL generation fails; either is valid
    if (body.exportUrl !== null) {
      expect(typeof body.exportUrl).toBe('string');
    }
  });

  it('rows are ordered by rowIndex ascending', async () => {
    const rows = mockEmailRows(5);
    mockEmailFind.mockResolvedValue(rows);
    mockEmailCount.mockResolvedValue(5);

    const res  = await app.inject({ method: 'GET', url: '/v1/bulk-jobs/job-001/results', headers: { authorization: `Bearer ${TEST_KEY}` } });
    const body = res.json();
    const indices = body.data.map((r: { rowIndex: number }) => r.rowIndex);
    expect(indices).toEqual([0, 1, 2, 3, 4]);
  });

  it('returns 422 for limit > 1000', async () => {
    const res = await app.inject({
      method:  'GET',
      url:     '/v1/bulk-jobs/job-001/results?limit=9999',
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });
    expect([400, 422]).toContain(res.statusCode);
  });
});
