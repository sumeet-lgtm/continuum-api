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

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    user: { upsert: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    apiKey: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    orgMember: { upsert: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  },
}));

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
    expect(mockConstructEvent).toHaveBeenCalledWith(
      expect.objectContaining({ payload: rawBody }),
    );
  });

  it('rejects when constructEvent throws (invalid signature)', async () => {
    mockConstructEvent.mockImplementation(() => { throw new Error('bad signature'); });

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
    mockConstructEvent.mockReturnValue(undefined);

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/workos',
      headers: { 'content-type': 'application/json', 'workos-signature': 'v1,whatever' },
      payload: '{"event":"some.unhandled.event","data":{}}',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
  });
});
