import { Worker, type Job } from 'bullmq';
import { QUEUE_IMAP, redisConnection } from '../lib/queue.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { deriveImapHost, IMAP_PORT } from '../lib/imapHost.js';

interface ImapTickPayload {
  tick: true;
}

// Classify a reply using Claude Haiku and return intent category
async function classifyReplyBody(body: string): Promise<{ category: string; confidence: number; suggested_action: string }> {
  try {
    const apiKey = (config as Record<string, unknown>)['ANTHROPIC_API_KEY'] as string | undefined;
    if (!apiKey) return { category: 'unknown', confidence: 0, suggested_action: 'reply' };

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages: [{ role: 'user', content: `Classify this cold email reply into one category. Return JSON only.\n\nCategories: interested, not_interested, out_of_office, question, unsubscribe, bounced, unknown\n\nReply:\n${body.slice(0, 1000)}\n\nReturn: {"category":"...","confidence":0.0-1.0,"suggested_action":"reply|stop|pause|unsubscribe"}` }],
      }),
    });

    if (!response.ok) return { category: 'unknown', confidence: 0, suggested_action: 'reply' };
    const data = await response.json() as { content?: Array<{ text?: string }> };
    const raw = data.content?.[0]?.text?.trim() ?? '{}';
    const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const jsonMatch = stripped.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch ? jsonMatch[0] : stripped) as { category: string; confidence: number; suggested_action: string };
  } catch {
    return { category: 'unknown', confidence: 0, suggested_action: 'reply' };
  }
}

// Auto-enroll a lead in any REPLIED-triggered subsequences of the parent sequence
async function triggerSubsequences(parentSequenceId: string, email: string, triggerEvent: string, variables: Record<string, unknown>): Promise<void> {
  const subsequences = await prisma.sequence.findMany({
    where: { parentSequenceId, triggerEvent },
    include: { steps: { orderBy: { stepOrder: 'asc' } } },
  });

  for (const sub of subsequences) {
    const existing = await prisma.sequenceEnrollment.findUnique({
      where: { sequenceId_email: { sequenceId: sub.id, email } },
    });
    if (existing) continue;

    const delay = (sub.triggerDelayDays ?? 0) * 24 * 60 * 60 * 1000;
    const nextSendAt = sub.steps.length > 0 ? new Date(Date.now() + delay) : null;

    await prisma.sequenceEnrollment.create({
      data: { sequenceId: sub.id, email, variables: variables as never, nextSendAt, status: 'active', currentStep: 0 },
    }).catch(() => { /* ignore if already exists */ });

    logger.info({ subsequenceId: sub.id, email, triggerEvent }, 'Auto-enrolled in subsequence');
  }
}

async function pollMailboxes(): Promise<void> {
  const cfg = config as Record<string, unknown>;
  if (!cfg['IMAP_POLL_ENABLED']) return;

  const mailboxes = await prisma.mailbox.findMany({
    where: {
      status: 'active',
      OR: [{ passwordEnc: { not: null } }, { oauthTokenEnc: { not: null } }],
    },
    select: { id: true, type: true, host: true, port: true, username: true, passwordEnc: true, oauthTokenEnc: true },
  });

  for (const mailbox of mailboxes) {
    try {
      const imap = await import('imap-simple').catch(() => null);
      if (!imap) {
        logger.warn('imap-simple not installed — skipping IMAP poll');
        break;
      }

      let authConfig: { password?: string; xoauth2?: string };
      if (mailbox.oauthTokenEnc) {
        const { getOAuthAccessToken, buildXoauth2Token } = await import('../lib/oauth/tokens.js');
        const { accessToken } = await getOAuthAccessToken(mailbox.oauthTokenEnc);
        authConfig = { xoauth2: buildXoauth2Token(mailbox.username, accessToken) };
      } else {
        const { decryptValue } = await import('../lib/crypto.js');
        const mailboxSecret = config.MAILBOX_CREDS_SECRET ?? config.API_KEY_SALT;
        authConfig = { password: decryptValue(mailbox.passwordEnc!, mailboxSecret) };
      }

      const connection = await imap.connect({
        // Cast: node-imap's types mark password required even when xoauth2
        // is supplied instead (see imapHost.ts for the same note).
        imap: {
          user: mailbox.username,
          host: deriveImapHost(mailbox.host ?? 'imap.gmail.com'),
          port: IMAP_PORT,
          tls: true,
          tlsOptions: { rejectUnauthorized: true },
          authTimeout: 10000,
          ...authConfig,
        } as import('imap').Config,
      });

      await connection.openBox('INBOX');
      const since = new Date(Date.now() - 15 * 60 * 1000);
      const messages = await connection.search(['UNSEEN', ['SINCE', since.toUTCString()]], {
        bodies: ['HEADER.FIELDS (FROM SUBJECT IN-REPLY-TO MESSAGE-ID)', 'TEXT'],
        markSeen: false,
      });

      for (const msg of messages) {
        const header = msg.parts.find((p: { which: string }) => p.which.includes('HEADER'));
        if (!header) continue;

        const imap2 = await import('imap').catch(() => null);
        if (!imap2) continue;
        const parsed = imap2.default?.parseHeader?.(header.body as string) ?? {};

        const inReplyTo = (parsed['in-reply-to']?.[0] ?? '').replace(/[<>]/g, '');
        const fromEmail = (parsed['from']?.[0] ?? '').match(/<(.+?)>|(.+)/)?.[1] ?? '';
        const subject = parsed['subject']?.[0] ?? '';

        // Extract body snippet for AI classification
        const textPart = msg.parts.find((p: { which: string }) => p.which === 'TEXT');
        const bodySnippet = typeof textPart?.body === 'string' ? textPart.body.slice(0, 500) : '';

        let enrollmentId: string | null = null;
        if (inReplyTo || fromEmail) {
          const enrollment = await prisma.sequenceEnrollment.findFirst({
            where: { email: fromEmail.toLowerCase(), status: 'active' },
            select: { id: true, sequenceId: true, status: true, variables: true },
          });

          if (enrollment) {
            enrollmentId = enrollment.id;

            const seq = await prisma.sequence.findUnique({
              where: { id: enrollment.sequenceId },
              select: { stopOnReply: true, apiKeyId: true },
            });

            // AI classify the reply to determine intent
            const classification = bodySnippet
              ? await classifyReplyBody(bodySnippet)
              : { category: 'unknown', confidence: 0, suggested_action: 'reply' };

            logger.info({ fromEmail, category: classification.category, confidence: classification.confidence }, 'Reply classified');

            // OOO auto-replies: pause the enrollment for 3 business days so the
            // sequence resumes after the lead returns from vacation. We advance
            // nextSendAt rather than changing status so the enrollment stays
            // active and the lead isn't treated as having replied.
            if (classification.category === 'out_of_office') {
              const resumeAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
              await prisma.sequenceEnrollment.update({
                where: { id: enrollment.id },
                data: { nextSendAt: resumeAt },
              }).catch(() => {});
              await prisma.replyEvent.create({
                data: {
                  mailboxId: mailbox.id, fromEmail: fromEmail.toLowerCase(),
                  inReplyToMessageId: inReplyTo || null, enrollmentId: enrollment.id,
                  subject: subject || null, bodySnippet: bodySnippet || null,
                },
              }).catch(() => {});
              logger.info({ fromEmail, resumeAt }, 'OOO detected — pausing enrollment for 3 days');
              continue;
            }

            // Bounce and unsubscribe both mean "stop sending" regardless of the
            // sequence's stopOnReply setting — that flag is about whether a
            // genuine human reply pauses the sequence, not a compliance gate.
            // Suppressing on unsubscribe intent but still leaving the
            // enrollment 'active' (as this did before) would keep sending
            // after an explicit opt-out whenever stopOnReply was off.
            const isHardStop = classification.category === 'unsubscribe' || classification.category === 'bounced';
            const enrollmentStatus = classification.category === 'bounced' ? 'bounced'
              : classification.category === 'unsubscribe' ? 'unsubscribed'
              : (isHardStop || seq?.stopOnReply) ? 'replied' : 'active';

            await prisma.sequenceEnrollment.update({
              where: { id: enrollment.id },
              data: { status: enrollmentStatus, repliedAt: new Date() },
            });

            await prisma.lead.updateMany({
              where: { email: fromEmail.toLowerCase() },
              data: {
                status: classification.category === 'interested' ? 'interested'
                  : classification.category === 'not_interested' ? 'not_interested'
                  : classification.category === 'unsubscribe' ? 'unsubscribed'
                  : classification.category === 'bounced' ? 'bounced'
                  : 'replied',
                repliedAt: new Date(),
              },
            }).catch(() => {});

            // Only a genuine reply should re-enroll the lead in REPLIED-triggered
            // subsequences — a bounce or unsubscribe isn't a signal to follow up.
            if (!isHardStop) {
              const vars = (enrollment.variables as Record<string, unknown>) ?? {};
              await triggerSubsequences(enrollment.sequenceId, fromEmail.toLowerCase(), 'REPLIED', vars);
            }

            // Unsubscribe or bounce (an NDR landing in the inbox — the only
            // bounce signal a mailbox-based SMTP send ever produces, since it
            // never goes through SES/SNS) both go on the shared suppression
            // list so no other sequence or campaign can reach this address
            // either. Missing the bounce case here meant an address that
            // hard-bounced through a connected mailbox stayed fully sendable
            // everywhere else — the exact gap this list exists to close.
            if (classification.category === 'unsubscribe' || classification.category === 'bounced') {
              await prisma.suppression.upsert({
                where: { email: fromEmail.toLowerCase() },
                update: {},
                create: {
                  email: fromEmail.toLowerCase(),
                  reason: classification.category === 'unsubscribe' ? 'unsubscribed' : 'hard_bounce',
                  apiKeyId: seq?.apiKeyId ?? '',
                },
              }).catch(() => {});
            }
          }
        }

        // Persist reply event
        await prisma.replyEvent.create({
          data: {
            mailboxId: mailbox.id,
            fromEmail: fromEmail.toLowerCase(),
            inReplyToMessageId: inReplyTo || null,
            enrollmentId: enrollmentId,
            subject: subject || null,
            bodySnippet: bodySnippet || null,
          },
        }).catch(() => {});
      }

      connection.end();
    } catch (err) {
      logger.error({ err, mailboxId: mailbox.id }, 'IMAP poll failed for mailbox');
      await prisma.mailbox.update({
        where: { id: mailbox.id },
        data: { lastErrorMsg: err instanceof Error ? err.message : 'IMAP error', lastCheckedAt: new Date() },
      }).catch(() => {});
    }
  }
}

export function startImapWorker(): Worker {
  const worker = new Worker<ImapTickPayload>(
    QUEUE_IMAP,
    async (_job: Job<ImapTickPayload>) => {
      await pollMailboxes();
    },
    {
      connection: redisConnection,
      concurrency: 1,
    },
  );

  worker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id }, 'IMAP tick failed');
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'IMAP worker error (non-fatal)');
  });

  return worker;
}

export async function scheduleImapTicks(queue: import('bullmq').Queue): Promise<void> {
  await queue.add('tick', { tick: true }, {
    repeat: { every: 15 * 60 * 1000 }, // every 15 minutes
    jobId: 'imap-tick-repeat',
  });
}
