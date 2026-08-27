import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../plugins/errorHandler.js';

const stepSchema = z.object({
  delay_hours: z.number().int().min(0).max(8760).default(0),
  subject: z.string().min(1).max(998),
  html_body: z.string().min(1),
  text_body: z.string().optional(),
  from_name: z.string().max(100).optional(),
  from_email: z.string().email().optional(),
  domain_id: z.string().optional(),
});

const createSchema = z.object({
  name: z.string().min(1).max(200),
  trigger_event: z.string().min(1).max(200),
  steps: z.array(stepSchema).min(1).max(20),
});

const triggerSchema = z.object({
  event: z.string().min(1).max(200),
  email: z.string().email(),
  data: z.record(z.unknown()).optional(),
});

export async function automationRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /v1/automations — create automation with steps
  fastify.post('/automations', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const apiKeyId = request.apiKey.id;
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

    const { name, trigger_event, steps } = parsed.data;

    const automation = await prisma.automation.create({
      data: {
        apiKeyId,
        name,
        triggerEvent: trigger_event,
        steps: {
          create: steps.map((s, i) => ({
            stepOrder: i,
            delayHours: s.delay_hours,
            subject: s.subject,
            htmlBody: s.html_body,
            ...(s.text_body ? { textBody: s.text_body } : {}),
            ...(s.from_name ? { fromName: s.from_name } : {}),
            ...(s.from_email ? { fromEmail: s.from_email } : {}),
            ...(s.domain_id ? { domainId: s.domain_id } : {}),
          })),
        },
      },
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
    });

    return reply.status(201).send(automation);
  });

  // GET /v1/automations
  fastify.get('/automations', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const apiKeyId = request.apiKey.id;
    const q = request.query as { page?: string; limit?: string };
    const page = Math.max(1, parseInt(q.page ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(q.limit ?? '20', 10)));

    const [items, total] = await Promise.all([
      prisma.automation.findMany({
        where: { apiKeyId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          steps: { orderBy: { stepOrder: 'asc' } },
          _count: { select: { enrollments: true } },
        },
      }),
      prisma.automation.count({ where: { apiKeyId } }),
    ]);

    return reply.status(200).send({ data: items, total, page, limit });
  });

  // GET /v1/automations/:id
  fastify.get('/automations/:id', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;

    const automation = await prisma.automation.findFirst({
      where: { id, apiKeyId },
      include: {
        steps: { orderBy: { stepOrder: 'asc' } },
        _count: { select: { enrollments: true } },
      },
    });
    if (!automation) throw Errors.notFound('Automation not found.');
    return reply.status(200).send(automation);
  });

  // PATCH /v1/automations/:id — update name/status
  fastify.patch('/automations/:id', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const body = request.body as { name?: string; status?: string };

    const existing = await prisma.automation.findFirst({ where: { id, apiKeyId } });
    if (!existing) throw Errors.notFound('Automation not found.');

    const updated = await prisma.automation.update({
      where: { id },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.status ? { status: body.status } : {}),
      },
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
    });
    return reply.status(200).send(updated);
  });

  // DELETE /v1/automations/:id
  fastify.delete('/automations/:id', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;

    const existing = await prisma.automation.findFirst({ where: { id, apiKeyId } });
    if (!existing) throw Errors.notFound('Automation not found.');

    await prisma.automation.delete({ where: { id } });
    return reply.status(200).send({ deleted: true });
  });

  // POST /v1/automations/trigger — emit an event, enroll matching email
  fastify.post('/automations/trigger', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const apiKeyId = request.apiKey.id;
    const parsed = triggerSchema.safeParse(request.body);
    if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

    const { event, email, data } = parsed.data;

    // Check suppression
    const suppressed = await prisma.suppression.findUnique({ where: { email } });
    if (suppressed) {
      return reply.status(200).send({ enrolled: false, reason: 'suppressed' });
    }

    // Find active automations listening for this event
    const automations = await prisma.automation.findMany({
      where: { apiKeyId, triggerEvent: event, status: 'active' },
      include: { steps: { orderBy: { stepOrder: 'asc' }, take: 1 } },
    });

    if (automations.length === 0) {
      return reply.status(200).send({ enrolled: false, reason: 'no_matching_automation' });
    }

    const results = await Promise.all(automations.map(async (automation) => {
      const firstStep = automation.steps[0];
      const nextSendAt = firstStep
        ? new Date(Date.now() + firstStep.delayHours * 3600 * 1000)
        : null;

      try {
        const enrollment = await prisma.automationEnrollment.upsert({
          where: { automationId_email: { automationId: automation.id, email } },
          create: {
            automationId: automation.id,
            email,
            ...(data ? { data: data as never } : {}),
            currentStep: 0,
            ...(nextSendAt ? { nextSendAt } : {}),
          },
          update: {
            // Re-enroll: reset to beginning
            status: 'active',
            currentStep: 0,
            ...(data ? { data: data as never } : {}),
            ...(nextSendAt ? { nextSendAt } : {}),
            completedAt: null,
          },
        });
        return { automationId: automation.id, enrollmentId: enrollment.id, enrolled: true };
      } catch {
        return { automationId: automation.id, enrolled: false, reason: 'already_active' };
      }
    }));

    return reply.status(200).send({ enrolled: true, enrollments: results });
  });

  // GET /v1/automations/:id/enrollments
  fastify.get('/automations/:id/enrollments', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const q = request.query as { status?: string; page?: string; limit?: string };

    const automation = await prisma.automation.findFirst({ where: { id, apiKeyId } });
    if (!automation) throw Errors.notFound('Automation not found.');

    const page = Math.max(1, parseInt(q.page ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(q.limit ?? '50', 10)));
    const where = { automationId: id, ...(q.status ? { status: q.status } : {}) };

    const [items, total] = await Promise.all([
      prisma.automationEnrollment.findMany({
        where,
        orderBy: { enrolledAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.automationEnrollment.count({ where }),
    ]);

    return reply.status(200).send({ data: items, total, page, limit });
  });

  // DELETE /v1/automations/:id/enrollments/:email — unenroll
  fastify.delete('/automations/:id/enrollments/:email', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id, email } = request.params as { id: string; email: string };
    const apiKeyId = request.apiKey.id;

    const automation = await prisma.automation.findFirst({ where: { id, apiKeyId } });
    if (!automation) throw Errors.notFound('Automation not found.');

    await prisma.automationEnrollment.updateMany({
      where: { automationId: id, email },
      data: { status: 'unsubscribed', completedAt: new Date() },
    });

    return reply.status(200).send({ unenrolled: true });
  });
}
