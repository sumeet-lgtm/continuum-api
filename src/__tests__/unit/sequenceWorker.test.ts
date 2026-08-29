import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock everything the worker module touches at import time ─────────────────

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    sequenceEnrollment: { findMany: vi.fn(), update: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    suppression:        { findMany: vi.fn().mockResolvedValue([]) },
    sequence:           { findMany: vi.fn().mockResolvedValue([]) },
    trackingEvent:      { findFirst: vi.fn().mockResolvedValue(null) },
    mailbox:            { findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
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

import { processSequenceTick } from '../../workers/sequenceWorker.js';
import { prisma } from '../../lib/prisma.js';
import { sendViaSes } from '../../lib/ses.js';

const mockDue        = vi.mocked(prisma.sequenceEnrollment.findMany);
const mockUpdate      = vi.mocked(prisma.sequenceEnrollment.update);
const mockSuppression = vi.mocked(prisma.suppression.findMany);
const mockSendSes     = vi.mocked(sendViaSes);

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
