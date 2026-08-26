import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../plugins/errorHandler.js';

const createSchema = z.object({
  name: z.string().min(1).max(200),
  mailbox_id: z.string().optional(),
  from_name: z.string().min(1).max(200),
  from_email: z.string().email(),
  track_opens: z.boolean().default(true),
  track_clicks: z.boolean().default(true),
  stop_on_reply: z.boolean().default(true),
  send_days: z.array(z.enum(['monday','tuesday','wednesday','thursday','friday','saturday','sunday'])).optional(),
  send_start_hour: z.coerce.number().int().min(0).max(23).default(8),
  send_end_hour: z.coerce.number().int().min(0).max(23).default(17),
  timezone: z.string().default('UTC'),
});

const stepSchema = z.object({
  delay_days: z.coerce.number().int().min(0).max(365),
  delay_hours: z.coerce.number().int().min(0).max(23).default(0),
  subject: z.string().min(1).max(500),
  html_body: z.string().min(1),
  text_body: z.string().optional(),
  condition: z.enum(['always', 'if_not_opened', 'if_opened', 'if_not_clicked', 'if_not_replied']).default('always'),
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
    const { name, mailbox_id, from_name, from_email, track_opens, track_clicks, stop_on_reply, send_days, send_start_hour, send_end_hour, timezone } = parsed.data;

    const seq = await prisma.sequence.create({
      data: {
        apiKeyId, name, mailboxId: mailbox_id ?? null, fromName: from_name, fromEmail: from_email,
        trackOpens: track_opens, trackClicks: track_clicks, stopOnReply: stop_on_reply,
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
    const { name, mailbox_id, from_name, from_email, track_opens, track_clicks, stop_on_reply, send_days, send_start_hour, send_end_hour, timezone } = parsed.data;
    const updateData: Record<string, unknown> = {};
    if (name !== undefined) updateData['name'] = name;
    if (mailbox_id !== undefined) updateData['mailboxId'] = mailbox_id;
    if (from_name !== undefined) updateData['fromName'] = from_name;
    if (from_email !== undefined) updateData['fromEmail'] = from_email;
    if (track_opens !== undefined) updateData['trackOpens'] = track_opens;
    if (track_clicks !== undefined) updateData['trackClicks'] = track_clicks;
    if (stop_on_reply !== undefined) updateData['stopOnReply'] = stop_on_reply;
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
        delayDays: parsed.data.delay_days, delayHours: parsed.data.delay_hours,
        subject: parsed.data.subject, htmlBody: parsed.data.html_body,
        textBody: parsed.data.text_body ?? null, condition: parsed.data.condition,
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
    for (const email of emails) {
      const existing = await prisma.sequenceEnrollment.findUnique({ where: { sequenceId_email: { sequenceId: id, email } } });
      if (existing) continue;
      await prisma.sequenceEnrollment.create({
        data: { sequenceId: id, email, variables: parsed.data.variables ?? {}, nextSendAt, status: 'active', currentStep: 0 },
      });
      enrolled++;
    }

    return reply.status(200).send({ enrolled, total: emails.length });
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
    const steps = tmpl.steps as Array<{ delay_days: number; delay_hours?: number; subject: string; html_body: string; condition?: string }>;

    const seq = await prisma.sequence.create({
      data: {
        apiKeyId, name: tmpl.name, mailboxId: body?.mailbox_id ?? null,
        fromName: body?.from_name ?? 'Sender', fromEmail: body?.from_email ?? 'sender@example.com',
        steps: {
          create: steps.map((s, i) => ({
            stepOrder: i + 1, delayDays: s.delay_days, delayHours: s.delay_hours ?? 0,
            subject: s.subject, htmlBody: s.html_body, condition: s.condition ?? 'always',
          })),
        },
      },
      select: { id: true, name: true, status: true, createdAt: true },
    });
    return reply.status(201).send(seq);
  });
}
