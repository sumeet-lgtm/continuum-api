import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHmac } from 'crypto';
import Fastify, { type FastifyInstance } from 'fastify';

vi.mock('../../lib/email.js', () => ({
  sendEmail: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../config.js', () => ({
  config: { CALCOM_WEBHOOK_SECRET: 'test_calcom_secret' },
}));

import { calcomWebhookRoutes } from '../../routes/webhooks/calcom.js';
import { sendEmail } from '../../lib/email.js';

const mockSendEmail = vi.mocked(sendEmail);

describe('POST /webhooks/calcom', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(calcomWebhookRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockSendEmail.mockClear();
  });

  function sign(body: string): string {
    return createHmac('sha256', 'test_calcom_secret').update(body).digest('hex');
  }

  it('accepts a request with a valid signature computed over the exact raw body', async () => {
    // Deliberately formatted with unusual spacing/ordering so a naive
    // JSON.parse(body) -> JSON.stringify(parsed) round-trip would NOT
    // reproduce these exact bytes — this is precisely the regression
    // this route used to have (see workos/calcom raw-body fix commit).
    const rawBody = '{"triggerEvent":"BOOKING_CREATED",  "payload":{"title":"Chat","attendees":[{"name":"Ada","email":"ada@example.com"}]}}';

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/calcom',
      headers: { 'content-type': 'application/json', 'x-cal-signature-256': sign(rawBody) },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(200);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it('rejects a request whose signature was computed over different bytes than what was sent', async () => {
    const rawBody = '{"triggerEvent":"BOOKING_CREATED","payload":{}}';
    const wrongSignature = sign('{"triggerEvent":"BOOKING_CREATED","payload":{"tampered":true}}');

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/calcom',
      headers: { 'content-type': 'application/json', 'x-cal-signature-256': wrongSignature },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(401);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('rejects a request with no signature header at all', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/calcom',
      headers: { 'content-type': 'application/json' },
      payload: '{"triggerEvent":"BOOKING_CREATED","payload":{}}',
    });

    expect(res.statusCode).toBe(401);
  });

  it('ignores non-booking trigger events without erroring', async () => {
    const rawBody = '{"triggerEvent":"MEETING_ENDED","payload":{}}';

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/calcom',
      headers: { 'content-type': 'application/json', 'x-cal-signature-256': sign(rawBody) },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, action: 'ignored' });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('returns 400 for a validly-signed but malformed JSON body', async () => {
    const rawBody = 'not json';

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/calcom',
      headers: { 'content-type': 'application/json', 'x-cal-signature-256': sign(rawBody) },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(400);
  });
});
