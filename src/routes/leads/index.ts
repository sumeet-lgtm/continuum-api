import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../plugins/errorHandler.js';
import { config } from '../../config.js';

// Normalize one Apify dataset row to the Continuum lead schema.
// Handles Apollo, LinkedIn employee/search, Google Maps, and generic CSV actors.
function mapApifyRow(row: Record<string, unknown>): {
  email?: string; first_name?: string; last_name?: string; company?: string; title?: string;
} {
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined;
  const nested = (obj: unknown, key: string): string | undefined =>
    obj !== null && typeof obj === 'object' ? str((obj as Record<string, unknown>)[key]) : undefined;

  return {
    email:      str(row.email) ?? str(row.work_email) ?? str(row.Email),
    first_name: str(row.firstName) ?? str(row.first_name) ?? str(row['First Name']) ?? str(row.first),
    last_name:  str(row.lastName)  ?? str(row.last_name)  ?? str(row['Last Name'])  ?? str(row.last),
    company:    str(row.company) ?? str(row.companyName) ?? str(row.organization_name)
                ?? nested(row.organization, 'name') ?? nested(row.company_obj, 'name'),
    title:      str(row.title) ?? str(row.jobTitle) ?? str(row.job_title)
                ?? str(row.headline) ?? str(row['Job Title']),
  };
}

async function fetchApifyDataset(datasetId: string, offset = 0, limit = 10): Promise<Record<string, unknown>[]> {
  const token = (config as Record<string, unknown>)['APIFY_API_TOKEN'] as string | undefined;
  const url = `https://api.apify.com/v2/datasets/${datasetId}/items?offset=${offset}&limit=${limit}${token ? `&token=${token}` : ''}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Apify returned ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json() as Promise<Record<string, unknown>[]>;
}

// Resolve a run ID to its default dataset ID
async function resolveRunDatasetId(runId: string): Promise<string> {
  const token = (config as Record<string, unknown>)['APIFY_API_TOKEN'] as string | undefined;
  const url = `https://api.apify.com/v2/actor-runs/${runId}?fields=defaultDatasetId${token ? `&token=${token}` : ''}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Apify run lookup returned ${res.status}`);
  const data = await res.json() as { data?: { defaultDatasetId?: string } };
  const id = data?.data?.defaultDatasetId;
  if (!id) throw new Error('Run has no defaultDatasetId yet — has it finished?');
  return id;
}

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

  // POST /v1/leads/enrich  — AI enrichment (Clay-like personalization)
  fastify.post('/leads/enrich', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const cfg = config as Record<string, unknown>;
    const apiKey = cfg['ANTHROPIC_API_KEY'] as string | undefined;
    if (!apiKey) return reply.status(503).send({ error: 'AI enrichment is not configured. Set ANTHROPIC_API_KEY.' });

    const body = request.body as { leadIds?: string[]; all?: boolean; fields?: string[] };
    const apiKeyId = request.apiKey.id;
    const requestedFields = body.fields ?? ['icebreaker', 'company_description', 'pain_point'];
    const MAX_BATCH = 50;

    let leads: Array<{ id: string; email: string; firstName: string | null; lastName: string | null; company: string | null; title: string | null }>;

    if (body.all) {
      leads = await prisma.lead.findMany({
        where: { apiKeyId },
        select: { id: true, email: true, firstName: true, lastName: true, company: true, title: true },
        take: MAX_BATCH,
      });
    } else if (body.leadIds && body.leadIds.length > 0) {
      leads = await prisma.lead.findMany({
        where: { id: { in: body.leadIds.slice(0, MAX_BATCH) }, apiKeyId },
        select: { id: true, email: true, firstName: true, lastName: true, company: true, title: true },
      });
    } else {
      return reply.status(400).send({ error: 'Provide leadIds[] or all: true' });
    }

    let enriched = 0;
    let failed = 0;

    for (const lead of leads) {
      try {
        const name = [lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.email;
        const prompt = `You are a B2B sales research assistant. Generate personalization data for a cold email outreach to this person.

Person: ${name}
Title: ${lead.title ?? 'Unknown'}
Company: ${lead.company ?? 'Unknown'}
Email domain: ${lead.email.split('@')[1] ?? ''}

Return a JSON object with these fields (keep each under 25 words, natural and specific):
${requestedFields.includes('icebreaker') ? '- "icebreaker": A genuine 1-sentence opening line referencing their role or company (not generic)' : ''}
${requestedFields.includes('company_description') ? '- "company_description": What the company likely does in 1 sentence' : ''}
${requestedFields.includes('pain_point') ? '- "pain_point": A specific challenge someone in their role typically faces' : ''}

Return only valid JSON, no explanation.`;

        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 256,
            messages: [{ role: 'user', content: prompt }],
          }),
        });

        if (!res.ok) { failed++; continue; }
        const data = await res.json() as { content?: Array<{ text?: string }> };
        const raw = data.content?.[0]?.text?.trim() ?? '{}';
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        const generated = JSON.parse(jsonMatch ? jsonMatch[0] : raw) as Record<string, string>;

        // Merge with existing customVars (don't overwrite non-AI fields)
        const existing = await prisma.lead.findUnique({
          where: { id: lead.id },
          select: { customVars: true },
        });
        const existingVars = (existing?.customVars as Record<string, unknown>) ?? {};
        const merged = { ...existingVars, ...generated };

        await prisma.lead.update({
          where: { id: lead.id },
          data: { customVars: merged as never },
        });
        enriched++;
      } catch {
        failed++;
      }
    }

    return reply.send({ enriched, failed, total: leads.length });
  });

  // GET /v1/leads/import/apify/preview?datasetId=X  (or runId=X)
  fastify.get('/leads/import/apify/preview', { preHandler: [requireAuth] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as { datasetId?: string; runId?: string };
    let datasetId = q.datasetId?.trim();
    if (!datasetId && q.runId?.trim()) {
      datasetId = await resolveRunDatasetId(q.runId.trim());
    }
    if (!datasetId) throw Errors.validationFailed([{ field: 'datasetId', message: 'datasetId or runId is required' }]);

    const rows = await fetchApifyDataset(datasetId, 0, 5).catch((err: Error) => {
      throw Errors.validationFailed([{ field: 'datasetId', message: err.message }]);
    });

    const mapped = rows.map(mapApifyRow);
    return reply.send({ datasetId, preview: mapped, rawPreview: rows.slice(0, 2) });
  });

  // POST /v1/leads/import/apify
  fastify.post('/leads/import/apify', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { datasetId?: string; runId?: string; limit?: number; sequenceId?: string };
    let datasetId = body.datasetId?.trim();
    if (!datasetId && body.runId?.trim()) {
      datasetId = await resolveRunDatasetId(body.runId.trim());
    }
    if (!datasetId) throw Errors.validationFailed([{ field: 'datasetId', message: 'datasetId or runId is required' }]);

    const maxRows = Math.min(body.limit ?? 10000, 50000);
    const apiKeyId = request.apiKey.id;
    const sequenceId = body.sequenceId?.trim() || null;

    let imported = 0;
    let skipped = 0;
    let offset = 0;
    const BATCH = 200;

    // Fetch in 200-row pages and upsert until exhausted
    while (offset < maxRows) {
      const rows = await fetchApifyDataset(datasetId, offset, BATCH).catch(() => [] as Record<string, unknown>[]);
      if (rows.length === 0) break;

      for (const row of rows) {
        const mapped = mapApifyRow(row);
        if (!mapped.email) { skipped++; continue; }
        const email = mapped.email.toLowerCase();

        await prisma.lead.upsert({
          where: { apiKeyId_email: { apiKeyId, email } },
          create: {
            apiKeyId, email,
            firstName: mapped.first_name ?? null,
            lastName:  mapped.last_name  ?? null,
            company:   mapped.company    ?? null,
            title:     mapped.title      ?? null,
            customVars: {} as Prisma.InputJsonValue,
          },
          update: {},
        }).catch(() => { skipped++; return; });
        imported++;

        if (sequenceId) {
          await prisma.sequenceEnrollment.upsert({
            where: { sequenceId_email: { sequenceId, email } },
            create: { sequenceId, email, status: 'active', nextSendAt: new Date() },
            update: {},
          }).catch(() => {});
        }
      }

      offset += rows.length;
      if (rows.length < BATCH) break;
    }

    return reply.send({ imported, skipped, total: imported + skipped, datasetId });
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
