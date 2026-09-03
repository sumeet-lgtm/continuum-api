import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../plugins/errorHandler.js';

const STATIC_FIELDS = ['email', 'first_name', 'last_name', 'status', 'subscribed_after', 'subscribed_before'];

const filterRuleSchema = z.object({
  field: z.string().refine(
    v => STATIC_FIELDS.includes(v) || /^custom\..+$/.test(v),
    { message: `field must be one of: ${STATIC_FIELDS.join(', ')}, or a custom.<key> field` },
  ),
  operator: z.enum(['equals', 'not_equals', 'contains', 'starts_with', 'before', 'after']),
  value: z.string(),
});

const createSchema = z.object({
  name: z.string().min(1).max(200),
  list_id: z.string().optional(),
  filter_rules: z.array(filterRuleSchema).min(1).max(20),
});

export async function segmentRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /v1/segments
  fastify.post('/segments', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

    const apiKeyId = request.apiKey.id;
    const { name, list_id, filter_rules } = parsed.data;

    const segment = await prisma.segment.create({
      data: { apiKeyId, name, listId: list_id ?? null, filterRules: filter_rules },
      select: { id: true, name: true, listId: true, filterRules: true, createdAt: true },
    });
    return reply.status(201).send(segment);
  });

  // GET /v1/segments
  fastify.get('/segments', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const apiKeyId = request.apiKey.id;
    const q = request.query as { list_id?: string };

    const segments = await prisma.segment.findMany({
      where: { apiKeyId, ...(q.list_id ? { listId: q.list_id } : {}) },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, listId: true, filterRules: true, createdAt: true },
    });
    return reply.status(200).send({ data: segments });
  });

  // GET /v1/segments/:id
  fastify.get('/segments/:id', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;

    const segment = await prisma.segment.findFirst({
      where: { id, apiKeyId },
      select: { id: true, name: true, listId: true, filterRules: true, createdAt: true },
    });
    if (!segment) throw Errors.notFound('Segment not found.');

    // Count matching contacts
    const rules = segment.filterRules as Array<{ field: string; operator: string; value: string }>;
    let count = 0;
    if (segment.listId) {
      const memberships = await prisma.contactListMembership.findMany({
        where: { listId: segment.listId, status: 'subscribed' },
        include: { contact: true },
      });
      count = memberships.filter(m => matchRules(m.contact, rules)).length;
    }

    return reply.status(200).send({ ...segment, matching_contacts: count });
  });

  // PATCH /v1/segments/:id — update name and/or filter rules
  fastify.patch('/segments/:id', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const body = request.body as { name?: string; filter_rules?: Array<{ field: string; operator: string; value: string }> };

    const existing = await prisma.segment.findFirst({ where: { id, apiKeyId } });
    if (!existing) throw Errors.notFound('Segment not found.');

    const updated = await prisma.segment.update({
      where: { id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.filter_rules !== undefined && { filterRules: body.filter_rules }),
      },
    });
    return reply.status(200).send(updated);
  });

  // GET /v1/segments/:id/contacts — preview matching contacts (up to 200)
  fastify.get('/segments/:id/contacts', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;

    const segment = await prisma.segment.findFirst({
      where: { id, apiKeyId },
      select: { id: true, listId: true, filterRules: true },
    });
    if (!segment) throw Errors.notFound('Segment not found.');

    const rules = segment.filterRules as Array<{ field: string; operator: string; value: string }>;
    let contacts: Array<{ email: string; firstName: string | null; lastName: string | null }> = [];
    if (segment.listId) {
      const memberships = await prisma.contactListMembership.findMany({
        where: { listId: segment.listId, status: 'subscribed' },
        include: { contact: { select: { email: true, firstName: true, lastName: true } } },
      });
      contacts = memberships
        .filter(m => matchRules(m.contact, rules))
        .slice(0, 200)
        .map(m => m.contact);
    }

    return reply.status(200).send({ total: contacts.length, data: contacts });
  });

  // DELETE /v1/segments/:id
  fastify.delete('/segments/:id', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;

    const existing = await prisma.segment.findFirst({ where: { id, apiKeyId } });
    if (!existing) throw Errors.notFound('Segment not found.');

    await prisma.segment.delete({ where: { id } });
    return reply.status(200).send({ deleted: true, id });
  });
}

function matchRules(contact: { email: string; firstName: string | null; lastName: string | null; customFields?: unknown }, rules: Array<{ field: string; operator: string; value: string }>): boolean {
  return rules.every(rule => {
    let fieldVal: string;
    if (rule.field === 'email') fieldVal = contact.email;
    else if (rule.field === 'first_name') fieldVal = contact.firstName ?? '';
    else if (rule.field === 'last_name') fieldVal = contact.lastName ?? '';
    else if (rule.field.startsWith('custom.')) {
      const key = rule.field.slice(7);
      const cf = contact.customFields as Record<string, unknown> | null | undefined;
      fieldVal = cf ? String(cf[key] ?? '') : '';
    } else fieldVal = '';

    switch (rule.operator) {
      case 'equals': return fieldVal.toLowerCase() === rule.value.toLowerCase();
      case 'not_equals': return fieldVal.toLowerCase() !== rule.value.toLowerCase();
      case 'contains': return fieldVal.toLowerCase().includes(rule.value.toLowerCase());
      case 'starts_with': return fieldVal.toLowerCase().startsWith(rule.value.toLowerCase());
      default: return true;
    }
  });
}
