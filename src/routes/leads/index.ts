import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../plugins/errorHandler.js';

const leadSchema = z.object({
  email: z.string().email().transform(s => s.trim().toLowerCase()),
  first_name: z.string().max(100).optional(),
  last_name: z.string().max(100).optional(),
  company: z.string().max(200).optional(),
  title: z.string().max(200).optional(),
  custom_variables: z.record(z.unknown()).optional(),
  sequence_id: z.string().optional(),
});

const VALID_STATUSES = ['active', 'interested', 'not_interested', 'replied', 'unsubscribed', 'bounced', 'do_not_contact'] as const;

export async function leadRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /v1/leads
  fastify.post('/leads', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = leadSchema.safeParse(request.body);
    if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

    const apiKeyId = request.apiKey.id;
    const { email, first_name, last_name, company, title, custom_variables, sequence_id } = parsed.data;

    const lead = await prisma.lead.upsert({
      where: { apiKeyId_email: { apiKeyId, email } },
      create: { apiKeyId, email, firstName: first_name ?? null, lastName: last_name ?? null, company: company ?? null, title: title ?? null, customVars: (custom_variables ?? {}) as Prisma.InputJsonValue },
      update: {
        ...(first_name !== undefined ? { firstName: first_name } : {}),
        ...(last_name !== undefined ? { lastName: last_name } : {}),
        ...(company !== undefined ? { company } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(custom_variables !== undefined ? { customVars: custom_variables as Prisma.InputJsonValue } : {}),
      },
      select: { id: true, email: true, firstName: true, lastName: true, company: true, status: true, createdAt: true },
    });

    // Auto-enroll in sequence if provided
    if (sequence_id) {
      const seq = await prisma.sequence.findFirst({ where: { id: sequence_id, apiKeyId } });
      if (seq) {
        await prisma.sequenceEnrollment.upsert({
          where: { sequenceId_email: { sequenceId: sequence_id, email } },
          create: { sequenceId: sequence_id, email, status: 'active', nextSendAt: new Date() },
          update: {},
        });
      }
    }

    return reply.status(201).send(lead);
  });

  // POST /v1/leads/bulk
  fastify.post('/leads/bulk', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { leads?: unknown[]; sequence_id?: string };
    if (!body.leads || !Array.isArray(body.leads) || body.leads.length === 0) {
      throw Errors.validationFailed([{ field: 'leads', message: 'leads array is required' }]);
    }
    if (body.leads.length > 400) throw Errors.validationFailed([{ field: 'leads', message: 'Maximum 400 leads per batch.' }]);

    const apiKeyId = request.apiKey.id;
    let created = 0;

    for (const raw of body.leads) {
      const parsed = leadSchema.safeParse(raw);
      if (!parsed.success) continue;
      const { email, first_name, last_name, company, title, custom_variables } = parsed.data;
      await prisma.lead.upsert({
        where: { apiKeyId_email: { apiKeyId, email } },
        create: { apiKeyId, email, firstName: first_name ?? null, lastName: last_name ?? null, company: company ?? null, title: title ?? null, customVars: (custom_variables ?? {}) as Prisma.InputJsonValue },
        update: {},
      });
      created++;
    }

    return reply.status(200).send({ imported: created, total: body.leads.length });
  });

  // GET /v1/leads
  fastify.get('/leads', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const apiKeyId = request.apiKey.id;
    const q = request.query as { status?: string; sequence_id?: string; email?: string; page?: string; limit?: string };
    const page = Math.max(1, parseInt(q.page ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(q.limit ?? '50', 10)));

    const where: Record<string, unknown> = { apiKeyId };
    if (q.status) where['status'] = q.status;
    if (q.email) where['email'] = { contains: q.email.toLowerCase(), mode: 'insensitive' };

    const [items, total] = await Promise.all([
      prisma.lead.findMany({
        where: where as never,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit, take: limit,
        select: { id: true, email: true, firstName: true, lastName: true, company: true, title: true, status: true, createdAt: true },
      }),
      prisma.lead.count({ where: where as never }),
    ]);
    return reply.status(200).send({ data: items, total, page, limit });
  });

  // GET /v1/leads/:id
  fastify.get('/leads/:id', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const lead = await prisma.lead.findFirst({ where: { id, apiKeyId } });
    if (!lead) throw Errors.notFound('Lead not found.');
    return reply.status(200).send(lead);
  });

  // PATCH /v1/leads/:id
  fastify.patch('/leads/:id', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const lead = await prisma.lead.findFirst({ where: { id, apiKeyId } });
    if (!lead) throw Errors.notFound('Lead not found.');
    const body = request.body as Record<string, unknown>;
    const updated = await prisma.lead.update({
      where: { id },
      data: {
        ...(body['first_name'] !== undefined && { firstName: body['first_name'] as string }),
        ...(body['last_name'] !== undefined && { lastName: body['last_name'] as string }),
        ...(body['company'] !== undefined && { company: body['company'] as string }),
        ...(body['title'] !== undefined && { title: body['title'] as string }),
        ...(body['custom_variables'] !== undefined ? { customVars: body['custom_variables'] as Prisma.InputJsonValue } : {}),
      },
    });
    return reply.status(200).send(updated);
  });

  // PATCH /v1/leads/:id/status
  fastify.patch('/leads/:id/status', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const body = request.body as { status?: string };

    if (!body.status || !VALID_STATUSES.includes(body.status as typeof VALID_STATUSES[number])) {
      throw Errors.validationFailed([{ field: 'status', message: `Must be one of: ${VALID_STATUSES.join(', ')}` }]);
    }

    const lead = await prisma.lead.findFirst({ where: { id, apiKeyId } });
    if (!lead) throw Errors.notFound('Lead not found.');

    const updated = await prisma.lead.update({
      where: { id },
      data: {
        status: body.status,
        ...(body.status === 'unsubscribed' && { unsubscribedAt: new Date() }),
        ...(body.status === 'replied' && { repliedAt: new Date() }),
      },
    });
    return reply.status(200).send(updated);
  });

  // DELETE /v1/leads/:id
  fastify.delete('/leads/:id', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const lead = await prisma.lead.findFirst({ where: { id, apiKeyId } });
    if (!lead) throw Errors.notFound('Lead not found.');
    await prisma.lead.delete({ where: { id } });
    return reply.status(200).send({ deleted: true, id });
  });

  // GET /v1/leads/by-email
  fastify.get('/leads/by-email', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as { email?: string };
    if (!q.email) throw Errors.validationFailed([{ field: 'email', message: 'email query param required' }]);
    const apiKeyId = request.apiKey.id;
    const email = q.email.trim().toLowerCase();

    const lead = await prisma.lead.findUnique({
      where: { apiKeyId_email: { apiKeyId, email } },
    });
    if (!lead) throw Errors.notFound('Lead not found.');

    // Fetch enrollments separately (no Prisma back-relation on Lead)
    const enrollments = await prisma.sequenceEnrollment.findMany({
      where: { email },
      select: { sequenceId: true, status: true, currentStep: true, nextSendAt: true },
    });

    return reply.status(200).send({ ...lead, enrollments });
  });
}
