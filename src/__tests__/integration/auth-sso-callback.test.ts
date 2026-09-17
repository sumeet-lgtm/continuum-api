import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// /auth/sso/callback is the single highest-risk route in the codebase —
// it resolves WorkOS identity into a local user + api key + session, and
// had zero test coverage all session despite multiple withRlsBypass/
// withOrgTenant conversions landing here during the RLS hardening pass.
// This covers the login flow end to end against a mocked WorkOS + Prisma.

const { authenticateWithCodeMock, listOrgMembershipsMock } = vi.hoisted(() => ({
  authenticateWithCodeMock: vi.fn(),
  listOrgMembershipsMock: vi.fn().mockResolvedValue({ data: [] }),
}));

vi.mock('@workos-inc/node', () => ({
  WorkOS: vi.fn().mockImplementation(function FakeWorkOS(this: { userManagement: unknown }) {
    this.userManagement = {
      authenticateWithCode: authenticateWithCodeMock,
      listOrganizationMemberships: listOrgMembershipsMock,
    };
  }),
}));

vi.mock('../../config.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    config: {
      ...(actual.config as Record<string, unknown>),
      WORKOS_API_KEY: 'test_workos_key',
      WORKOS_CLIENT_ID: 'client_123',
      DASHBOARD_URL: 'https://app.continuumapi.com',
      API_BASE_URL: 'https://api.continuumapi.com',
    },
  };
});

vi.mock('../../plugins/rateLimit.js', () => ({
  requireIpRateLimit: () => async () => {},
}));

const {
  findUniqueUserMock,
  updateUserMock,
  createUserMock,
  findFirstTeamMemberMock,
  findFirstApiKeyMock,
  createApiKeyMock,
  updateApiKeyMock,
  upsertOrgMemberMock,
} = vi.hoisted(() => ({
  findUniqueUserMock: vi.fn(),
  updateUserMock: vi.fn(),
  createUserMock: vi.fn(),
  findFirstTeamMemberMock: vi.fn().mockResolvedValue(null),
  findFirstApiKeyMock: vi.fn(),
  createApiKeyMock: vi.fn(),
  updateApiKeyMock: vi.fn(),
  upsertOrgMemberMock: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => {
  const prisma: {
    user: {
      findUnique: typeof findUniqueUserMock;
      update: typeof updateUserMock;
      create: typeof createUserMock;
    };
    teamMember: { findFirst: typeof findFirstTeamMemberMock };
    apiKey: {
      findFirst: typeof findFirstApiKeyMock;
      create: typeof createApiKeyMock;
      update: typeof updateApiKeyMock;
    };
    orgMember: { upsert: typeof upsertOrgMemberMock };
    $transaction?: ReturnType<typeof vi.fn>;
    $executeRawUnsafe?: ReturnType<typeof vi.fn>;
  } = {
    user: { findUnique: findUniqueUserMock, update: updateUserMock, create: createUserMock },
    teamMember: { findFirst: findFirstTeamMemberMock },
    apiKey: { findFirst: findFirstApiKeyMock, create: createApiKeyMock, update: updateApiKeyMock },
    orgMember: { upsert: upsertOrgMemberMock },
  };
  // withRlsBypass()/withOrgTenant() both call prisma.$transaction(fn) and
  // hand fn the tx — here the same mock object, so tx.<model> resolves to
  // the mocks above.
  prisma.$transaction = vi.fn((fn: (tx: typeof prisma) => unknown) => fn(prisma));
  prisma.$executeRawUnsafe = vi.fn().mockResolvedValue(undefined);
  return { prisma };
});

const { signSessionMock } = vi.hoisted(() => ({
  signSessionMock: vi.fn().mockResolvedValue('signed.session.token'),
}));
vi.mock('../../lib/session.js', () => ({
  signSession: signSessionMock,
  verifySession: vi.fn(),
}));

const { sendEmailMock } = vi.hoisted(() => ({ sendEmailMock: vi.fn().mockResolvedValue(true) }));
vi.mock('../../lib/email.js', () => ({
  sendEmail: sendEmailMock,
  welcomeEmail: (prefix: string) => ({ subject: `Welcome ${prefix}`, html: '' }),
  loginAlertEmail: () => ({ subject: 'New sign-in', html: '' }),
}));

const { logAuditMock } = vi.hoisted(() => ({ logAuditMock: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../lib/audit.js', () => ({ logAudit: logAuditMock }));

import { authRoutes } from '../../routes/auth/index.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  await app.register(authRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  listOrgMembershipsMock.mockResolvedValue({ data: [] });
  findFirstTeamMemberMock.mockResolvedValue(null);
  sendEmailMock.mockResolvedValue(true);
  signSessionMock.mockResolvedValue('signed.session.token');
});

function workosUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'workos-user-1',
    email: 'newuser@wyberai.com',
    firstName: 'New',
    lastName: 'User',
    ...overrides,
  };
}

describe('GET /auth/sso/callback', () => {
  it('redirects with an error when no code is present', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/sso/callback' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('error=missing_code');
    expect(authenticateWithCodeMock).not.toHaveBeenCalled();
  });

  it('creates a brand-new user and api key, sends welcome + login emails, and redirects with a session token', async () => {
    authenticateWithCodeMock.mockResolvedValue({ user: workosUser() });
    findUniqueUserMock.mockResolvedValue(null); // no existing user by workosId or email
    createUserMock.mockResolvedValue({ id: 'user-1', email: 'newuser@wyberai.com' });
    findFirstApiKeyMock
      .mockResolvedValueOnce(null) // "find or create a primary key" — none yet
      .mockResolvedValueOnce(null); // "isNewUser" check — no OTHER active key either
    createApiKeyMock.mockResolvedValue({ id: 'key-1', keyPrefix: 'cnt_abcd', orgId: null });

    const res = await app.inject({ method: 'GET', url: '/auth/sso/callback?code=abc123' });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/app\.continuumapi\.com\?token=/);
    expect(createUserMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: 'newuser@wyberai.com', workosId: 'workos-user-1' }),
      }),
    );
    expect(createApiKeyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ ownerId: 'user-1', plan: 'free' }),
      }),
    );
    expect(sendEmailMock).toHaveBeenCalledTimes(2); // welcome + login alert
    expect(sendEmailMock.mock.calls.some((c) => c[1].startsWith('Welcome'))).toBe(true);
    expect(logAuditMock).toHaveBeenCalledWith(
      null,
      'user.signed_in',
      expect.objectContaining({ id: 'user-1', email: 'newuser@wyberai.com' }),
      expect.any(Array),
      'key-1',
    );
  });

  it('reuses an existing active key for a returning user (no welcome email)', async () => {
    authenticateWithCodeMock.mockResolvedValue({
      user: workosUser({ email: 'returning@wyberai.com' }),
    });
    findUniqueUserMock.mockResolvedValueOnce({ id: 'user-2', email: 'returning@wyberai.com' }); // found by workosId
    updateUserMock.mockResolvedValue({ id: 'user-2', email: 'returning@wyberai.com' });
    findFirstApiKeyMock
      .mockResolvedValueOnce({ id: 'key-2', keyPrefix: 'cnt_old1', orgId: null }) // existing key found
      .mockResolvedValueOnce({ id: 'key-other' }); // isNewUser check finds ANOTHER active key too — not new

    const res = await app.inject({ method: 'GET', url: '/auth/sso/callback?code=xyz789' });

    expect(res.statusCode).toBe(302);
    expect(updateUserMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'user-2' } }),
    );
    expect(createApiKeyMock).not.toHaveBeenCalled();
    expect(sendEmailMock).toHaveBeenCalledTimes(1); // only the login alert, no welcome
    expect(sendEmailMock.mock.calls[0]![1]).not.toMatch(/^Welcome/);
  });

  it('falls back to matching an existing user by email when the workosId lookup misses', async () => {
    authenticateWithCodeMock.mockResolvedValue({
      user: workosUser({ id: 'workos-new-id', email: 'linked@wyberai.com' }),
    });
    findUniqueUserMock
      .mockResolvedValueOnce(null) // no match by workosId
      .mockResolvedValueOnce({ id: 'user-3', email: 'linked@wyberai.com' }); // match by email
    updateUserMock.mockResolvedValue({ id: 'user-3', email: 'linked@wyberai.com' });
    findFirstApiKeyMock
      .mockResolvedValueOnce({ id: 'key-3', keyPrefix: 'cnt_lnk1', orgId: null })
      .mockResolvedValueOnce(null);

    const res = await app.inject({ method: 'GET', url: '/auth/sso/callback?code=link1' });

    expect(res.statusCode).toBe(302);
    expect(findUniqueUserMock).toHaveBeenNthCalledWith(1, { where: { workosId: 'workos-new-id' } });
    expect(findUniqueUserMock).toHaveBeenNthCalledWith(2, {
      where: { email: 'linked@wyberai.com' },
    });
    expect(updateUserMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user-3' },
        data: expect.objectContaining({ workosId: 'workos-new-id' }),
      }),
    );
  });

  it('creates/updates the org membership when the login is via an org SSO connection', async () => {
    authenticateWithCodeMock.mockResolvedValue({
      user: workosUser({ email: 'orgadmin@acme.com' }),
      organizationId: 'org-1',
    });
    findUniqueUserMock.mockResolvedValue(null);
    createUserMock.mockResolvedValue({ id: 'user-4', email: 'orgadmin@acme.com' });
    listOrgMembershipsMock.mockResolvedValue({
      data: [{ id: 'membership-1', status: 'active', role: { slug: 'admin' } }],
    });
    findFirstApiKeyMock.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    createApiKeyMock.mockResolvedValue({ id: 'key-4', keyPrefix: 'cnt_org1', orgId: 'org-1' });

    const res = await app.inject({ method: 'GET', url: '/auth/sso/callback?code=orglogin' });

    expect(res.statusCode).toBe(302);
    expect(upsertOrgMemberMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { membershipId: 'membership-1' },
        create: expect.objectContaining({ userId: 'user-4', orgId: 'org-1', role: 'admin' }),
      }),
    );
    expect(signSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1', orgRole: 'admin' }),
    );
  });

  it('overrides the primary key to the workspace key when the user is a team member', async () => {
    authenticateWithCodeMock.mockResolvedValue({
      user: workosUser({ email: 'member@wyberai.com' }),
    });
    findUniqueUserMock.mockResolvedValue(null);
    createUserMock.mockResolvedValue({ id: 'user-5', email: 'member@wyberai.com' });
    findFirstTeamMemberMock.mockResolvedValue({
      workspaceKeyId: 'workspace-key-1',
      role: 'member',
    });
    findFirstApiKeyMock
      .mockResolvedValueOnce({ id: 'key-5', keyPrefix: 'cnt_own01', orgId: null }) // own key
      .mockResolvedValueOnce({ id: 'workspace-key-1', keyPrefix: 'cnt_wrk01', orgId: null }) // workspace key lookup
      .mockResolvedValueOnce({ id: 'other-active' }); // isNewUser check

    const res = await app.inject({ method: 'GET', url: '/auth/sso/callback?code=teamlogin' });

    expect(res.statusCode).toBe(302);
    expect(signSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        primaryKeyId: 'workspace-key-1',
        workspaceRole: 'member',
      }),
    );
  });

  it('honors a custom redirect_uri encoded in state, and falls back cleanly on malformed state', async () => {
    authenticateWithCodeMock.mockResolvedValue({ user: workosUser() });
    findUniqueUserMock.mockResolvedValue(null);
    createUserMock.mockResolvedValue({ id: 'user-6', email: 'newuser@wyberai.com' });
    findFirstApiKeyMock.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    createApiKeyMock.mockResolvedValue({ id: 'key-6', keyPrefix: 'cnt_st0001', orgId: null });

    const state = Buffer.from(
      JSON.stringify({ redirect_uri: 'https://custom.example.com/finish' }),
    ).toString('base64url');
    const res = await app.inject({
      method: 'GET',
      url: `/auth/sso/callback?code=abc&state=${state}`,
    });
    expect(res.headers.location).toMatch(/^https:\/\/custom\.example\.com\/finish\?token=/);

    const res2 = await app.inject({
      method: 'GET',
      url: '/auth/sso/callback?code=abc&state=not-valid-base64url!!',
    });
    expect(res2.headers.location).toMatch(/^https:\/\/app\.continuumapi\.com\?token=/);
  });

  it('redirects to the dashboard login with an error and logs the failure when WorkOS rejects the code', async () => {
    authenticateWithCodeMock.mockRejectedValue(new Error('invalid_grant'));

    const res = await app.inject({ method: 'GET', url: '/auth/sso/callback?code=bad-code' });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('/login?error=sso_failed');
    expect(res.headers.location).toContain('invalid_grant');
    expect(logAuditMock).toHaveBeenCalledWith(
      null,
      'user.sign_in_failed',
      expect.objectContaining({ id: 'unknown' }),
      expect.any(Array),
    );
    expect(createUserMock).not.toHaveBeenCalled();
  });
});
