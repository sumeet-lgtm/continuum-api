import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';

// requireMonthlyQuota/requireMonthlySendQuota are Fastify prehandlers that
// run on every billable request; incrementUsageBy/incrementSendUsageBy run
// after every verification/send. None of this file had any test coverage
// before — added here since these are exactly the functions the RLS
// cutover's pre-flight audit found unwrapped (see usageMeter.ts's own
// withTenant conversions).

const { updateMock, findUniqueUserMock } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  findUniqueUserMock: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => {
  const prisma: {
    apiKey: { update: typeof updateMock };
    user: { findUnique: typeof findUniqueUserMock };
    $transaction?: ReturnType<typeof vi.fn>;
    $executeRawUnsafe?: ReturnType<typeof vi.fn>;
  } = {
    apiKey: { update: updateMock },
    user: { findUnique: findUniqueUserMock },
  };
  // withTenant() calls prisma.$transaction(fn) and hands fn the tx — here
  // the same mock object, so tx.apiKey resolves to the mock above.
  prisma.$transaction = vi.fn((fn: (tx: typeof prisma) => unknown) => fn(prisma));
  prisma.$executeRawUnsafe = vi.fn().mockResolvedValue(undefined);
  return { prisma };
});

const { sendEmailMock } = vi.hoisted(() => ({ sendEmailMock: vi.fn().mockResolvedValue(true) }));
vi.mock('../../lib/email.js', () => ({ sendEmail: sendEmailMock }));

vi.mock('../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  requireMonthlyQuota,
  requireMonthlySendQuota,
  incrementUsage,
  incrementUsageBy,
  incrementSendUsageBy,
} from '../../plugins/usageMeter.js';

function makeReply() {
  return { header: vi.fn() } as unknown as FastifyReply;
}

function makeKey(overrides: Record<string, unknown> = {}) {
  return {
    id: 'key-1',
    plan: 'free',
    monthlyLimit: 1000,
    currentMonthUsage: 0,
    usageResetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    ownerId: 'user-1',
    userId: null,
    usageAlertEnabled: true,
    usageAlertSentAt: null,
    extraVerificationCredits: 0,
    currentMonthFinderUsage: 0,
    monthlySendLimit: 500,
    currentMonthSendUsage: 0,
    sendUsageResetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    ...overrides,
  } as unknown as FastifyRequest['apiKey'];
}

beforeEach(() => {
  vi.clearAllMocks();
  updateMock.mockResolvedValue({});
});

describe('requireMonthlyQuota', () => {
  it('does nothing when there is no apiKey on the request (unauthenticated)', async () => {
    const request = {} as FastifyRequest;
    const reply = makeReply();
    await expect(requireMonthlyQuota(request, reply)).resolves.toBeUndefined();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('backfills usageResetAt for a key that has never had one', async () => {
    const key = makeKey({ usageResetAt: null });
    const request = { apiKey: key } as FastifyRequest;
    await requireMonthlyQuota(request, makeReply());

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'key-1' }, data: { usageResetAt: expect.any(Date) } }),
    );
    expect(key.usageResetAt).toBeInstanceOf(Date);
  });

  it('resets usage counters once the reset date has passed', async () => {
    const key = makeKey({ usageResetAt: new Date(Date.now() - 1000), currentMonthUsage: 900 });
    const request = { apiKey: key } as FastifyRequest;
    await requireMonthlyQuota(request, makeReply());

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ currentMonthUsage: 0, currentMonthFinderUsage: 0 }),
      }),
    );
    expect(key.currentMonthUsage).toBe(0);
  });

  it('throws a 429 and sets rate-limit headers once usage reaches the plan limit', async () => {
    const key = makeKey({ currentMonthUsage: 1000 }); // free plan limit is 1000
    const request = { apiKey: key } as FastifyRequest;
    const reply = makeReply();

    await expect(requireMonthlyQuota(request, reply)).rejects.toMatchObject({ statusCode: 429 });
    expect(reply.header).toHaveBeenCalledWith('X-Usage-Limit', '1000');
    expect(reply.header).toHaveBeenCalledWith('X-Usage-Used', '1000');
  });

  it('extends the limit by any purchased top-up credits before rejecting', async () => {
    const key = makeKey({ currentMonthUsage: 1000, extraVerificationCredits: 500 });
    const request = { apiKey: key } as FastifyRequest;
    const reply = makeReply();

    await expect(requireMonthlyQuota(request, reply)).resolves.toBeUndefined();
    expect(reply.header).toHaveBeenCalledWith('X-Usage-Limit', '1500');
  });

  it('sends an 80%-usage alert exactly once per billing month', async () => {
    const key = makeKey({ currentMonthUsage: 850 }); // 85% of 1000
    findUniqueUserMock.mockResolvedValue({ email: 'owner@wyberai.com' });
    const request = { apiKey: key } as FastifyRequest;

    await requireMonthlyQuota(request, makeReply());
    // sendUsageAlert is fire-and-forget (void) — flush microtasks
    await new Promise((r) => setTimeout(r, 0));

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledWith(
      'owner@wyberai.com',
      expect.stringContaining('85%'),
      expect.any(String),
    );
  });

  it('does not re-send the 80% alert if one already went out this month', async () => {
    const key = makeKey({ currentMonthUsage: 850, usageAlertSentAt: new Date() });
    const request = { apiKey: key } as FastifyRequest;

    await requireMonthlyQuota(request, makeReply());
    await new Promise((r) => setTimeout(r, 0));

    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('does not send the alert when the key has opted out', async () => {
    const key = makeKey({ currentMonthUsage: 900, usageAlertEnabled: false });
    const request = { apiKey: key } as FastifyRequest;

    await requireMonthlyQuota(request, makeReply());
    await new Promise((r) => setTimeout(r, 0));

    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('fails open (does not throw or block the request) when the DB update errors', async () => {
    updateMock.mockRejectedValue(new Error('connection lost'));
    const key = makeKey({ usageResetAt: null });
    const request = { apiKey: key } as FastifyRequest;

    await expect(requireMonthlyQuota(request, makeReply())).resolves.toBeUndefined();
  });
});

describe('requireMonthlySendQuota', () => {
  it('does nothing when there is no apiKey on the request', async () => {
    const request = {} as FastifyRequest;
    await expect(requireMonthlySendQuota(request, makeReply())).resolves.toBeUndefined();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('uses its own sendUsageResetAt column, independent of the verify quota reset', async () => {
    const key = makeKey({ sendUsageResetAt: null, usageResetAt: new Date(Date.now() + 999999) });
    const request = { apiKey: key } as FastifyRequest;
    await requireMonthlySendQuota(request, makeReply());

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: { sendUsageResetAt: expect.any(Date) } }),
    );
  });

  it('rejects with 429 once send usage reaches the plan send limit', async () => {
    const key = makeKey({ currentMonthSendUsage: 1000 }); // free plan's send limit is 1000
    const request = { apiKey: key } as FastifyRequest;
    const reply = makeReply();

    await expect(requireMonthlySendQuota(request, reply)).rejects.toMatchObject({
      statusCode: 429,
    });
    expect(reply.header).toHaveBeenCalledWith('X-Send-Usage-Limit', '1000');
  });

  it('fails open when the DB update errors', async () => {
    updateMock.mockRejectedValue(new Error('db down'));
    const key = makeKey({ sendUsageResetAt: null });
    const request = { apiKey: key } as FastifyRequest;
    await expect(requireMonthlySendQuota(request, makeReply())).resolves.toBeUndefined();
  });
});

describe('incrementUsage / incrementUsageBy', () => {
  it('increments currentMonthUsage by the given count', async () => {
    await incrementUsageBy('key-1', 3);
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 'key-1' },
      data: { currentMonthUsage: { increment: 3 } },
    });
  });

  it('incrementUsage is a convenience wrapper for +1', async () => {
    await incrementUsage('key-1');
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 'key-1' },
      data: { currentMonthUsage: { increment: 1 } },
    });
  });

  it('is a no-op for a zero or negative count', async () => {
    await incrementUsageBy('key-1', 0);
    await incrementUsageBy('key-1', -5);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('never throws even if the DB update fails', async () => {
    updateMock.mockRejectedValue(new Error('db down'));
    await expect(incrementUsageBy('key-1', 1)).resolves.toBeUndefined();
  });
});

describe('incrementSendUsageBy', () => {
  it('increments currentMonthSendUsage by the given count', async () => {
    await incrementSendUsageBy('key-1', 4);
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 'key-1' },
      data: { currentMonthSendUsage: { increment: 4 } },
    });
  });

  it('is a no-op for a zero or negative count', async () => {
    await incrementSendUsageBy('key-1', 0);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('never throws even if the DB update fails', async () => {
    updateMock.mockRejectedValue(new Error('db down'));
    await expect(incrementSendUsageBy('key-1', 2)).resolves.toBeUndefined();
  });
});
