import { describe, it, expect, vi, beforeEach } from 'vitest';

// requireRateLimit is a no-op whenever request.apiKey is unset, which is
// always true on public routes (tracking pixel, unsubscribe, confirm, the
// SNS webhook, the pre-session SSO routes) — those had no volume limit at
// all. requireIpRateLimit fills that gap by keying on the caller's IP
// instead, scoped per-route so one public endpoint's traffic can't eat
// another's budget.

const { incrMock, expireMock, ttlMock, isReconnectingMock } = vi.hoisted(() => ({
  incrMock: vi.fn(),
  expireMock: vi.fn(),
  ttlMock: vi.fn(),
  isReconnectingMock: vi.fn(),
}));

vi.mock('../../lib/redis.js', () => ({
  redis: { incr: incrMock, expire: expireMock, ttl: ttlMock },
  redisKey: {
    rateLimit: (apiKeyId: string) => `rl:${apiKeyId}`,
    ipRateLimit: (scope: string, ip: string) => `rl:ip:${scope}:${ip}`,
  },
  isReconnecting: isReconnectingMock,
}));

import { requireIpRateLimit, requireRateLimit } from '../../plugins/rateLimit.js';

function fakeRequest(ip = '203.0.113.9') {
  return { ip } as never;
}

function fakeApiKeyRequest(apiKeyId = 'key-001', rateLimit: number | null = null) {
  return { apiKey: { id: apiKeyId, rateLimit } } as never;
}

function fakeReply() {
  const headers: Record<string, string> = {};
  return {
    header: vi.fn((key: string, value: string) => {
      headers[key] = value;
      return undefined as never;
    }),
    _headers: headers,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  ttlMock.mockResolvedValue(60);
  isReconnectingMock.mockReturnValue(false);
});

describe('requireIpRateLimit', () => {
  it('allows a request under the limit and sets rate-limit headers', async () => {
    incrMock.mockResolvedValue(1);
    const reply = fakeReply();

    const handler = requireIpRateLimit('track-open', 300);
    await handler(fakeRequest(), reply);

    expect((reply as unknown as { _headers: Record<string, string> })._headers['X-RateLimit-Limit']).toBe('300');
    expect((reply as unknown as { _headers: Record<string, string> })._headers['X-RateLimit-Remaining']).toBe('299');
  });

  it('throws a 429 once the per-IP count exceeds the limit', async () => {
    incrMock.mockResolvedValue(301);
    const handler = requireIpRateLimit('track-open', 300);

    await expect(handler(fakeRequest(), fakeReply())).rejects.toMatchObject({ statusCode: 429 });
  });

  it('scopes the Redis key by both route scope and IP, so two routes for the same IP have independent budgets', async () => {
    incrMock.mockResolvedValue(1);
    await requireIpRateLimit('track-open', 300)(fakeRequest('1.2.3.4'), fakeReply());
    await requireIpRateLimit('unsubscribe', 60)(fakeRequest('1.2.3.4'), fakeReply());

    expect(incrMock).toHaveBeenNthCalledWith(1, 'rl:ip:track-open:1.2.3.4');
    expect(incrMock).toHaveBeenNthCalledWith(2, 'rl:ip:unsubscribe:1.2.3.4');
  });

  it('fails open (does not block the request) when Redis itself errors', async () => {
    incrMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const handler = requireIpRateLimit('sns-events', 600);

    await expect(handler(fakeRequest(), fakeReply())).resolves.toBeUndefined();
  });
});

describe('reconnect-window retry — a dropped idle Redis connection must not silently disable rate limiting', () => {
  // Railway's proxy dropping an idle connection throws "Stream isn't
  // writeable" for whatever command was in flight, even though Redis is
  // fine again a few hundred ms later — this is not a genuine outage. Both
  // requireRateLimit (API-key path) and requireIpRateLimit (IP path) must
  // retry once through exactly this window before falling back to
  // fail-open, so a routine proxy blip doesn't give one request a free
  // pass on rate limiting.

  it('requireRateLimit retries once and enforces the limit when the first attempt hits a reconnect-window error', async () => {
    isReconnectingMock.mockReturnValue(true);
    incrMock
      .mockRejectedValueOnce(new Error("Stream isn't writeable and enableOfflineQueue options is false"))
      .mockResolvedValueOnce(301); // retry succeeds — over the limit
    const reply = fakeReply();

    await expect(requireRateLimit(fakeApiKeyRequest('key-001', 300), reply)).rejects.toMatchObject({ statusCode: 429 });
    expect(incrMock).toHaveBeenCalledTimes(2);
  });

  it('requireRateLimit falls back to fail-open if the retry also fails', async () => {
    isReconnectingMock.mockReturnValue(true);
    incrMock.mockRejectedValue(new Error("Stream isn't writeable and enableOfflineQueue options is false"));

    await expect(requireRateLimit(fakeApiKeyRequest('key-001', 300), fakeReply())).resolves.toBeUndefined();
    expect(incrMock).toHaveBeenCalledTimes(2);
  });

  it('requireRateLimit does NOT retry when the error is a genuine outage (not mid-reconnect)', async () => {
    isReconnectingMock.mockReturnValue(false);
    incrMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(requireRateLimit(fakeApiKeyRequest('key-001', 300), fakeReply())).resolves.toBeUndefined();
    expect(incrMock).toHaveBeenCalledTimes(1);
  });

  it('requireIpRateLimit retries once through the same reconnect window', async () => {
    isReconnectingMock.mockReturnValue(true);
    incrMock
      .mockRejectedValueOnce(new Error("Stream isn't writeable and enableOfflineQueue options is false"))
      .mockResolvedValueOnce(1);
    const reply = fakeReply();

    await requireIpRateLimit('track-open', 300)(fakeRequest(), reply);

    expect(incrMock).toHaveBeenCalledTimes(2);
    expect((reply as unknown as { _headers: Record<string, string> })._headers['X-RateLimit-Remaining']).toBe('299');
  });
});
