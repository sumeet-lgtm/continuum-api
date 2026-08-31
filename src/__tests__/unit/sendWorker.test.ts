import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock all I/O ─────────────────────────────────────────────────────────────
// vi.mock factories are hoisted above imports, so every mock fn they close
// over must come from vi.hoisted rather than a plain top-level const.

const {
  sendMessageFindUnique, sendMessageUpdate,
  sendViaSes, isSesConfigured,
  incrementSendUsageBy,
  dispatchWebhook, buildEventId,
  FakeSesNotConfiguredError,
} = vi.hoisted(() => {
  class FakeSesNotConfiguredError extends Error {
    constructor() {
      super('SES is not configured — set AWS_REGION, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY.');
      this.name = 'SesNotConfiguredError';
    }
  }
  return {
    sendMessageFindUnique: vi.fn(),
    sendMessageUpdate: vi.fn(),
    sendViaSes: vi.fn(),
    isSesConfigured: vi.fn(() => true),
    incrementSendUsageBy: vi.fn(),
    dispatchWebhook: vi.fn(),
    buildEventId: vi.fn((event: string, id: string) => `${event}:${id}`),
    FakeSesNotConfiguredError,
  };
});

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    sendMessage: { findUnique: sendMessageFindUnique, update: sendMessageUpdate },
    $disconnect: vi.fn(),
  },
}));

vi.mock('../../lib/ses.js', () => ({
  sendViaSes,
  isSesConfigured,
  SesNotConfiguredError: FakeSesNotConfiguredError,
}));

vi.mock('../../plugins/usageMeter.js', () => ({ incrementSendUsageBy }));

vi.mock('../../lib/webhooks.js', () => ({ dispatchWebhook, buildEventId }));

vi.mock('../../lib/unsubscribe.js', () => ({ generateUnsubToken: vi.fn(() => 'unsub-token') }));

vi.mock('../../lib/queue.js', () => ({ QUEUE_SEND: 'continuum-send', redisConnection: {} }));

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({ on: vi.fn(), close: vi.fn() })),
}));

import { processScheduledSendForTesting as processScheduledSend } from '../../workers/sendWorker.js';

function jobFor(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bull-job-1',
    data: {
      sendMessageId: 'msg_1',
      to: 'recipient@example.com',
      subject: 'Scheduled hello',
      htmlBody: '<p>hi</p>',
      from: 'sender@example.com',
      apiKeyId: 'key_1',
      ...overrides,
    },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  isSesConfigured.mockReturnValue(true);
});

describe('sendWorker.processScheduledSend', () => {
  it('skips when the SendMessage record no longer exists', async () => {
    sendMessageFindUnique.mockResolvedValue(null);
    await processScheduledSend(jobFor());
    expect(sendViaSes).not.toHaveBeenCalled();
    expect(sendMessageUpdate).not.toHaveBeenCalled();
  });

  it('skips when the message is no longer in "scheduled" status (already cancelled/processed)', async () => {
    sendMessageFindUnique.mockResolvedValue({ id: 'msg_1', status: 'cancelled' });
    await processScheduledSend(jobFor());
    expect(sendViaSes).not.toHaveBeenCalled();
    expect(sendMessageUpdate).not.toHaveBeenCalled();
  });

  it('sends via SES, marks the message sent, increments usage, and dispatches email.sent', async () => {
    sendMessageFindUnique.mockResolvedValue({ id: 'msg_1', status: 'scheduled' });
    sendViaSes.mockResolvedValue({ sesMessageId: 'ses-abc' });

    await processScheduledSend(jobFor());

    expect(sendViaSes).toHaveBeenCalledWith(expect.objectContaining({
      to: 'recipient@example.com',
      from: 'sender@example.com',
      subject: 'Scheduled hello',
      listUnsubscribeHeader: expect.stringContaining('unsub-token'),
    }));
    expect(sendMessageUpdate).toHaveBeenCalledWith({
      where: { id: 'msg_1' },
      data: expect.objectContaining({ sesMessageId: 'ses-abc', status: 'sent', errorMessage: null }),
    });
    expect(incrementSendUsageBy).toHaveBeenCalledWith('key_1', 1);
    expect(dispatchWebhook).toHaveBeenCalledWith(expect.objectContaining({ event: 'email.sent', apiKeyId: 'key_1' }));
  });

  it('marks the message failed and dispatches email.send_failed when SES throws, without incrementing usage', async () => {
    sendMessageFindUnique.mockResolvedValue({ id: 'msg_1', status: 'scheduled' });
    sendViaSes.mockRejectedValue(new Error('SES rejected the message'));

    await processScheduledSend(jobFor());

    expect(sendMessageUpdate).toHaveBeenCalledWith({
      where: { id: 'msg_1' },
      data: expect.objectContaining({ status: 'failed', errorMessage: 'SES rejected the message', sentAt: null }),
    });
    expect(incrementSendUsageBy).not.toHaveBeenCalled();
    expect(dispatchWebhook).toHaveBeenCalledWith(expect.objectContaining({ event: 'email.send_failed' }));
  });

  it('marks the message failed without calling SES when SES is not configured', async () => {
    sendMessageFindUnique.mockResolvedValue({ id: 'msg_1', status: 'scheduled' });
    isSesConfigured.mockReturnValue(false);

    await processScheduledSend(jobFor());

    expect(sendViaSes).not.toHaveBeenCalled();
    expect(sendMessageUpdate).toHaveBeenCalledWith({
      where: { id: 'msg_1' },
      data: { status: 'failed', errorMessage: expect.stringContaining('SES is not configured') },
    });
  });
});
