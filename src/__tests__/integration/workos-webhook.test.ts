import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const { mockConstructEvent } = vi.hoisted(() => ({ mockConstructEvent: vi.fn() }));

vi.mock('@workos-inc/node', () => ({
  WorkOS: class {
    webhooks = { constructEvent: mockConstructEvent };
  },
}));

vi.mock('../../config.js', () => ({
  config: { WORKOS_API_KEY: 'test_workos_key', WORKOS_WEBHOOK_SECRET: 'test_workos_secret' },
}));

const { mockUserUpsert, mockUserFindUnique, mockUserUpdate } = vi.hoisted(() => ({
  mockUserUpsert: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockUserUpdate: vi.fn(),
}));
const { mockKeyFindFirst, mockKeyCreate, mockKeyUpdateMany } = vi.hoisted(() => ({
  mockKeyFindFirst: vi.fn(),
  mockKeyCreate: vi.fn(),
  mockKeyUpdateMany: vi.fn(),
}));
const { mockMemberUpsert, mockMemberUpdateMany, mockMemberUpdate } = vi.hoisted(() => ({
  mockMemberUpsert: vi.fn(),
  mockMemberUpdateMany: vi.fn(),
  mockMemberUpdate: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => {
  const prisma: {
    user: {
      upsert: typeof mockUserUpsert;
      findUnique: typeof mockUserFindUnique;
      update: typeof mockUserUpdate;
    };
    apiKey: {
      findFirst: typeof mockKeyFindFirst;
      create: typeof mockKeyCreate;
      updateMany: typeof mockKeyUpdateMany;
    };
    orgMember: {
      upsert: typeof mockMemberUpsert;
      updateMany: typeof mockMemberUpdateMany;
      update: typeof mockMemberUpdate;
    };
    $transaction?: ReturnType<typeof vi.fn>;
    $executeRawUnsafe?: ReturnType<typeof vi.fn>;
  } = {
    user: { upsert: mockUserUpsert, findUnique: mockUserFindUnique, update: mockUserUpdate },
    apiKey: { findFirst: mockKeyFindFirst, create: mockKeyCreate, updateMany: mockKeyUpdateMany },
    orgMember: {
      upsert: mockMemberUpsert,
      updateMany: mockMemberUpdateMany,
      update: mockMemberUpdate,
    },
  };
  // dsync handlers go through withRlsBypass, which calls
  // prisma.$transaction(fn) and hands fn the tx — here the same mock
  // object, so tx.user/tx.apiKey/tx.orgMember resolve to the mocks above.
  prisma.$transaction = vi.fn((fn: (tx: typeof prisma) => unknown) => fn(prisma));
  prisma.$executeRawUnsafe = vi.fn().mockResolvedValue(undefined);
  return { prisma };
});

vi.mock('../../lib/crypto.js', () => ({
  hashApiKey: vi.fn().mockReturnValue('hashed'),
}));

vi.mock('../../lib/email.js', () => ({
  sendEmail: vi.fn().mockResolvedValue(true),
  welcomeEmail: vi.fn().mockReturnValue({ subject: 'Welcome', html: '<p>hi</p>' }),
}));

vi.mock('../../lib/audit.js', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

import { workosWebhookRoutes } from '../../routes/webhooks/workos.js';

describe('POST /webhooks/workos', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(workosWebhookRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockConstructEvent.mockReset();
    mockUserUpsert.mockReset();
    mockUserFindUnique.mockReset();
    mockUserUpdate.mockReset();
    mockKeyFindFirst.mockReset();
    mockKeyCreate.mockReset();
    mockKeyUpdateMany.mockReset();
    mockMemberUpsert.mockReset();
    mockMemberUpdateMany.mockReset();
    mockMemberUpdate.mockReset();
    mockConstructEvent.mockReturnValue(undefined); // valid signature by default
  });

  it('passes the exact raw body bytes to constructEvent, not a re-serialized JSON.stringify', async () => {
    // Deliberately unusual spacing so a JSON.parse -> JSON.stringify
    // round-trip would produce different bytes than this — the exact
    // regression this route used to have.
    const rawBody = '{"event":"dsync.user.updated",  "data":{"username":"a@b.com"}}';
    mockConstructEvent.mockReturnValue(undefined); // valid — doesn't throw

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/workos',
      headers: { 'content-type': 'application/json', 'workos-signature': 'v1,whatever' },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(200);
    expect(mockConstructEvent).toHaveBeenCalledWith(expect.objectContaining({ payload: rawBody }));
  });

  it('rejects when constructEvent throws (invalid signature)', async () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error('bad signature');
    });

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/workos',
      headers: { 'content-type': 'application/json', 'workos-signature': 'v1,bogus' },
      payload: '{"event":"dsync.user.updated","data":{}}',
    });

    expect(res.statusCode).toBe(401);
  });

  it('rejects a request with no signature header when a secret is configured', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/workos',
      headers: { 'content-type': 'application/json' },
      payload: '{"event":"dsync.user.updated","data":{}}',
    });

    expect(res.statusCode).toBe(401);
    expect(mockConstructEvent).not.toHaveBeenCalled();
  });

  it('returns 400 for a validly-signed but malformed JSON body', async () => {
    mockConstructEvent.mockReturnValue(undefined);

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/workos',
      headers: { 'content-type': 'application/json', 'workos-signature': 'v1,whatever' },
      payload: 'not json',
    });

    expect(res.statusCode).toBe(400);
  });

  it('logs unrecognized event types as 200 without erroring', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/workos',
      headers: { 'content-type': 'application/json', 'workos-signature': 'v1,whatever' },
      payload: '{"event":"some.unhandled.event","data":{}}',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
  });

  describe('dsync.user.created', () => {
    it('provisions a new user, api key, and org membership, then sends a welcome email', async () => {
      mockUserUpsert.mockResolvedValue({ id: 'user-1' });
      mockKeyFindFirst.mockResolvedValue(null); // no existing active key
      mockKeyCreate.mockResolvedValue({ id: 'key-1', keyPrefix: 'cnt_abcd' });
      mockMemberUpsert.mockResolvedValue({ id: 'member-1' });

      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/workos',
        headers: { 'content-type': 'application/json', 'workos-signature': 'v1,whatever' },
        payload: JSON.stringify({
          event: 'dsync.user.created',
          data: {
            id: 'membership-1',
            username: 'new@acme.com',
            first_name: 'New',
            organization_id: 'org-1',
          },
        }),
      });

      expect(res.statusCode).toBe(200);
      expect(mockUserUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: 'new@acme.com' },
        }),
      );
      expect(mockKeyCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ ownerId: 'user-1' }),
        }),
      );
      expect(mockMemberUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { membershipId: 'membership-1' },
          create: expect.objectContaining({ userId: 'user-1', orgId: 'org-1', role: 'member' }),
        }),
      );
    });

    it('does not create a second api key when the user already has an active one', async () => {
      mockUserUpsert.mockResolvedValue({ id: 'user-1' });
      mockKeyFindFirst.mockResolvedValue({ id: 'existing-key' });
      mockMemberUpsert.mockResolvedValue({ id: 'member-1' });

      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/workos',
        headers: { 'content-type': 'application/json', 'workos-signature': 'v1,whatever' },
        payload: JSON.stringify({
          event: 'dsync.user.created',
          data: { id: 'membership-1', username: 'existing@acme.com', organization_id: 'org-1' },
        }),
      });

      expect(res.statusCode).toBe(200);
      expect(mockKeyCreate).not.toHaveBeenCalled();
    });
  });

  describe('dsync.user.deleted', () => {
    it("deactivates the user's api keys and org membership", async () => {
      mockUserFindUnique.mockResolvedValue({ id: 'user-1' });
      mockKeyUpdateMany.mockResolvedValue({ count: 1 });
      mockMemberUpdateMany.mockResolvedValue({ count: 1 });
      mockMemberUpdate.mockResolvedValue({ id: 'member-1' });

      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/workos',
        headers: { 'content-type': 'application/json', 'workos-signature': 'v1,whatever' },
        payload: JSON.stringify({
          event: 'dsync.user.deleted',
          data: { id: 'membership-1', username: 'gone@acme.com', organization_id: 'org-1' },
        }),
      });

      expect(res.statusCode).toBe(200);
      expect(mockKeyUpdateMany).toHaveBeenCalledWith({
        where: { ownerId: 'user-1' },
        data: { isActive: false },
      });
      expect(mockMemberUpdateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', orgId: 'org-1' },
        data: { status: 'inactive' },
      });
    });

    it('does not throw when the membership row no longer exists', async () => {
      mockUserFindUnique.mockResolvedValue({ id: 'user-1' });
      mockKeyUpdateMany.mockResolvedValue({ count: 0 });
      mockMemberUpdateMany.mockResolvedValue({ count: 0 });
      mockMemberUpdate.mockRejectedValue(new Error('record not found'));

      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/workos',
        headers: { 'content-type': 'application/json', 'workos-signature': 'v1,whatever' },
        payload: JSON.stringify({
          event: 'dsync.user.deleted',
          data: { id: 'membership-1', username: 'gone@acme.com', organization_id: 'org-1' },
        }),
      });

      expect(res.statusCode).toBe(200);
    });

    it('is a no-op (200) when no matching local user exists', async () => {
      mockUserFindUnique.mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/workos',
        headers: { 'content-type': 'application/json', 'workos-signature': 'v1,whatever' },
        payload: JSON.stringify({
          event: 'dsync.user.deleted',
          data: { id: 'membership-1', username: 'unknown@acme.com', organization_id: 'org-1' },
        }),
      });

      expect(res.statusCode).toBe(200);
      expect(mockKeyUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe('dsync.group.user_added / user_removed', () => {
    it('promotes to admin when added to an admin/owner group', async () => {
      mockMemberUpdate.mockResolvedValue({ id: 'member-1', role: 'admin' });

      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/workos',
        headers: { 'content-type': 'application/json', 'workos-signature': 'v1,whatever' },
        payload: JSON.stringify({
          event: 'dsync.group.user_added',
          data: { id: 'membership-1', name: 'Admins' },
        }),
      });

      expect(res.statusCode).toBe(200);
      expect(mockMemberUpdate).toHaveBeenCalledWith({
        where: { membershipId: 'membership-1' },
        data: { role: 'admin' },
      });
    });

    it('does not touch role when added to a non-admin group', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/workos',
        headers: { 'content-type': 'application/json', 'workos-signature': 'v1,whatever' },
        payload: JSON.stringify({
          event: 'dsync.group.user_added',
          data: { id: 'membership-1', name: 'Engineering' },
        }),
      });

      expect(res.statusCode).toBe(200);
      expect(mockMemberUpdate).not.toHaveBeenCalled();
    });

    it('demotes to member on group removal', async () => {
      mockMemberUpdate.mockResolvedValue({ id: 'member-1', role: 'member' });

      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/workos',
        headers: { 'content-type': 'application/json', 'workos-signature': 'v1,whatever' },
        payload: JSON.stringify({
          event: 'dsync.group.user_removed',
          data: { id: 'membership-1' },
        }),
      });

      expect(res.statusCode).toBe(200);
      expect(mockMemberUpdate).toHaveBeenCalledWith({
        where: { membershipId: 'membership-1' },
        data: { role: 'member' },
      });
    });
  });
});
