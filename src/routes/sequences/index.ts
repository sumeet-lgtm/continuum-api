import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { Errors, AppError } from '../../plugins/errorHandler.js';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { requireMonthlyQuota, incrementUsageBy } from '../../plugins/usageMeter.js';
import { deriveSequenceSegments } from '../../lib/sequenceSegments.js';
import { generateSegmentEmail } from '../../lib/emailGenerator.js';

const GROWTH_PLANS = new Set(['growth', 'scale']);

const createSchema = z.object({
  name: z.string().min(1).max(200),
  mailbox_id: z.string().optional(),
  from_name: z.string().min(1).max(200),
  from_email: z.string().email(),
  track_opens: z.boolean().default(true),
  track_clicks: z.boolean().default(true),
  stop_on_reply: z.boolean().default(true),
  stop_on_open: z.boolean().default(false),
  stop_on_click: z.boolean().default(false),
  send_days: z.array(z.enum(['monday','tuesday','wednesday','thursday','friday','saturday','sunday'])).optional(),
  send_start_hour: z.coerce.number().int().min(0).max(23).default(8),
  send_end_hour: z.coerce.number().int().min(0).max(23).default(17),
  timezone: z.string().default('UTC'),
});

const subsequenceSchema = z.object({
  name: z.string().min(1).max(200),
  trigger_event: z.enum(['REPLIED', 'OPENED', 'CLICKED', 'NOT_REPLIED_IN_DAYS', 'NOT_OPENED_IN_DAYS']),
  trigger_delay_days: z.coerce.number().int().min(0).max(365).default(0),
  mailbox_id: z.string().optional(),
  from_name: z.string().min(1).max(200),
  from_email: z.string().email(),
  track_opens: z.boolean().default(true),
  track_clicks: z.boolean().default(true),
  stop_on_reply: z.boolean().default(true),
});

const stepBaseSchema = z.object({
  type: z.enum(['email', 'linkedin', 'task']).default('email'),
  delay_days: z.coerce.number().int().min(0).max(365),
  delay_hours: z.coerce.number().int().min(0).max(23).default(0),
  subject: z.string().max(500).optional(),
  html_body: z.string().optional(),
  text_body: z.string().optional(),
  task_note: z.string().max(2000).optional(),
  condition: z.enum(['always', 'if_not_opened', 'if_opened', 'if_not_clicked', 'if_not_replied']).default('always'),
});

// The create-time schema enforces type-specific required fields; the PATCH
// schema below is a .partial() of the base object instead, since ZodEffects
// (what .superRefine() returns) has no .partial() — and superRefine's
// all-fields-present checks don't make sense against a partial update
// anyway (a field an existing step already has doesn't need to be resent).
const stepSchema = stepBaseSchema.superRefine((data, ctx) => {
  if (data.type === 'email') {
    if (!data.subject || data.subject.trim() === '') ctx.addIssue({ code: 'custom', path: ['subject'], message: 'Subject is required for email steps.' });
    if (!data.html_body || data.html_body.trim() === '') ctx.addIssue({ code: 'custom', path: ['html_body'], message: 'Body is required for email steps.' });
  } else {
    if (!data.task_note || data.task_note.trim() === '') ctx.addIssue({ code: 'custom', path: ['task_note'], message: `Instructions are required for ${data.type} steps.` });
  }
});

const enrollSchema = z.object({
  list_id: z.string().optional(),
  emails: z.array(z.string().email()).optional(),
  variables: z.record(z.string()).optional(),
}).refine(v => v.list_id || (v.emails && v.emails.length > 0), { message: 'Provide list_id or emails.' });

export async function sequenceRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /v1/sequences
  fastify.post('/sequences', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

    const apiKeyId = request.apiKey.id;
    const { name, mailbox_id, from_name, from_email, track_opens, track_clicks, stop_on_reply, stop_on_open, stop_on_click, send_days, send_start_hour, send_end_hour, timezone } = parsed.data;

    const seq = await prisma.sequence.create({
      data: {
        apiKeyId, name, mailboxId: mailbox_id ?? null, fromName: from_name, fromEmail: from_email,
        trackOpens: track_opens, trackClicks: track_clicks, stopOnReply: stop_on_reply,
        stopOnOpen: stop_on_open, stopOnClick: stop_on_click,
        sendDays: send_days ?? ['monday','tuesday','wednesday','thursday','friday'],
        sendStartHour: send_start_hour, sendEndHour: send_end_hour, timezone,
      },
      select: { id: true, name: true, status: true, fromEmail: true, createdAt: true },
    });
    return reply.status(201).send(seq);
  });

  // GET /v1/sequences
  fastify.get('/sequences', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const apiKeyId = request.apiKey.id;
    const sequences = await prisma.sequence.findMany({
      where: { apiKeyId },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { steps: true, enrollments: true } },
      },
    });
    return reply.status(200).send({ data: sequences });
  });

  // GET /v1/sequences/:id
  fastify.get('/sequences/:id', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const seq = await prisma.sequence.findFirst({
      where: { id, apiKeyId },
      include: { steps: { orderBy: { stepOrder: 'asc' } }, _count: { select: { enrollments: true } } },
    });
    if (!seq) throw Errors.notFound('Sequence not found.');
    return reply.status(200).send(seq);
  });

  // PATCH /v1/sequences/:id
  fastify.patch('/sequences/:id', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const seq = await prisma.sequence.findFirst({ where: { id, apiKeyId } });
    if (!seq) throw Errors.notFound('Sequence not found.');
    const parsed = createSchema.partial().safeParse(request.body);
    if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));
    const { name, mailbox_id, from_name, from_email, track_opens, track_clicks, stop_on_reply, stop_on_open, stop_on_click, send_days, send_start_hour, send_end_hour, timezone } = parsed.data;
    const updateData: Record<string, unknown> = {};
    if (name !== undefined) updateData['name'] = name;
    if (mailbox_id !== undefined) updateData['mailboxId'] = mailbox_id;
    if (from_name !== undefined) updateData['fromName'] = from_name;
    if (from_email !== undefined) updateData['fromEmail'] = from_email;
    if (track_opens !== undefined) updateData['trackOpens'] = track_opens;
    if (track_clicks !== undefined) updateData['trackClicks'] = track_clicks;
    if (stop_on_reply !== undefined) updateData['stopOnReply'] = stop_on_reply;
    if (stop_on_open !== undefined) updateData['stopOnOpen'] = stop_on_open;
    if (stop_on_click !== undefined) updateData['stopOnClick'] = stop_on_click;
    if (send_days !== undefined) updateData['sendDays'] = send_days;
    if (send_start_hour !== undefined) updateData['sendStartHour'] = send_start_hour;
    if (send_end_hour !== undefined) updateData['sendEndHour'] = send_end_hour;
    if (timezone !== undefined) updateData['timezone'] = timezone;
    const updated = await prisma.sequence.update({ where: { id }, data: updateData as never, select: { id: true, name: true, status: true } });
    return reply.status(200).send(updated);
  });

  // DELETE /v1/sequences/:id
  fastify.delete('/sequences/:id', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const seq = await prisma.sequence.findFirst({ where: { id, apiKeyId } });
    if (!seq) throw Errors.notFound('Sequence not found.');
    await prisma.sequence.delete({ where: { id } });
    return reply.status(200).send({ deleted: true, id });
  });

  // POST /v1/sequences/:id/steps
  fastify.post('/sequences/:id/steps', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const parsed = stepSchema.safeParse(request.body);
    if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

    const seq = await prisma.sequence.findFirst({ where: { id, apiKeyId } });
    if (!seq) throw Errors.notFound('Sequence not found.');

    const lastStep = await prisma.sequenceStep.findFirst({ where: { sequenceId: id }, orderBy: { stepOrder: 'desc' } });
    const stepOrder = (lastStep?.stepOrder ?? 0) + 1;

    const step = await prisma.sequenceStep.create({
      data: {
        sequenceId: id, stepOrder,
        type: parsed.data.type,
        delayDays: parsed.data.delay_days, delayHours: parsed.data.delay_hours,
        subject: parsed.data.subject ?? '',
        htmlBody: parsed.data.html_body ?? '',
        textBody: parsed.data.text_body ?? null,
        taskNote: parsed.data.task_note ?? null,
        condition: parsed.data.condition,
      },
    });
    return reply.status(201).send(step);
  });

  // GET /v1/sequences/:id/steps
  fastify.get('/sequences/:id/steps', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const seq = await prisma.sequence.findFirst({ where: { id, apiKeyId } });
    if (!seq) throw Errors.notFound('Sequence not found.');
    const steps = await prisma.sequenceStep.findMany({ where: { sequenceId: id }, orderBy: { stepOrder: 'asc' } });
    return reply.status(200).send({ data: steps });
  });

  // PATCH /v1/sequences/:id/steps/:stepId — edit an existing step
  fastify.patch('/sequences/:id/steps/:stepId', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id, stepId } = request.params as { id: string; stepId: string };
    const apiKeyId = request.apiKey.id;
    const seq = await prisma.sequence.findFirst({ where: { id, apiKeyId } });
    if (!seq) throw Errors.notFound('Sequence not found.');
    const step = await prisma.sequenceStep.findFirst({ where: { id: stepId, sequenceId: id } });
    if (!step) throw Errors.notFound('Step not found.');

    const patchSchema = stepBaseSchema.partial();
    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

    const { type, delay_days, delay_hours, subject, html_body, text_body, task_note, condition } = parsed.data;
    const updated = await prisma.sequenceStep.update({
      where: { id: stepId },
      data: {
        ...(type !== undefined && { type }),
        ...(delay_days !== undefined && { delayDays: delay_days }),
        ...(delay_hours !== undefined && { delayHours: delay_hours }),
        ...(subject !== undefined && { subject }),
        ...(html_body !== undefined && { htmlBody: html_body }),
        ...(text_body !== undefined && { textBody: text_body }),
        ...(task_note !== undefined && { taskNote: task_note }),
        ...(condition !== undefined && { condition }),
      },
    });
    return reply.status(200).send(updated);
  });

  // DELETE /v1/sequences/:id/steps/:stepId
  fastify.delete('/sequences/:id/steps/:stepId', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id, stepId } = request.params as { id: string; stepId: string };
    const apiKeyId = request.apiKey.id;
    const seq = await prisma.sequence.findFirst({ where: { id, apiKeyId } });
    if (!seq) throw Errors.notFound('Sequence not found.');
    await prisma.sequenceStep.delete({ where: { id: stepId } });
    return reply.status(200).send({ deleted: true, id: stepId });
  });

  // POST /v1/sequences/:id/contacts — enroll
  fastify.post('/sequences/:id/contacts', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const parsed = enrollSchema.safeParse(request.body);
    if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

    const seq = await prisma.sequence.findFirst({ where: { id, apiKeyId } });
    if (!seq) throw Errors.notFound('Sequence not found.');

    const body = request.body as { emails?: string[]; list_id?: string; variables?: Record<string, string>; force_move?: boolean };

    let emails: string[] = parsed.data.emails ?? [];

    if (parsed.data.list_id) {
      const members = await prisma.contactListMembership.findMany({
        where: { listId: parsed.data.list_id, status: 'subscribed' },
        include: { contact: { select: { email: true } } },
      });
      emails = [...new Set([...emails, ...members.map(m => m.contact.email)])];
    }

    const firstStep = await prisma.sequenceStep.findFirst({ where: { sequenceId: id }, orderBy: { stepOrder: 'asc' } });
    const nextSendAt = firstStep ? new Date() : null;

    let enrolled = 0;
    const conflicts: Array<{ email: string; conflictSequenceId: string; conflictSequenceName: string }> = [];

    for (const email of emails) {
      const existing = await prisma.sequenceEnrollment.findUnique({ where: { sequenceId_email: { sequenceId: id, email } } });
      if (existing) continue;

      // Cross-sequence exclusivity: one active sequence per lead
      if (!body.force_move) {
        const conflict = await prisma.sequenceEnrollment.findFirst({
          where: { email, status: 'active', NOT: { sequenceId: id } },
          select: { sequenceId: true, sequence: { select: { name: true } } },
        });
        if (conflict) {
          conflicts.push({ email, conflictSequenceId: conflict.sequenceId, conflictSequenceName: conflict.sequence?.name ?? conflict.sequenceId });
          continue;
        }
      }
      if (body.force_move) {
        // Deactivate any other active enrollment so this one becomes the sole active sequence
        await prisma.sequenceEnrollment.updateMany({
          where: { email, status: 'active', NOT: { sequenceId: id } },
          data: { status: 'paused' },
        });
      }

      await prisma.sequenceEnrollment.create({
        data: { sequenceId: id, email, variables: parsed.data.variables ?? {}, nextSendAt, status: 'active', currentStep: 0 },
      });
      enrolled++;
    }

    return reply.status(200).send({ enrolled, total: emails.length, conflicts });
  });

  // GET /v1/sequences/:id/contacts — enrollment status
  fastify.get('/sequences/:id/contacts', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const seq = await prisma.sequence.findFirst({ where: { id, apiKeyId } });
    if (!seq) throw Errors.notFound('Sequence not found.');

    const q = request.query as { status?: string; page?: string; limit?: string };
    const page = Math.max(1, parseInt(q.page ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(q.limit ?? '50', 10)));

    const [items, total] = await Promise.all([
      prisma.sequenceEnrollment.findMany({
        where: { sequenceId: id, ...(q.status ? { status: q.status } : {}) },
        orderBy: { enrolledAt: 'desc' },
        skip: (page - 1) * limit, take: limit,
      }),
      prisma.sequenceEnrollment.count({ where: { sequenceId: id } }),
    ]);
    return reply.status(200).send({ data: items, total, page, limit });
  });

  // DELETE /v1/sequences/:id/contacts/:email — unenroll
  fastify.delete('/sequences/:id/contacts/:email', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id, email: rawEmail } = request.params as { id: string; email: string };
    const email = decodeURIComponent(rawEmail).toLowerCase();
    const apiKeyId = request.apiKey.id;
    const seq = await prisma.sequence.findFirst({ where: { id, apiKeyId } });
    if (!seq) throw Errors.notFound('Sequence not found.');
    await prisma.sequenceEnrollment.update({ where: { sequenceId_email: { sequenceId: id, email } }, data: { status: 'unsubscribed' } });
    return reply.status(200).send({ unenrolled: true, email });
  });

  // POST /v1/sequences/:id/duplicate
  fastify.post('/sequences/:id/duplicate', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const seq = await prisma.sequence.findFirst({ where: { id, apiKeyId }, include: { steps: { orderBy: { stepOrder: 'asc' } } } });
    if (!seq) throw Errors.notFound('Sequence not found.');

    const copy = await prisma.sequence.create({
      data: {
        apiKeyId, name: `${seq.name} (Copy)`, mailboxId: seq.mailboxId,
        fromName: seq.fromName, fromEmail: seq.fromEmail,
        trackOpens: seq.trackOpens, trackClicks: seq.trackClicks, stopOnReply: seq.stopOnReply,
        sendDays: seq.sendDays, sendStartHour: seq.sendStartHour, sendEndHour: seq.sendEndHour, timezone: seq.timezone,
        steps: { create: seq.steps.map(s => ({ stepOrder: s.stepOrder, delayDays: s.delayDays, delayHours: s.delayHours, subject: s.subject, htmlBody: s.htmlBody, textBody: s.textBody, condition: s.condition })) },
      },
      select: { id: true, name: true, createdAt: true },
    });
    return reply.status(201).send(copy);
  });

  // GET /v1/sequence-templates
  fastify.get('/sequence-templates', { preHandler: [requireAuth, requireRateLimit] }, async (_: FastifyRequest, reply: FastifyReply) => {
    const templates = await prisma.sequenceTemplate.findMany({ orderBy: { name: 'asc' } });
    return reply.status(200).send({ data: templates });
  });

  // POST /v1/sequences/from-template/:templateId
  fastify.post('/sequences/from-template/:templateId', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { templateId } = request.params as { templateId: string };
    const apiKeyId = request.apiKey.id;

    const tmpl = await prisma.sequenceTemplate.findUnique({ where: { id: templateId } });
    if (!tmpl) throw Errors.notFound('Template not found.');

    const body = request.body as { from_name?: string; from_email?: string; mailbox_id?: string } | undefined;
    const steps = tmpl.steps as Array<{ delayDays?: number; delay_days?: number; delayHours?: number; delay_hours?: number; subject: string; htmlBody?: string; html_body?: string; condition?: string; stepOrder?: number }>;

    const seq = await prisma.sequence.create({
      data: {
        apiKeyId, name: tmpl.name, mailboxId: body?.mailbox_id ?? null,
        fromName: body?.from_name ?? 'Sender', fromEmail: body?.from_email ?? 'sender@example.com',
        steps: {
          create: steps.map((s, i) => ({
            stepOrder: s.stepOrder ?? i + 1,
            delayDays: s.delayDays ?? s.delay_days ?? 0,
            delayHours: s.delayHours ?? s.delay_hours ?? 0,
            subject: s.subject,
            htmlBody: s.htmlBody ?? s.html_body ?? '',
            condition: s.condition ?? 'always',
          })),
        },
      },
      select: { id: true, name: true, status: true, createdAt: true },
    });
    return reply.status(201).send(seq);
  });

  // ─── A/B Variant routes ─────────────────────────────────────────────────────

  const variantCreateSchema = z.object({
    variant_label: z.string().min(1).max(5),
    subject: z.string().min(1).max(500),
    html_body: z.string().min(1),
    text_body: z.string().optional(),
    weight: z.number().int().min(1).max(100).default(50),
  });

  // POST /v1/sequences/:id/steps/:stepId/variants
  fastify.post('/sequences/:id/steps/:stepId/variants', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id, stepId } = request.params as { id: string; stepId: string };
    const apiKeyId = request.apiKey.id;

    const seq = await prisma.sequence.findFirst({ where: { id, apiKeyId } });
    if (!seq) throw Errors.notFound('Sequence not found.');

    const step = await prisma.sequenceStep.findFirst({ where: { id: stepId, sequenceId: id } });
    if (!step) throw Errors.notFound('Step not found.');

    const parsed = variantCreateSchema.safeParse(request.body);
    if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

    const { variant_label, subject, html_body, text_body, weight } = parsed.data;

    const variant = await prisma.sequenceVariant.create({
      data: { stepId, variantLabel: variant_label, subject, htmlBody: html_body, textBody: text_body ?? null, weight },
      select: { id: true, stepId: true, variantLabel: true, subject: true, weight: true },
    });
    return reply.status(201).send(variant);
  });

  // GET /v1/sequences/:id/steps/:stepId/variants
  fastify.get('/sequences/:id/steps/:stepId/variants', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id, stepId } = request.params as { id: string; stepId: string };
    const apiKeyId = request.apiKey.id;

    const seq = await prisma.sequence.findFirst({ where: { id, apiKeyId } });
    if (!seq) throw Errors.notFound('Sequence not found.');

    const variants = await prisma.sequenceVariant.findMany({
      where: { stepId },
      orderBy: { variantLabel: 'asc' },
      select: { id: true, stepId: true, variantLabel: true, subject: true, htmlBody: true, textBody: true, weight: true },
    });
    return reply.status(200).send({ data: variants });
  });

  // DELETE /v1/sequences/:id/steps/:stepId/variants/:variantId
  fastify.delete('/sequences/:id/steps/:stepId/variants/:variantId', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id, stepId, variantId } = request.params as { id: string; stepId: string; variantId: string };
    const apiKeyId = request.apiKey.id;

    const seq = await prisma.sequence.findFirst({ where: { id, apiKeyId } });
    if (!seq) throw Errors.notFound('Sequence not found.');

    const variant = await prisma.sequenceVariant.findFirst({ where: { id: variantId, stepId } });
    if (!variant) throw Errors.notFound('Variant not found.');

    await prisma.sequenceVariant.delete({ where: { id: variantId } });
    return reply.status(200).send({ deleted: true, id: variantId });
  });

  // ─── Subsequence routes ─────────────────────────────────────────────────────
  // Subsequences are child sequences triggered automatically when a lead in the
  // parent sequence takes a specific action (replies, opens, clicks, or doesn't).

  // POST /v1/sequences/:id/subsequences — create a child subsequence
  fastify.post('/sequences/:id/subsequences', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;

    const parent = await prisma.sequence.findFirst({ where: { id, apiKeyId } });
    if (!parent) throw Errors.notFound('Parent sequence not found.');

    const parsed = subsequenceSchema.safeParse(request.body);
    if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

    const { name, trigger_event, trigger_delay_days, mailbox_id, from_name, from_email, track_opens, track_clicks, stop_on_reply } = parsed.data;

    const child = await prisma.sequence.create({
      data: {
        apiKeyId, name,
        parentSequenceId: id,
        triggerEvent: trigger_event,
        triggerDelayDays: trigger_delay_days,
        mailboxId: mailbox_id ?? parent.mailboxId,
        fromName: from_name, fromEmail: from_email,
        trackOpens: track_opens, trackClicks: track_clicks, stopOnReply: stop_on_reply,
        sendDays: parent.sendDays, sendStartHour: parent.sendStartHour, sendEndHour: parent.sendEndHour, timezone: parent.timezone,
      },
      select: { id: true, name: true, status: true, parentSequenceId: true, triggerEvent: true, triggerDelayDays: true, createdAt: true },
    });
    return reply.status(201).send(child);
  });

  // GET /v1/sequences/:id/subsequences — list child subsequences of a parent
  fastify.get('/sequences/:id/subsequences', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;

    const parent = await prisma.sequence.findFirst({ where: { id, apiKeyId } });
    if (!parent) throw Errors.notFound('Sequence not found.');

    const subsequences = await prisma.sequence.findMany({
      where: { parentSequenceId: id, apiKeyId },
      include: {
        _count: { select: { steps: true, enrollments: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return reply.status(200).send({ data: subsequences });
  });

  // POST /v1/sequences/:id/leads/:email/trigger-subsequence — manually trigger subsequence for a lead
  fastify.post('/sequences/:id/leads/:email/trigger-subsequence', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id, email: rawEmail } = request.params as { id: string; email: string };
    const email = decodeURIComponent(rawEmail).toLowerCase();
    const apiKeyId = request.apiKey.id;
    const body = request.body as { subsequence_id?: string } | undefined;

    const parent = await prisma.sequence.findFirst({ where: { id, apiKeyId } });
    if (!parent) throw Errors.notFound('Sequence not found.');

    const enrollment = await prisma.sequenceEnrollment.findUnique({ where: { sequenceId_email: { sequenceId: id, email } } });
    if (!enrollment) throw Errors.notFound('Lead not enrolled in this sequence.');

    // Find the target subsequence
    const whereSubseq = body?.subsequence_id
      ? { id: body.subsequence_id, parentSequenceId: id, apiKeyId }
      : { parentSequenceId: id, apiKeyId };

    const subsequence = await prisma.sequence.findFirst({ where: whereSubseq, include: { steps: { orderBy: { stepOrder: 'asc' } } } });
    if (!subsequence) throw Errors.notFound('Subsequence not found.');

    // Enroll lead in the subsequence if not already enrolled
    const existingSubEnrollment = await prisma.sequenceEnrollment.findUnique({
      where: { sequenceId_email: { sequenceId: subsequence.id, email } },
    });

    if (existingSubEnrollment) {
      return reply.status(200).send({ already_enrolled: true, enrollment_id: existingSubEnrollment.id });
    }

    const firstStep = subsequence.steps[0];
    const nextSendAt = firstStep
      ? new Date(Date.now() + ((subsequence.triggerDelayDays ?? 0) * 24 * 60 * 60 * 1000))
      : null;

    const subEnrollment = await prisma.sequenceEnrollment.create({
      data: {
        sequenceId: subsequence.id, email,
        variables: enrollment.variables ?? {},
        nextSendAt, status: 'active', currentStep: 0,
      },
      select: { id: true, sequenceId: true, email: true, status: true, nextSendAt: true },
    });

    return reply.status(201).send({ enrolled: true, enrollment: subEnrollment });
  });

  // GET /v1/sequences/:id/stats
  fastify.get('/sequences/:id/stats', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const seq = await prisma.sequence.findFirst({ where: { id, apiKeyId } });
    if (!seq) throw Errors.notFound('Sequence not found.');

    const steps = await prisma.sequenceStep.findMany({ where: { sequenceId: id }, select: { id: true } });
    const stepIds = steps.map(s => s.id);

    const [enrollmentGroups, sentCount, openCount, clickCount, replyCount] = await Promise.all([
      prisma.sequenceEnrollment.groupBy({ by: ['status'], where: { sequenceId: id }, _count: { _all: true } }),
      stepIds.length > 0 ? prisma.sendMessage.count({ where: { sequenceStepId: { in: stepIds } } }) : Promise.resolve(0),
      stepIds.length > 0 ? prisma.trackingEvent.count({ where: { type: 'open', isLikelyBot: false, sendMessage: { sequenceStepId: { in: stepIds } } } }) : Promise.resolve(0),
      stepIds.length > 0 ? prisma.trackingEvent.count({ where: { type: 'click', isLikelyBot: false, sendMessage: { sequenceStepId: { in: stepIds } } } }) : Promise.resolve(0),
      prisma.replyEvent.count({ where: { enrollment: { sequenceId: id } } }),
    ]);

    const byStatus: Record<string, number> = {};
    for (const g of enrollmentGroups) byStatus[g.status] = g._count._all;
    const totalEnrolled = Object.values(byStatus).reduce((a, b) => a + b, 0);

    return reply.status(200).send({
      totalEnrolled,
      active: byStatus['active'] ?? 0,
      completed: byStatus['completed'] ?? 0,
      replied: byStatus['replied'] ?? 0,
      bounced: byStatus['bounced'] ?? 0,
      unsubscribed: byStatus['unsubscribed'] ?? 0,
      paused: byStatus['paused'] ?? 0,
      awaitingManualAction: byStatus['awaiting_manual_action'] ?? 0,
      sent: sentCount,
      opened: openCount,
      clicked: clickCount,
      replies: replyCount,
      openRate: sentCount > 0 ? Math.round((openCount / sentCount) * 100) : 0,
      clickRate: sentCount > 0 ? Math.round((clickCount / sentCount) * 100) : 0,
      replyRate: totalEnrolled > 0 ? Math.round((replyCount / totalEnrolled) * 100) : 0,
    });
  });

  // GET /v1/tasks — every manual-channel step (LinkedIn, call, task) that's
  // waiting on a human, across every sequence this key owns. This is the
  // list processSequenceTick stops advancing past once it hits a non-email
  // step — see the worker for why.
  fastify.get('/tasks', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const apiKeyId = request.apiKey.id;

    const enrollments = await prisma.sequenceEnrollment.findMany({
      where: { status: 'awaiting_manual_action', sequence: { apiKeyId } },
      include: { sequence: { select: { id: true, name: true, steps: { orderBy: { stepOrder: 'asc' } } } } },
      orderBy: { enrolledAt: 'asc' },
      take: 200,
    });

    const tasks = enrollments.map((e) => {
      const step = e.sequence.steps[e.currentStep];
      return {
        enrollmentId: e.id,
        sequenceId: e.sequenceId,
        sequenceName: e.sequence.name,
        email: e.email,
        stepType: step?.type ?? 'task',
        subject: step?.subject ?? null,
        taskNote: step?.taskNote ?? null,
        // The step became actionable the moment its delay elapsed, which is
        // exactly what nextSendAt already held — this just stopped moving
        // once it hit a manual step, so it still reads as "since when".
        waitingSince: e.nextSendAt,
      };
    }).filter((t) => t.stepType !== 'email'); // a deleted/reordered step could leave this pointing past the end

    return reply.status(200).send({ data: tasks, total: tasks.length });
  });

  // POST /v1/sequences/:id/enrollments/:enrollmentId/complete-task — mark a
  // manual step done and advance the enrollment, exactly what the worker
  // used to do automatically for non-email steps before that got fixed.
  fastify.post(
    '/sequences/:id/enrollments/:enrollmentId/complete-task',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id, enrollmentId } = request.params as { id: string; enrollmentId: string };
      const apiKeyId = request.apiKey.id;

      const seq = await prisma.sequence.findFirst({
        where: { id, apiKeyId },
        include: { steps: { orderBy: { stepOrder: 'asc' } } },
      });
      if (!seq) throw Errors.notFound('Sequence not found.');

      const enrollment = await prisma.sequenceEnrollment.findFirst({
        where: { id: enrollmentId, sequenceId: id, status: 'awaiting_manual_action' },
      });
      if (!enrollment) throw Errors.notFound('Pending task not found for this enrollment.');

      const nextStepIndex = enrollment.currentStep + 1;
      const nextStep = seq.steps[nextStepIndex];
      const nextSendAt = nextStep
        ? new Date(Date.now() + (nextStep.delayDays * 24 * 60 * 60 * 1000) + (nextStep.delayHours * 60 * 60 * 1000))
        : null;
      const isLastStep = nextStep === undefined;

      const updated = await prisma.sequenceEnrollment.update({
        where: { id: enrollmentId },
        data: {
          currentStep: nextStepIndex,
          nextSendAt,
          status: isLastStep ? 'completed' : 'active',
          ...(isLastStep && { completedAt: new Date() }),
        },
      });

      return reply.status(200).send({ completed: true, enrollment: updated });
    },
  );

  // POST /v1/sequences/:id/generate-copy — the same non-slop engine used
  // by Campaigns (see campaigns/index.ts's generate-copy route and
  // docs/email-generation-knowledge-base.md), applied here to a
  // sequence's real enrolled leads instead of a mailing list. Sequences
  // enroll individual Leads directly, which already carry title/company
  // and link to Account (industry/employees) — richer, cleaner signal
  // than Contact.customFields, no heuristic column-name matching needed.
  const seqGenerateCopySchema = z.object({
    about: z.string().min(1).max(1000),
    sender: z.object({
      name: z.string().max(200).optional(),
      company: z.string().max(200).optional(),
      product: z.string().max(200).optional(),
    }).optional(),
    tone: z.enum(['professional', 'casual', 'direct', 'technical']).optional(),
    step_context: z.string().max(300).optional(),
    // Leads about to be enrolled, for a brand-new sequence with no
    // enrollments yet — segmentation shouldn't be stuck waiting for the
    // sequence to already be running before it can say anything real.
    lead_ids: z.array(z.string()).optional(),
    max_segments: z.number().int().min(1).max(5).default(3),
  });

  fastify.post('/sequences/:id/generate-copy', { preHandler: [requireAuth, requireRateLimit, requireMonthlyQuota] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!config.AI_PERSONALIZATION_ENABLED) {
      throw Errors.forbidden('AI features are not enabled on this account.');
    }
    const plan: string = (request.apiKey as { plan?: string }).plan ?? 'free';
    if (!GROWTH_PLANS.has(plan)) {
      throw Errors.forbidden('AI sequence copy generation requires a Growth or Scale plan.');
    }
    const anthropicKey = config.ANTHROPIC_API_KEY;
    if (!anthropicKey) throw Errors.serviceUnavailable('AI service');

    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const sequence = await prisma.sequence.findFirst({ where: { id, apiKeyId }, select: { id: true } });
    if (!sequence) throw Errors.notFound('Sequence not found.');

    const parsed = seqGenerateCopySchema.safeParse(request.body);
    if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

    const { about, sender, tone, step_context, lead_ids, max_segments } = parsed.data;

    const { totalContacts, segments } = await deriveSequenceSegments(apiKeyId, id, lead_ids ?? [], max_segments);
    if (totalContacts === 0) {
      throw Errors.validationFailed([{ field: 'lead_ids', message: 'This sequence has no enrolled leads yet — pass lead_ids for the leads you plan to enroll so there is a real audience to write for.' }]);
    }

    try {
      const emails = await Promise.all(
        segments.map((segment) => generateSegmentEmail(anthropicKey, { about, sender, tone, segment, stepContext: step_context })),
      );
      void incrementUsageBy(apiKeyId, emails.length);
      return reply.status(200).send({
        totalContacts,
        segmentCount: segments.length,
        emails,
        model: 'claude-sonnet-5',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'generation failed';
      logger.error({ err: msg }, 'Sequence copy generation failed');
      throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Copy generation failed. Please try again.');
    }
  });
}
