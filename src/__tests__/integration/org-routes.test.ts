import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type * as ConfigModule from '../../config.js';

// Covers the org/index.ts routes not already covered by org-api-keys.test.ts:
// GET /org, GET /org/members, PATCH/DELETE /org/members/:id, PATCH /org/settings,
// GET /org/audit-logs/events (both the orgId-scoped and actorId-fallback cases).
// These previously had zero test coverage even before the org-scoped RLS pass
// wrapped every one of them in withOrgTenant/withRlsBypass — added here so that
// wrapping is actually exercised, not just typechecked.

const { mockGetOrganization, mockUpdateMembership, mockDeactivateMembership } = vi.hoisted(() => ({
  mockGetOrganization: vi.fn(),
  mockUpdateMembership: vi.fn(),
  mockDeactivateMembership: vi.fn(),
}));

vi.mock('../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConfigModule>();
  return { ...actual, config: { ...actual.config, WORKOS_API_KEY: 'test_workos_key' } };
});

vi.mock('@workos-inc/node', () => ({
  WorkOS: vi.fn().mockImplementation(function FakeWorkOS(this: {
    organizations: unknown;
    userManagement: unknown;
  }) {
    this.organizations = { getOrganization: mockGetOrganization };
    this.userManagement = {
      updateOrganizationMembership: mockUpdateMembership,
      deactivateOrganizationMembership: mockDeactivateMembership,
    };
  }),
}));

vi.mock('../../lib/prisma.js', () => {
  const prisma: {
    user: { findUnique: ReturnType<typeof vi.fn> };
    orgSettings: { findUnique: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };
    orgMember: {
      count: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    auditLog: {
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
    };
    $transaction?: ReturnType<typeof vi.fn>;
    $executeRawUnsafe?: ReturnType<typeof vi.fn>;
  } = {
    user: { findUnique: vi.fn() },
    orgSettings: { findUnique: vi.fn(), upsert: vi.fn() },
    orgMember: { count: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    auditLog: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: 'log-1' }),
    },
  };
  // withOrgTenant/withRlsBypass call prisma.$transaction(fn) and hand fn
  // the tx — here the same mock object, so tx.<model> resolves to the
  // mocks above.
  prisma.$transaction = vi.fn((fn: (tx: typeof prisma) => unknown) => fn(prisma));
  prisma.$executeRawUnsafe = vi.fn().mockResolvedValue(undefined);
  return { prisma };
});

import { orgRoutes } from '../../routes/org/index.js';
import { signSession } from '../../lib/session.js';
import { prisma } from '../../lib/prisma.js';

const mockFindUser = vi.mocked(prisma.user.findUnique);
const mockSettingsFind = vi.mocked(prisma.orgSettings.findUnique);
const mockSettingsUpsert = vi.mocked(prisma.orgSettings.upsert);
const mockMemberCount = vi.mocked(prisma.orgMember.count);
const mockMemberFindMany = vi.mocked(prisma.orgMember.findMany);
const mockMemberUpdate = vi.mocked(prisma.orgMember.update);
const mockAuditFindMany = vi.mocked(prisma.auditLog.findMany);
const mockAuditCount = vi.mocked(prisma.auditLog.count);

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
  mockFindUser.mockResolvedValue({
    id: 'user-1',
    email: 'admin@acme.com',
    orgId: 'org-1',
  } as never);
  mockGetOrganization.mockRejectedValue(new Error('not reached in these tests'));
});

async function sessionAuth(opts: { orgId?: string | null; orgRole?: string } = {}) {
  const token = await signSession({
    userId: 'user-1',
    email: 'admin@acme.com',
    orgId: opts.orgId === undefined ? 'org-1' : (opts.orgId ?? undefined),
    orgRole: opts.orgRole ?? 'admin',
  });
  return { authorization: `Bearer ${token}` };
}

describe('GET /org', () => {
  it("returns org settings and member count scoped to the caller's own org", async () => {
    mockSettingsFind.mockResolvedValue({
      name: 'Acme',
      domain: 'acme.com',
      mfaRequired: true,
    } as never);
    mockMemberCount.mockResolvedValue(4 as never);

    const res = await app.inject({ method: 'GET', url: '/org', headers: await sessionAuth() });

    expect(res.statusCode).toBe(200);
    expect(mockSettingsFind).toHaveBeenCalledWith({ where: { orgId: 'org-1' } });
    expect(mockMemberCount).toHaveBeenCalledWith({ where: { orgId: 'org-1', status: 'active' } });
    expect(res.json()).toMatchObject({ orgId: 'org-1', name: 'Acme', memberCount: 4 });
  });

  it('returns not-configured when the session has no orgId', async () => {
    mockFindUser.mockResolvedValue({ id: 'user-1', email: 'admin@acme.com', orgId: null } as never);
    const res = await app.inject({
      method: 'GET',
      url: '/org',
      headers: await sessionAuth({ orgId: null }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ orgId: null, configured: false });
    expect(mockSettingsFind).not.toHaveBeenCalled();
  });
});

describe('GET /org/members', () => {
  it("lists only this org's active members", async () => {
    mockMemberFindMany.mockResolvedValue([{ id: 'm1', orgId: 'org-1', status: 'active' }] as never);

    const res = await app.inject({
      method: 'GET',
      url: '/org/members',
      headers: await sessionAuth(),
    });

    expect(res.statusCode).toBe(200);
    expect(mockMemberFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: 'org-1', status: 'active' } }),
    );
    expect(res.json().data).toHaveLength(1);
  });
});

describe('PATCH /org/members/:membershipId', () => {
  it("updates the member's role via WorkOS and the local mirror", async () => {
    mockUpdateMembership.mockResolvedValue({ id: 'membership-1', role: { slug: 'admin' } });
    mockMemberUpdate.mockResolvedValue({ id: 'm1', role: 'admin' } as never);

    const res = await app.inject({
      method: 'PATCH',
      url: '/org/members/membership-1',
      headers: await sessionAuth(),
      payload: { role: 'admin' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUpdateMembership).toHaveBeenCalledWith('membership-1', { roleSlug: 'admin' });
    expect(mockMemberUpdate).toHaveBeenCalledWith({
      where: { membershipId: 'membership-1' },
      data: { role: 'admin' },
    });
  });

  it('rejects a non-admin caller', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/org/members/membership-1',
      headers: await sessionAuth({ orgRole: 'member' }),
      payload: { role: 'admin' },
    });

    expect(res.statusCode).toBe(403);
    expect(mockMemberUpdate).not.toHaveBeenCalled();
  });
});

describe('DELETE /org/members/:membershipId', () => {
  it('deactivates the membership via WorkOS and the local mirror', async () => {
    mockDeactivateMembership.mockResolvedValue(undefined);
    mockMemberUpdate.mockResolvedValue({ id: 'm1', status: 'inactive' } as never);

    const res = await app.inject({
      method: 'DELETE',
      url: '/org/members/membership-1',
      headers: await sessionAuth(),
    });

    expect(res.statusCode).toBe(200);
    expect(mockMemberUpdate).toHaveBeenCalledWith({
      where: { membershipId: 'membership-1' },
      data: { status: 'inactive' },
    });
  });
});

describe('PATCH /org/settings', () => {
  it('upserts settings scoped to the session org', async () => {
    mockSettingsUpsert.mockResolvedValue({
      orgId: 'org-1',
      name: 'New Name',
      mfaRequired: true,
    } as never);

    const res = await app.inject({
      method: 'PATCH',
      url: '/org/settings',
      headers: await sessionAuth(),
      payload: { name: 'New Name', mfaRequired: true },
    });

    expect(res.statusCode).toBe(200);
    expect(mockSettingsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: 'org-1' } }),
    );
  });
});

describe('GET /org/audit-logs/events', () => {
  it('scopes to orgId when the session has one', async () => {
    mockAuditFindMany.mockResolvedValue([]);
    mockAuditCount.mockResolvedValue(0 as never);

    const res = await app.inject({
      method: 'GET',
      url: '/org/audit-logs/events',
      headers: await sessionAuth(),
    });

    expect(res.statusCode).toBe(200);
    expect(mockAuditFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ orgId: 'org-1' }) }),
    );
  });

  it("falls back to the caller's own actorId when the session has no org", async () => {
    mockFindUser.mockResolvedValue({ id: 'user-1', email: 'admin@acme.com', orgId: null } as never);
    mockAuditFindMany.mockResolvedValue([]);
    mockAuditCount.mockResolvedValue(0 as never);

    const res = await app.inject({
      method: 'GET',
      url: '/org/audit-logs/events',
      headers: await sessionAuth({ orgId: null }),
    });

    expect(res.statusCode).toBe(200);
    expect(mockAuditFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ actorId: 'user-1' }) }),
    );
    expect(mockAuditCount).toHaveBeenCalledWith({ where: { actorId: 'user-1' } });
  });
});
