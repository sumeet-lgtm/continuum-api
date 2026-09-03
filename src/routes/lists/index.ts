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

  // GET /v1/lists/:id/hygiene?inactive_days=90
  // Returns engagement health breakdown for subscribers in this list.
  fastify.get('/lists/:id/hygiene', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const q = request.query as { inactive_days?: string };
    const inactiveDays = Math.min(365, Math.max(7, parseInt(q.inactive_days ?? '90', 10)));

    const list = await prisma.mailingList.findFirst({ where: { id, apiKeyId } });
    if (!list) throw Errors.notFound('List not found.');

    // All subscribed members
    const members = await prisma.contactListMembership.findMany({
      where: { listId: id, status: 'subscribed' },
      select: { contact: { select: { id: true, email: true, firstName: true, lastName: true } } },
    });

    if (members.length === 0) {
      return reply.status(200).send({ total: 0, active: 0, at_risk: 0, inactive: 0, never_opened: 0, contacts: [] });
    }

    const emails = members.map((m) => m.contact.email);
    const activeThreshold = new Date(Date.now() - inactiveDays * 86400000);
    const atRiskThreshold = new Date(Date.now() - inactiveDays * 2 * 86400000);

    // Most recent open/click per email (in this key's sends only)
    const recentEvents = await prisma.trackingEvent.groupBy({
      by:       ['email'],
      where:    { email: { in: emails }, type: { in: ['open', 'click'] } },
      _max:     { occurredAt: true },
    });

    const lastEngagement = new Map(recentEvents.map((e) => [e.email, e._max.occurredAt]));

    type Bucket = 'active' | 'at_risk' | 'inactive' | 'never_opened';
    const counts = { active: 0, at_risk: 0, inactive: 0, never_opened: 0 };
    const contacts = members.map((m) => {
      const email    = m.contact.email;
      const lastAt   = lastEngagement.get(email) ?? null;
      let bucket: Bucket;
      if (!lastAt)                           bucket = 'never_opened';
      else if (lastAt >= activeThreshold)    bucket = 'active';
      else if (lastAt >= atRiskThreshold)    bucket = 'at_risk';
      else                                   bucket = 'inactive';
      counts[bucket]++;
      return { id: m.contact.id, email, firstName: m.contact.firstName, lastName: m.contact.lastName, lastEngagedAt: lastAt?.toISOString() ?? null, bucket };
    });

    return reply.status(200).send({
      total:        members.length,
      active:       counts.active,
      at_risk:      counts.at_risk,
      inactive:     counts.inactive,
      never_opened: counts.never_opened,
      inactive_days: inactiveDays,
      contacts,
    });
  });

  // POST /v1/lists/:id/hygiene/suppress
  // Bulk-suppress contacts that haven't engaged in inactive_days days.
  fastify.post('/lists/:id/hygiene/suppress', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const body = request.body as { inactive_days?: number; buckets?: string[] };
    const inactiveDays = Math.min(365, Math.max(7, body.inactive_days ?? 90));
    const targetBuckets = body.buckets ?? ['inactive', 'never_opened'];

    const list = await prisma.mailingList.findFirst({ where: { id, apiKeyId } });
    if (!list) throw Errors.notFound('List not found.');

    const members = await prisma.contactListMembership.findMany({
      where: { listId: id, status: 'subscribed' },
      select: { id: true, contact: { select: { id: true, email: true } } },
    });

    const emails = members.map((m) => m.contact.email);
    const activeThreshold = new Date(Date.now() - inactiveDays * 86400000);
    const atRiskThreshold = new Date(Date.now() - inactiveDays * 2 * 86400000);

    const recentEvents = await prisma.trackingEvent.groupBy({
      by:    ['email'],
      where: { email: { in: emails }, type: { in: ['open', 'click'] } },
      _max:  { occurredAt: true },
    });
    const lastEngagement = new Map(recentEvents.map((e) => [e.email, e._max.occurredAt]));

    const toSuppress = members.filter((m) => {
      const lastAt = lastEngagement.get(m.contact.email) ?? null;
      let bucket: string;
      if (!lastAt)                           bucket = 'never_opened';
      else if (lastAt >= activeThreshold)    bucket = 'active';
      else if (lastAt >= atRiskThreshold)    bucket = 'at_risk';
      else                                   bucket = 'inactive';
      return targetBuckets.includes(bucket);
    });

    if (toSuppress.length === 0) {
      return reply.status(200).send({ suppressed: 0, message: 'No contacts matched the selected buckets.' });
    }

    // Unsubscribe from list + add to global suppression
    await prisma.contactListMembership.updateMany({
      where: { id: { in: toSuppress.map((m) => m.id) } },
      data:  { status: 'unsubscribed' },
    });

    for (const m of toSuppress) {
      await prisma.suppression.upsert({
        where:  { email: m.contact.email },
        update: { reason: 'manual' },
        create: { apiKeyId, email: m.contact.email, reason: 'manual' },
      }).catch(() => { /* ignore duplicate suppression */ });
    }

    return reply.status(200).send({ suppressed: toSuppress.length, message: `${toSuppress.length} contact(s) suppressed.` });
  });
}
