import { Worker, type Job } from 'bullmq';
import { QUEUE_SEQUENCE, redisConnection } from '../lib/queue.js';
import { prisma } from '../lib/prisma.js';
import { sendViaSes } from '../lib/ses.js';
import { sendViaSmtp } from '../lib/smtp.js';
import { generateUnsubToken, generateUnsubHtml } from '../lib/unsubscribe.js';
import { generateOpenToken, generateClickToken, injectTracking } from '../lib/tracking.js';
import { processTemplate } from '../lib/spintax.js';
import { detectESP, rankMailboxesByESP } from '../lib/espMatch.js';
import { logger } from '../lib/logger.js';

interface SequenceTickPayload {
  tick: true;
}

async function evaluateCondition(
  enrollment: { sequenceId: string; email: string; currentStep: number },
  step: { condition: string },
): Promise<boolean> {
  if (step.condition === 'always') return true;

  const trackingId = `${enrollment.sequenceId}_step${enrollment.currentStep - 1}_${enrollment.email}`;

  if (step.condition === 'if_not_opened') {
    const opened = await prisma.trackingEvent.findFirst({
      where: { sendMessageId: trackingId, type: 'open' },
    });
    return !opened;
  }

  if (step.condition === 'if_opened') {
    const opened = await prisma.trackingEvent.findFirst({
      where: { sendMessageId: trackingId, type: 'open' },
    });
    return !!opened;
  }

  if (step.condition === 'if_not_clicked') {
    const clicked = await prisma.trackingEvent.findFirst({
      where: { sendMessageId: trackingId, type: 'click' },
    });
    return !clicked;
  }

  if (step.condition === 'if_not_replied') {
    return enrollment['repliedAt' as keyof typeof enrollment] === null || enrollment['repliedAt' as keyof typeof enrollment] === undefined;
  }

  return true;
}

function isWithinSendWindow(sequence: { sendDays: string[]; sendStartHour: number; sendEndHour: number; timezone: string }): boolean {
  try {
    const now = new Date();
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayName = dayNames[now.getDay()] ?? 'sunday';
    const hour = now.getHours();

    const days = sequence.sendDays as string[];
    if (!days.includes(dayName)) return false;
    if (hour < sequence.sendStartHour || hour >= sequence.sendEndHour) return false;
    return true;
  } catch {
    return true; // Default to allowed
  }
}

export async function processSequenceTick(): Promise<void> {
  const now = new Date();

  // Find all enrollments due for their next send
  const dueEnrollments = await prisma.sequenceEnrollment.findMany({
    where: {
      status: 'active',
      nextSendAt: { lte: now },
    },
    include: {
      sequence: {
        include: {
          steps: { orderBy: { stepOrder: 'asc' } },
        },
      },
    },
    take: 100, // Process 100 per tick
  });

  // Suppression is shared across every send surface (transactional, campaigns,
  // sequences) precisely so an unsubscribe or bounce on ONE channel protects
  // the recipient everywhere — a lead who complains about a campaign or
  // replies "unsubscribe" to a transactional email must not keep getting
  // cold-outreach steps just because this worker never checked. Batched once
  // per tick rather than per-enrollment, same pattern as the campaign worker.
  const dueEmails = [...new Set(dueEnrollments.map(e => e.email))];
  const suppressions = dueEmails.length > 0
    ? await prisma.suppression.findMany({ where: { email: { in: dueEmails } }, select: { email: true, reason: true } })
    : [];
  const suppressedMap = new Map(suppressions.map(s => [s.email, s.reason]));

  for (const enrollment of dueEnrollments) {
    const { sequence } = enrollment;
    if (!sequence || sequence.status !== 'active') continue;

    const suppressionReason = suppressedMap.get(enrollment.email);
    if (suppressionReason) {
      await prisma.sequenceEnrollment.update({
        where: { id: enrollment.id },
        data: { status: suppressionReason === 'unsubscribed' ? 'unsubscribed' : 'bounced', completedAt: now },
      });
      continue;
    }

    // Check send window
    if (!isWithinSendWindow(sequence)) continue;

    // Check stopOnOpen: if any open event for this enrollment email, stop
    const seqAny = sequence as { stopOnOpen?: boolean; stopOnClick?: boolean; stopOnReply: boolean };
    if (seqAny.stopOnOpen) {
      const openTrackId = `${sequence.id}_step${enrollment.currentStep - 1}_${enrollment.email}`;
      const opened = await prisma.trackingEvent.findFirst({ where: { sendMessageId: openTrackId, type: 'open' } });
      if (opened) {
        await prisma.sequenceEnrollment.update({ where: { id: enrollment.id }, data: { status: 'completed', completedAt: now } });
        // Trigger OPENED subsequences
        const openedSubseqs = await prisma.sequence.findMany({ where: { parentSequenceId: sequence.id, triggerEvent: 'OPENED' }, include: { steps: { orderBy: { stepOrder: 'asc' } } } });
        for (const sub of openedSubseqs) {
          const exists = await prisma.sequenceEnrollment.findUnique({ where: { sequenceId_email: { sequenceId: sub.id, email: enrollment.email } } });
          if (!exists) {
            const delay = (sub.triggerDelayDays ?? 0) * 24 * 60 * 60 * 1000;
            await prisma.sequenceEnrollment.create({ data: { sequenceId: sub.id, email: enrollment.email, variables: enrollment.variables ?? {}, nextSendAt: sub.steps.length > 0 ? new Date(Date.now() + delay) : null, status: 'active', currentStep: 0 } }).catch(() => {});
          }
        }
        continue;
      }
    }

    // Check stopOnClick: if any click event for this enrollment email, stop
    if (seqAny.stopOnClick) {
      const clickTrackId = `${sequence.id}_step${enrollment.currentStep - 1}_${enrollment.email}`;
      const clicked = await prisma.trackingEvent.findFirst({ where: { sendMessageId: clickTrackId, type: 'click' } });
      if (clicked) {
        await prisma.sequenceEnrollment.update({ where: { id: enrollment.id }, data: { status: 'completed', completedAt: now } });
        const clickedSubseqs = await prisma.sequence.findMany({ where: { parentSequenceId: sequence.id, triggerEvent: 'CLICKED' }, include: { steps: { orderBy: { stepOrder: 'asc' } } } });
        for (const sub of clickedSubseqs) {
          const exists = await prisma.sequenceEnrollment.findUnique({ where: { sequenceId_email: { sequenceId: sub.id, email: enrollment.email } } });
          if (!exists) {
            const delay = (sub.triggerDelayDays ?? 0) * 24 * 60 * 60 * 1000;
            await prisma.sequenceEnrollment.create({ data: { sequenceId: sub.id, email: enrollment.email, variables: enrollment.variables ?? {}, nextSendAt: sub.steps.length > 0 ? new Date(Date.now() + delay) : null, status: 'active', currentStep: 0 } }).catch(() => {});
          }
        }
        continue;
      }
    }

    const nextStepIndex = enrollment.currentStep;
    const steps = sequence.steps;

    if (nextStepIndex >= steps.length) {
      // All steps done
      await prisma.sequenceEnrollment.update({
        where: { id: enrollment.id },
        data: { status: 'completed', completedAt: now },
      });
      continue;
    }

    const step = steps[nextStepIndex];
    if (!step) {
      await prisma.sequenceEnrollment.update({ where: { id: enrollment.id }, data: { status: 'completed', completedAt: now } });
      continue;
    }

    // Evaluate condition
    const shouldSend = await evaluateCondition(enrollment, step);
    if (!shouldSend) {
      // Skip this step, move to next
      const nextStep = steps[nextStepIndex + 1];
      const nextSendAt = nextStep
        ? new Date(now.getTime() + (nextStep.delayDays * 24 * 60 * 60 * 1000) + (nextStep.delayHours * 60 * 60 * 1000))
        : null;
      await prisma.sequenceEnrollment.update({
        where: { id: enrollment.id },
        data: { currentStep: nextStepIndex + 1, nextSendAt },
      });
      continue;
    }

    // Build personalization vars
    const vars = enrollment.variables as Record<string, string> ?? {};
    const mergedVars: Record<string, string> = {
      first_name: vars['first_name'] ?? enrollment.email.split('@')[0] ?? 'there',
      email: enrollment.email,
      unsubscribe_url: `https://api.continuumapi.com/v1/unsubscribe?token=${generateUnsubToken(enrollment.email, sequence.apiKeyId)}`,
      ...vars,
    };

    const subject = processTemplate(step.subject, mergedVars);
    let htmlBody = processTemplate(step.htmlBody, mergedVars);
    const textBody = step.textBody ? processTemplate(step.textBody, mergedVars) : undefined;

    const unsubToken = generateUnsubToken(enrollment.email, sequence.apiKeyId);
    const trackingId = `${sequence.id}_step${nextStepIndex}_${enrollment.email}`;

    if (sequence.trackOpens || sequence.trackClicks) {
      htmlBody = htmlBody.replace(/<\/body>/i, `${generateUnsubHtml(unsubToken)}</body>`);
      htmlBody = injectTracking(
        htmlBody,
        sequence.trackOpens ? generateOpenToken(trackingId) : '',
        url => sequence.trackClicks ? generateClickToken(trackingId, url) : url,
      );
    }

    // ESP-aware mailbox selection: detect recipient ESP for observability + future routing
    const recipientESP = await detectESP(enrollment.email);

    // Resolve sending mailbox: prefer ESP-matched mailbox from the pool
    let selectedMailbox: { id: string; host: string | null; port: number | null; username: string; passwordEnc: string | null; oauthTokenEnc: string | null } | null = null;
    const poolMailboxes = await prisma.mailbox.findMany({
      where: {
        apiKeyId: sequence.apiKeyId,
        status: 'active',
        host: { not: null },
        OR: [{ passwordEnc: { not: null } }, { oauthTokenEnc: { not: null } }],
      },
      select: { id: true, type: true, host: true, port: true, username: true, passwordEnc: true, oauthTokenEnc: true, sentToday: true, dailyLimit: true },
    });

    // Only pick mailboxes that haven't hit their daily limit
    const availableMailboxes = poolMailboxes.filter(m => m.sentToday < m.dailyLimit);

    if (availableMailboxes.length > 0) {
      // Thread coherence: follow-ups always come from the same mailbox as step 0.
      // If this is a follow-up (currentStep > 0) and we recorded a mailbox for
      // this enrollment, prefer that mailbox — fall through to normal selection
      // only if it's no longer available (over daily limit or disconnected).
      const threadMailboxId = (enrollment as { mailboxId?: string | null }).mailboxId;
      const threadMailbox = threadMailboxId
        ? availableMailboxes.find(m => m.id === threadMailboxId)
        : null;

      if (threadMailbox && nextStepIndex > 0) {
        selectedMailbox = threadMailbox;
      } else {
        const ranked = rankMailboxesByESP(
          availableMailboxes.map(m => ({ id: m.id, type: m.type, username: m.username })),
          recipientESP,
        );
        const preferredId = sequence.mailboxId && availableMailboxes.find(m => m.id === sequence.mailboxId)
          ? sequence.mailboxId
          : ranked[0]?.id;
        selectedMailbox = availableMailboxes.find(m => m.id === preferredId) ?? availableMailboxes[0] ?? null;
      }
    }
    logger.debug({ recipientESP, selectedMailboxId: selectedMailbox?.id, email: enrollment.email, step: nextStepIndex }, 'Sequence mailbox selected');

    const fromAddress = sequence.mailboxId && selectedMailbox
      ? selectedMailbox.username  // Send FROM the actual mailbox address for cold outreach
      : `${sequence.fromName} <${sequence.fromEmail}>`;

    try {
      if (selectedMailbox?.host && (selectedMailbox?.passwordEnc || selectedMailbox?.oauthTokenEnc)) {
        // Cold outreach path: send via user's own SMTP mailbox
        await sendViaSmtp(
          {
            host: selectedMailbox.host,
            port: selectedMailbox.port ?? 587,
            username: selectedMailbox.username,
            passwordEnc: selectedMailbox.passwordEnc,
            oauthTokenEnc: selectedMailbox.oauthTokenEnc,
          },
          {
            from: fromAddress,
            to: enrollment.email,
            subject,
            htmlBody,
            ...(textBody ? { textBody } : {}),
            listUnsubscribeHeader: `<https://api.continuumapi.com/v1/unsubscribe?token=${unsubToken}>`,
          },
        );

        // Update mailbox daily sent count
        await prisma.mailbox.update({
          where: { id: selectedMailbox.id },
          data: { sentToday: { increment: 1 } },
        }).catch(() => {});
      } else {
        // Fallback: send via shared SES
        const { sesMessageId } = await sendViaSes({
          to: enrollment.email, from: fromAddress, subject, htmlBody,
          ...(textBody ? { textBody } : {}),
          listUnsubscribeHeader: `<https://api.continuumapi.com/v1/unsubscribe?token=${unsubToken}>`,
        });

        // Register the send so the SES bounce/complaint webhook can find it —
        // same gap as campaigns had: without a SendMessage row keyed by
        // sesMessageId, a hard bounce on a sequence step (the SES-fallback
        // path specifically — mailbox-based sends get their bounce signal
        // from IMAP instead) never reached the shared suppression list.
        await prisma.sendMessage.create({
          data: {
            apiKeyId: sequence.apiKeyId, to: enrollment.email, from: fromAddress, subject,
            sesMessageId, status: 'sent', sentAt: new Date(),
          },
        }).catch((err) => {
          logger.warn({ err, email: enrollment.email, sequenceId: sequence.id }, 'Failed to register sequence send for bounce tracking (non-fatal)');
        });
      }

      // Move to next step
      const nextStep = steps[nextStepIndex + 1];
      let nextSendAt: Date | null = null;
      if (nextStep) {
        nextSendAt = new Date(now.getTime() + (nextStep.delayDays * 24 * 60 * 60 * 1000) + (nextStep.delayHours * 60 * 60 * 1000));
      }

      const isLastStep = nextStep === undefined;
      // On step 0, record the chosen mailbox so all follow-ups come from the
      // same sender (thread coherence — keeps the conversation in one thread
      // and avoids the "different sender" confusion Smartlead calls out).
      const shouldStoreMailbox = nextStepIndex === 0 && selectedMailbox?.id;
      await prisma.sequenceEnrollment.update({
        where: { id: enrollment.id },
        data: {
          currentStep: nextStepIndex + 1,
          nextSendAt,
          ...(shouldStoreMailbox && { mailboxId: selectedMailbox!.id }),
          ...(isLastStep && { status: 'completed', completedAt: now }),
        },
      });

      // On last step completion: trigger NOT_REPLIED_IN_DAYS / NOT_OPENED_IN_DAYS subsequences
      if (isLastStep) {
        const notRepliedSubseqs = await prisma.sequence.findMany({
          where: { parentSequenceId: sequence.id, triggerEvent: { in: ['NOT_REPLIED_IN_DAYS', 'NOT_OPENED_IN_DAYS'] } },
          include: { steps: { orderBy: { stepOrder: 'asc' } } },
        });
        for (const sub of notRepliedSubseqs) {
          const exists = await prisma.sequenceEnrollment.findUnique({ where: { sequenceId_email: { sequenceId: sub.id, email: enrollment.email } } });
          if (!exists) {
            const delay = (sub.triggerDelayDays ?? 3) * 24 * 60 * 60 * 1000;
            await prisma.sequenceEnrollment.create({ data: { sequenceId: sub.id, email: enrollment.email, variables: enrollment.variables ?? {}, nextSendAt: sub.steps.length > 0 ? new Date(Date.now() + delay) : null, status: 'active', currentStep: 0 } }).catch(() => {});
          }
        }
      }
    } catch (err) {
      logger.error({ err, enrollmentId: enrollment.id, email: enrollment.email }, 'Sequence step send failed');
    }
  }
}

export function startSequenceWorker(): Worker {
  const worker = new Worker<SequenceTickPayload>(
    QUEUE_SEQUENCE,
    async (_job: Job<SequenceTickPayload>) => {
      await processSequenceTick();
    },
    {
      connection: redisConnection,
      concurrency: 1,
    },
  );

  worker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id }, 'Sequence tick failed');
  });

  return worker;
}

// Schedule recurring sequence ticks (every 5 minutes)
export async function scheduleSequenceTicks(queue: import('bullmq').Queue): Promise<void> {
  await queue.add('tick', { tick: true }, {
    repeat: { every: 5 * 60 * 1000 }, // every 5 minutes
    jobId: 'sequence-tick-repeat',
  });
}
