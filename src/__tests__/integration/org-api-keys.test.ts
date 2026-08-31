import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// Previously nothing let an org admin see or act on the API keys their
// team members own — org roles only reached the WorkOS-managed dashboard
// shell (invites, role changes), never the actual product resources.
// This suite covers the first real teeth on that: GET/DELETE /org/api-keys.

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    apiKey: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'log-1' }) },
  },
}));

vi.mock('@workos-inc/node', () => ({
  WorkOS: vi.fn().mockImplementation(function FakeWorkOS(this: object) { /* not used by these two endpoints */ }),
}));

import { orgRoutes } from '../../routes/org/index.js';
import { signSession } from '../../lib/session.js';
import { prisma } from '../../lib/prisma.js';

const mockFindUser = vi.mocked(prisma.user.findUnique);
const mockFindManyKeys = vi.mocked(prisma.apiKey.findMany);
const mockFindFirstKey = vi.mocked(prisma.apiKey.findFirst);
const mockUpdateKey = vi.mocked(prisma.apiKey.update);
const mockAuditCreate = vi.mocked(prisma.auditLog.create);

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  await app.register(orgRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockFindUser.mockResolvedValue({ id: 'user-1', email: 'admin@acme.com', orgId: 'org-1' } as never);
});

async function adminAuth(orgRole = 'admin') {
  const token = await signSession({ userId: 'user-1', email: 'admin@acme.com', orgId: 'org-1', orgRole });
  return { authorization: `Bearer ${token}` };
}

describe('GET /org/api-keys', () => {
  it('lists only keys tagged with the admin\'s own org', async () => {
    mockFindManyKeys.mockResolvedValue([
      { id: 'key-1', keyPrefix: 'cnt_abc', name: 'Prod', label: null, permission: 'full_access', plan: 'growth', isActive: true, revokedAt: null, createdAt: new Date(), lastUsedAt: null },
    ] as never);

    const res = await app.inject({ method: 'GET', url: '/org/api-keys', headers: await adminAuth() });

    expect(res.statusCode).toBe(200);
    expect(mockFindManyKeys).toHaveBeenCalledWith(expect.objectContaining({ where: { orgId: 'org-1' } }));
    expect(res.json().data).toHaveLength(1);
  });

  it('rejects a non-admin org member', async () => {
    const res = await app.inject({ method: 'GET', url: '/org/api-keys', headers: await adminAuth('member') });
    expect(res.statusCode).toBe(403);
    expect(mockFindManyKeys).not.toHaveBeenCalled();
  });
});

describe('DELETE /org/api-keys/:id', () => {
  it('revokes a key that belongs to the admin\'s org', async () => {
    mockFindFirstKey.mockResolvedValue({ id: 'key-1', isActive: true } as never);

    const res = await app.inject({ method: 'DELETE', url: '/org/api-keys/key-1', headers: await adminAuth() });

    expect(res.statusCode).toBe(200);
    expect(mockFindFirstKey).toHaveBeenCalledWith({ where: { id: 'key-1', orgId: 'org-1' }, select: { id: true, isActive: true } });
    expect(mockUpdateKey).toHaveBeenCalledWith({ where: { id: 'key-1' }, data: { isActive: false, revokedAt: expect.any(Date) } });
    expect(mockAuditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'api_key.revoked_by_org_admin', orgId: 'org-1', apiKeyId: 'key-1' }),
    }));
  });

  it('returns 404 without revoking when the key belongs to a different org', async () => {
    mockFindFirstKey.mockResolvedValue(null); // scoped query finds nothing under this org

    const res = await app.inject({ method: 'DELETE', url: '/org/api-keys/someone-elses-key', headers: await adminAuth() });

    expect(res.statusCode).toBe(404);
    expect(mockUpdateKey).not.toHaveBeenCalled();
  });

  it('rejects a non-admin org member', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/org/api-keys/key-1', headers: await adminAuth('member') });
    expect(res.statusCode).toBe(403);
    expect(mockUpdateKey).not.toHaveBeenCalled();
  });
});
