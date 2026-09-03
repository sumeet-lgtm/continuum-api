import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { Errors, AppError } from '../../plugins/errorHandler.js';

const accountSchema = z.object({
  name: z.string().min(1).max(200),
  domain: z.string().max(200).optional(),
  industry: z.string().max(100).optional(),
  employees: z.number().int().positive().optional(),
  revenue: z.string().max(50).optional(),
  website: z.string().url().max(500).optional().or(z.literal('')),
  linkedin: z.string().max(500).optional(),
  city: z.string().max(100).optional(),
  country: z.string().max(100).optional(),
  notes: z.string().max(5000).optional(),
});

export async function accountsRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /v1/accounts
  fastify.get('/accounts', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const apiKeyId = request.apiKey.id;
    const q = request.query as { search?: string; page?: string; limit?: string; industry?: string };
    const page = Math.max(1, parseInt(q.page ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(q.limit ?? '50', 10)));

    const where: Record<string, unknown> = { apiKeyId };
    if (q.search) where['name'] = { contains: q.search, mode: 'insensitive' };
    if (q.industry) where['industry'] = q.industry;

    const [items, total] = await Promise.all([
      prisma.account.findMany({
        where: where as never,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          _count: { select: { leads: true } },
        },
      }),
      prisma.account.count({ where: where as never }),
    ]);

    return reply.status(200).send({ data: items, total, page, limit });
  });

  // GET /v1/accounts/:id
  fastify.get('/accounts/:id', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;

    const account = await prisma.account.findFirst({
      where: { id, apiKeyId },
      include: {
        leads: {
          orderBy: { createdAt: 'desc' },
          take: 100,
          select: { id: true, email: true, firstName: true, lastName: true, title: true, status: true, tags: true, createdAt: true },
        },
        _count: { select: { leads: true } },
      },
    });
    if (!account) throw Errors.notFound('Account not found.');

    return reply.status(200).send(account);
  });

  // POST /v1/accounts
  fastify.post('/accounts', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const apiKeyId = request.apiKey.id;
    const parsed = accountSchema.safeParse(request.body);
    if (!parsed.success) throw Errors.validationFailed(parsed.error.issues[0]?.message ?? 'Validation failed.');

    const { name, domain, industry, employees, revenue, website, linkedin, city, country, notes } = parsed.data;

    if (domain) {
      const existing = await prisma.account.findFirst({ where: { apiKeyId, domain } });
      if (existing) throw new AppError(409, 'CONFLICT', `An account with domain "${domain}" already exists.`);
    }

    const account = await prisma.account.create({
      data: { apiKeyId, name, domain: domain || null, industry: industry || null, employees: employees || null, revenue: revenue || null, website: website || null, linkedin: linkedin || null, city: city || null, country: country || null, notes: notes || null },
    });

    return reply.status(201).send(account);
  });

  // PATCH /v1/accounts/:id
  fastify.patch('/accounts/:id', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;

    const account = await prisma.account.findFirst({ where: { id, apiKeyId } });
    if (!account) throw Errors.notFound('Account not found.');

    const parsed = accountSchema.partial().safeParse(request.body);
    if (!parsed.success) throw Errors.validationFailed(parsed.error.issues[0]?.message ?? 'Validation failed.');

    const updateData = Object.fromEntries(
      Object.entries(parsed.data).filter(([, v]) => v !== undefined)
    );
    const updated = await prisma.account.update({ where: { id }, data: updateData as never });
    return reply.status(200).send(updated);
  });

  // DELETE /v1/accounts/:id
  fastify.delete('/accounts/:id', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;

    const account = await prisma.account.findFirst({ where: { id, apiKeyId } });
    if (!account) throw Errors.notFound('Account not found.');

    // Unlink leads before deleting
    await prisma.lead.updateMany({ where: { accountId: id }, data: { accountId: null } });
    await prisma.account.delete({ where: { id } });

    return reply.status(200).send({ deleted: true, id });
  });

  // POST /v1/accounts/:id/leads — assign lead(s) to account
  fastify.post('/accounts/:id/leads', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const body = request.body as { lead_ids?: string[]; emails?: string[] };

    const account = await prisma.account.findFirst({ where: { id, apiKeyId } });
    if (!account) throw Errors.notFound('Account not found.');

    if (body.lead_ids?.length) {
      await prisma.lead.updateMany({
        where: { id: { in: body.lead_ids }, apiKeyId },
        data: { accountId: id },
      });
    }
    if (body.emails?.length) {
      await prisma.lead.updateMany({
        where: { email: { in: body.emails.map(e => e.toLowerCase()) }, apiKeyId },
        data: { accountId: id },
      });
    }

    return reply.status(200).send({ linked: true, accountId: id });
  });

  // POST /v1/accounts/auto-match — match leads to accounts by email domain
  fastify.post('/accounts/auto-match', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const apiKeyId = request.apiKey.id;

    const accounts = await prisma.account.findMany({ where: { apiKeyId, domain: { not: null } }, select: { id: true, domain: true } });
    let matched = 0;

    for (const acct of accounts) {
      if (!acct.domain) continue;
      const domain = acct.domain.replace(/^www\./, '').toLowerCase();
      const result = await prisma.lead.updateMany({
        where: { apiKeyId, accountId: null, email: { endsWith: `@${domain}` } },
        data: { accountId: acct.id },
      });
      matched += result.count;
    }

    return reply.status(200).send({ matched });
  });
}
