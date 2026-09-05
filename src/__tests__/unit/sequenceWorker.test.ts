import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock everything the worker module touches at import time ─────────────────

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    sequenceEnrollment: { findMany: vi.fn(), update: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    suppression:        { findMany: vi.fn().mockResolvedValue([]) },
    sequence:           { findMany: vi.fn().mockResolvedValue([]) },
    trackingEvent:      { findFirst: vi.fn().mockResolvedValue(null) },
    mailbox:            { findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
    sendMessage:        { create: vi.fn().mockResolvedValue({}) },
    // Every email step looks up AI-enriched lead fields (icebreaker, etc.)
    // to merge into the template — this was missing entirely, so any test
    // that actually reached the send path (not just the suppression-skip
    // branch) threw "Cannot read properties of undefined (reading
    // 'findFirst')" regardless of what the test itself was asserting.
    lead:               { findFirst: vi.fn().mockResolvedValue(null) },
    $disconnect:        vi.fn(),
  },
}));

vi.mock('../../lib/queue.js', () => ({
  QUEUE_SEQUENCE:  'continuum:sequence',
  redisConnection: {},
}));

vi.mock('../../lib/ses.js', () => ({ sendViaSes: vi.fn() }));
vi.mock('../../lib/smtp.js', () => ({ sendViaSmtp: vi.fn() }));
vi.mock('../../lib/unsubscribe.js', () => ({
  generateUnsubToken: vi.fn().mockReturnValue('tok'),
  generateUnsubHtml:  vi.fn().mockReturnValue(''),
}));
vi.mock('../../lib/tracking.js', () => ({
  generateOpenToken:  vi.fn().mockReturnValue(''),
  generateClickToken: vi.fn().mockReturnValue(''),
  injectTracking:     vi.fn((html: string) => html),
}));
vi.mock('../../lib/spintax.js', () => ({
  processTemplate: vi.fn((s: string) => s),
}));
vi.mock('../../lib/espMatch.js', () => ({
  detectESP:          vi.fn().mockResolvedValue('other'),
  rankMailboxesByESP: vi.fn().mockReturnValue([]),
}));

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({ on: vi.fn(), close: vi.fn() })),
  Queue:  vi.fn().mockImplementation(() => ({ add: vi.fn(), close: vi.fn() })),
}));

import { processSequenceTick, isWithinSendWindow } from '../../workers/sequenceWorker.js';
import { prisma } from '../../lib/prisma.js';
import { sendViaSes } from '../../lib/ses.js';

const mockDue        = vi.mocked(prisma.sequenceEnrollment.findMany);
const mockUpdate      = vi.mocked(prisma.sequenceEnrollment.update);
const mockSuppression = vi.mocked(prisma.suppression.findMany);
const mockSendSes     = vi.mocked(sendViaSes);
const mockSendMessageCreate = vi.mocked(prisma.sendMessage.create);

function makeEnrollment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'enr-001',
    email: 'lead@example.com',
    currentStep: 0,
    variables: {},
    repliedAt: null,
    sequence: {
      id: 'seq-001',
      apiKeyId: 'key-001',
      status: 'active',
      fromName: 'Acme',
      fromEmail: 'hello@acme.com',
      mailboxId: null,
      trackOpens: false,
      trackClicks: false,
      sendDays: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
      sendStartHour: 0,
      sendEndHour: 24,
      timezone: 'UTC',
      stopOnReply: true,
      parentSequenceId: null,
      steps: [
        { stepOrder: 0, condition: 'always', subject: 'Hi', htmlBody: '<p>hi</p>', textBody: null, delayDays: 1, delayHours: 0 },
      ],
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSuppression.mockResolvedValue([]);
  mockSendSes.mockResolvedValue({ sesMessageId: 'ses-1' } as never);
});

describe('processSequenceTick — suppression enforcement', () => {
  it('does not send to an enrollment whose email is on the suppression list', async () => {
    mockDue.mockResolvedValue([makeEnrollment({ email: 'suppressed@example.com' })] as never);
    mockSuppression.mockResolvedValue([{ email: 'suppressed@example.com', reason: 'hard_bounce' }] as never);

    await processSequenceTick();

    expect(mockSendSes).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'enr-001' }, data: expect.objectContaining({ status: 'bounced' }) }),
    );
  });

  it('marks a suppressed-by-unsubscribe enrollment with status unsubscribed, not bounced', async () => {
    mockDue.mockResolvedValue([makeEnrollment({ email: 'optedout@example.com' })] as never);
    mockSuppression.mockResolvedValue([{ email: 'optedout@example.com', reason: 'unsubscribed' }] as never);

    await processSequenceTick();

    expect(mockSendSes).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'unsubscribed' }) }),
    );
  });

  it('sends normally to an enrollment not on the suppression list', async () => {
    mockDue.mockResolvedValue([makeEnrollment()] as never);
    mockSuppression.mockResolvedValue([]);

    await processSequenceTick();

    expect(mockSendSes).toHaveBeenCalledTimes(1);
  });

  it('registers an SES-fallback send as a SendMessage row so the bounce webhook can find it', async () => {
    // Without this, campaign and sequence bounces had nowhere to land — no
    // sesMessageId meant POST /v1/send/events could never match the SNS
    // notification back to anything, so no suppression and no closed-loop
    // verification correction ever fired for sequence-driven sends.
    mockDue.mockResolvedValue([makeEnrollment({ email: 'lead@example.com' })] as never);
    mockSendSes.mockResolvedValue({ sesMessageId: 'ses-abc-123' } as never);

    await processSequenceTick();

    expect(mockSendMessageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          apiKeyId: 'key-001',
          to: 'lead@example.com',
          sesMessageId: 'ses-abc-123',
          status: 'sent',
        }),
      }),
    );
  });

  it('checks suppression for all due emails in a single batched query, not one per enrollment', async () => {
    mockDue.mockResolvedValue([
      makeEnrollment({ id: 'enr-a', email: 'a@example.com' }),
      makeEnrollment({ id: 'enr-b', email: 'b@example.com' }),
    ] as never);

    await processSequenceTick();

    expect(mockSuppression).toHaveBeenCalledTimes(1);
    expect(mockSuppression).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: { in: expect.arrayContaining(['a@example.com', 'b@example.com']) } } }),
    );
  });
});

describe('processSequenceTick — manual-channel steps (linkedin/task/call)', () => {
  it('parks the enrollment instead of silently auto-advancing past a manual step', async () => {
    mockDue.mockResolvedValue([
      makeEnrollment({
        sequence: {
          ...makeEnrollment().sequence,
          steps: [
            { stepOrder: 0, condition: 'always', type: 'linkedin', subject: null, htmlBody: '', textBody: null, taskNote: 'Send a connection request', delayDays: 0, delayHours: 0 },
            { stepOrder: 1, condition: 'always', type: 'email', subject: 'Follow up', htmlBody: '<p>hi</p>', textBody: null, delayDays: 2, delayHours: 0 },
          ],
        },
      }),
    ] as never);

    await processSequenceTick();

    // No email sent for a manual step, and — critically — the enrollment
    // must not silently jump straight past it to currentStep 1 with nobody
    // ever told.
    expect(mockSendSes).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 'enr-001' },
      data: { status: 'awaiting_manual_action' },
    });
  });

  it('still sends normally when the current step is an email step', async () => {
    mockDue.mockResolvedValue([makeEnrollment()] as never); // default step has no `type` — defaults to email
    mockSendSes.mockResolvedValue({ sesMessageId: 'ses-manual-test' } as never);

    await processSequenceTick();

    expect(mockSendSes).toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'awaiting_manual_action' }) }),
    );
  });
});

describe('isWithinSendWindow — respects the sequence\'s configured timezone', () => {
  // Every container clock runs in UTC, so a naive now.getHours()/getDay()
  // check silently ignored the `timezone` field entirely — a customer's
  // "9am-5pm America/Los_Angeles" window was actually gated by 9am-5pm UTC
  // (1am-9am Pacific), the opposite of what they configured. Found live
  // 2026-09-05 while verifying a real sequence enrollment stalled outside
  // its (correctly UTC, in that case) send window.
  const FIXED_INSTANT = '2024-01-10T13:00:00Z'; // Wednesday, 13:00 UTC

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_INSTANT));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('treats the window in UTC when timezone is UTC (13:00 UTC is inside 8-17)', () => {
    const result = isWithinSendWindow({
      sendDays: ['wednesday'], sendStartHour: 8, sendEndHour: 17, timezone: 'UTC',
    });
    expect(result).toBe(true);
  });

  it('converts to the configured timezone instead of using server-local UTC hour', () => {
    // 13:00 UTC is 05:00 in America/Los_Angeles (UTC-8 in January) — outside
    // an 8am-5pm window in that timezone, even though the raw UTC hour (13)
    // would have passed the old, buggy UTC-only check.
    const result = isWithinSendWindow({
      sendDays: ['wednesday'], sendStartHour: 8, sendEndHour: 17, timezone: 'America/Los_Angeles',
    });
    expect(result).toBe(false);
  });

  it('correctly allows a send when the configured timezone\'s local hour is inside the window', () => {
    // 13:00 UTC is 05:00 in Los Angeles — expand the window to include it.
    const result = isWithinSendWindow({
      sendDays: ['wednesday'], sendStartHour: 0, sendEndHour: 12, timezone: 'America/Los_Angeles',
    });
    expect(result).toBe(true);
  });

  it('rejects a send once the configured timezone\'s local hour rolls past sendEndHour', () => {
    // 13:00 UTC is 18:30 in Asia/Kolkata (UTC+5:30) — past a 17:00 end hour.
    const result = isWithinSendWindow({
      sendDays: ['wednesday'], sendStartHour: 8, sendEndHour: 17, timezone: 'Asia/Kolkata',
    });
    expect(result).toBe(false);
  });

  it('falls back to allowed on an invalid timezone string instead of throwing', () => {
    const result = isWithinSendWindow({
      sendDays: ['wednesday'], sendStartHour: 8, sendEndHour: 17, timezone: 'Not/ARealZone',
    });
    expect(result).toBe(true);
  });
});
