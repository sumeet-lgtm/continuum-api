import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../plugins/errorHandler.js';

const createSchema = z.object({
  name: z.string().min(1).max(200),
  subject: z.string().min(1).max(500),
  html_body: z.string().min(1),
  text_body: z.string().optional(),
  variables: z.array(z.string()).optional(),
});

const updateSchema = createSchema.partial();

export async function templateRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /v1/templates
  fastify.post(
    '/templates',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

      const { name, subject, html_body, text_body, variables } = parsed.data;
      const apiKeyId = request.apiKey.id;

      const template = await prisma.emailTemplate.create({
        data: { apiKeyId, name, subject, htmlBody: html_body, textBody: text_body ?? null, variables: variables ?? [] },
        select: { id: true, name: true, subject: true, variables: true, createdAt: true },
      });

      return reply.status(201).send(template);
    },
  );

  // GET /v1/templates
  fastify.get(
    '/templates',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const apiKeyId = request.apiKey.id;
      const q = request.query as { page?: string; limit?: string };
      const page = Math.max(1, parseInt(q.page ?? '1', 10));
      const limit = Math.min(100, Math.max(1, parseInt(q.limit ?? '50', 10)));

      const [items, total] = await Promise.all([
        prisma.emailTemplate.findMany({
          where: { apiKeyId },
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
          select: { id: true, name: true, subject: true, variables: true, createdAt: true, updatedAt: true },
        }),
        prisma.emailTemplate.count({ where: { apiKeyId } }),
      ]);

      return reply.status(200).send({ data: items, total, page, limit });
    },
  );

  // GET /v1/templates/:id
  fastify.get(
    '/templates/:id',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const apiKeyId = request.apiKey.id;

      const template = await prisma.emailTemplate.findFirst({
        where: { id, apiKeyId },
        select: { id: true, name: true, subject: true, htmlBody: true, textBody: true, variables: true, createdAt: true, updatedAt: true },
      });
      if (!template) throw Errors.notFound('Template not found.');

      return reply.status(200).send(template);
    },
  );

  // PATCH /v1/templates/:id
  fastify.patch(
    '/templates/:id',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

      const apiKeyId = request.apiKey.id;
      const existing = await prisma.emailTemplate.findFirst({ where: { id, apiKeyId } });
      if (!existing) throw Errors.notFound('Template not found.');

      const { name, subject, html_body, text_body, variables } = parsed.data;
      const updated = await prisma.emailTemplate.update({
        where: { id },
        data: {
          ...(name !== undefined && { name }),
          ...(subject !== undefined && { subject }),
          ...(html_body !== undefined && { htmlBody: html_body }),
          ...(text_body !== undefined && { textBody: text_body }),
          ...(variables !== undefined && { variables }),
        },
        select: { id: true, name: true, subject: true, variables: true, updatedAt: true },
      });

      return reply.status(200).send(updated);
    },
  );

  // DELETE /v1/templates/:id
  fastify.delete(
    '/templates/:id',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const apiKeyId = request.apiKey.id;

      const existing = await prisma.emailTemplate.findFirst({ where: { id, apiKeyId } });
      if (!existing) throw Errors.notFound('Template not found.');

      await prisma.emailTemplate.delete({ where: { id } });
      return reply.status(200).send({ deleted: true, id });
    },
  );
}
