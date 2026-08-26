import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../plugins/errorHandler.js';

const subscribeSchema = z.object({
  email: z.string().email().transform(s => s.trim().toLowerCase()),
  first_name: z.string().max(100).optional(),
  last_name: z.string().max(100).optional(),
  custom_fields: z.record(z.unknown()).optional(),
  gdpr_consent: z.boolean().default(false),
  silent: z.boolean().default(true),
});

const importSchema = z.object({
  list_id: z.string(),
  csv_content: z.string(), // base64
});

export async function contactRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /v1/lists/:id/contacts
  fastify.post('/lists/:id/contacts', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id: listId } = request.params as { id: string };
    const parsed = subscribeSchema.safeParse(request.body);
    if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

    const apiKeyId = request.apiKey.id;
    const { email, first_name, last_name, custom_fields, gdpr_consent } = parsed.data;

    // Check list ownership
    const list = await prisma.mailingList.findFirst({ where: { id: listId, apiKeyId } });
    if (!list) throw Errors.notFound('List not found.');

    // Suppression check
    const suppressed = await prisma.suppression.findUnique({ where: { email } });
    if (suppressed) {
      throw { statusCode: 422, message: `${email} is suppressed and cannot be subscribed.` };
    }

    // Upsert contact
    const contact = await prisma.contact.upsert({
      where: { apiKeyId_email: { apiKeyId, email } },
      create: { apiKeyId, email, firstName: first_name ?? null, lastName: last_name ?? null, customFields: (custom_fields ?? {}) as Prisma.InputJsonValue },
      update: {
        ...(first_name !== undefined && { firstName: first_name }),
        ...(last_name !== undefined && { lastName: last_name }),
        ...(custom_fields !== undefined && { customFields: custom_fields as Prisma.InputJsonValue }),
      },
      select: { id: true, email: true },
    });

    // Upsert membership
    const membership = await prisma.contactListMembership.upsert({
      where: { contactId_listId: { contactId: contact.id, listId } },
      create: { contactId: contact.id, listId, status: 'subscribed', gdprConsent: gdpr_consent },
      update: { status: 'subscribed', gdprConsent: gdpr_consent },
      select: { id: true, status: true, subscribedAt: true },
    });

    // Update list contact count
    await prisma.mailingList.update({
      where: { id: listId },
      data: { contactCount: { increment: 1 } },
    }).catch(() => { /* best effort */ });

    return reply.status(201).send({ contact_id: contact.id, membership_id: membership.id, email, status: membership.status });
  });

  // GET /v1/lists/:id/contacts
  fastify.get('/lists/:id/contacts', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id: listId } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const q = request.query as { status?: string; search?: string; page?: string; limit?: string };
    const page = Math.max(1, parseInt(q.page ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(q.limit ?? '50', 10)));

    const list = await prisma.mailingList.findFirst({ where: { id: listId, apiKeyId } });
    if (!list) throw Errors.notFound('List not found.');

    const memberships = await prisma.contactListMembership.findMany({
      where: {
        listId,
        ...(q.status ? { status: q.status } : {}),
        ...(q.search ? { contact: { email: { contains: q.search, mode: 'insensitive' } } } : {}),
      },
      orderBy: { subscribedAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: { contact: { select: { email: true, firstName: true, lastName: true, customFields: true } } },
    });

    return reply.status(200).send({ data: memberships, page, limit });
  });

  // GET /v1/lists/:id/contacts/:email
  fastify.get('/lists/:id/contacts/:email', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id: listId, email: rawEmail } = request.params as { id: string; email: string };
    const email = decodeURIComponent(rawEmail).toLowerCase();
    const apiKeyId = request.apiKey.id;

    const contact = await prisma.contact.findUnique({ where: { apiKeyId_email: { apiKeyId, email } }, select: { id: true } });
    if (!contact) throw Errors.notFound('Contact not found.');

    const membership = await prisma.contactListMembership.findUnique({
      where: { contactId_listId: { contactId: contact.id, listId } },
    });
    if (!membership) throw Errors.notFound('Contact not subscribed to this list.');

    return reply.status(200).send(membership);
  });

  // DELETE /v1/lists/:id/contacts/:email — unsubscribe (soft delete)
  fastify.delete('/lists/:id/contacts/:email', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id: listId, email: rawEmail } = request.params as { id: string; email: string };
    const email = decodeURIComponent(rawEmail).toLowerCase();
    const apiKeyId = request.apiKey.id;

    const contact = await prisma.contact.findUnique({ where: { apiKeyId_email: { apiKeyId, email } }, select: { id: true } });
    if (!contact) throw Errors.notFound('Contact not found.');

    const membership = await prisma.contactListMembership.findUnique({
      where: { contactId_listId: { contactId: contact.id, listId } },
    });
    if (!membership) throw Errors.notFound('Contact not subscribed to this list.');

    await prisma.contactListMembership.update({
      where: { id: membership.id },
      data: { status: 'unsubscribed', unsubscribedAt: new Date() },
    });

    return reply.status(200).send({ unsubscribed: true, email, list_id: listId });
  });

  // GET /v1/contacts/:email — find contact globally
  fastify.get('/contacts/:email', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { email: rawEmail } = request.params as { email: string };
    const email = decodeURIComponent(rawEmail).toLowerCase();
    const apiKeyId = request.apiKey.id;

    const contact = await prisma.contact.findUnique({
      where: { apiKeyId_email: { apiKeyId, email } },
      include: { memberships: { include: { list: { select: { id: true, name: true } } } } },
    });
    if (!contact) throw Errors.notFound('Contact not found.');

    return reply.status(200).send(contact);
  });
}
