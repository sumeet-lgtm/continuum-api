import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../plugins/errorHandler.js';

const createSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
});

export async function listRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /v1/lists
  fastify.post('/lists', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

    const apiKeyId = request.apiKey.id;
    const list = await prisma.mailingList.create({
      data: { apiKeyId, name: parsed.data.name, description: parsed.data.description ?? null },
      select: { id: true, name: true, description: true, contactCount: true, createdAt: true },
    });
    return reply.status(201).send(list);
  });

  // GET /v1/lists
  fastify.get('/lists', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const apiKeyId = request.apiKey.id;
    const q = request.query as { page?: string; limit?: string };
    const page = Math.max(1, parseInt(q.page ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(q.limit ?? '50', 10)));

    const [items, total] = await Promise.all([
      prisma.mailingList.findMany({
        where: { apiKeyId }, orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit, take: limit,
        select: { id: true, name: true, description: true, contactCount: true, createdAt: true, updatedAt: true },
      }),
      prisma.mailingList.count({ where: { apiKeyId } }),
    ]);

    return reply.status(200).send({ data: items, total, page, limit });
  });

  // GET /v1/lists/:id
  fastify.get('/lists/:id', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const list = await prisma.mailingList.findFirst({
      where: { id, apiKeyId },
      select: { id: true, name: true, description: true, contactCount: true, createdAt: true, updatedAt: true },
    });
    if (!list) throw Errors.notFound('List not found.');
    return reply.status(200).send(list);
  });

  // PATCH /v1/lists/:id
  fastify.patch('/lists/:id', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const parsed = createSchema.partial().safeParse(request.body);
    if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

    const existing = await prisma.mailingList.findFirst({ where: { id, apiKeyId } });
    if (!existing) throw Errors.notFound('List not found.');

    const { name, description } = parsed.data;
    const updated = await prisma.mailingList.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
      },
      select: { id: true, name: true, description: true, contactCount: true, updatedAt: true },
    });
    return reply.status(200).send(updated);
  });

  // DELETE /v1/lists/:id
  fastify.delete('/lists/:id', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const existing = await prisma.mailingList.findFirst({ where: { id, apiKeyId } });
    if (!existing) throw Errors.notFound('List not found.');
    await prisma.mailingList.delete({ where: { id } });
    return reply.status(200).send({ deleted: true, id });
  });
}
