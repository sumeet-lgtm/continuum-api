import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { AppError, Errors } from '../../plugins/errorHandler.js';
import { config } from '../../config.js';
import { Prisma } from '@prisma/client';
import { bulkQueue } from '../../lib/queue.js';
import { uploadToStorage } from '../../lib/supabase.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getSearchToken(): string {
  const token = (config as Record<string, unknown>)['APIFY_API_TOKEN'] as string | undefined;
  if (!token) {
    throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Lead Finder is not configured. Contact support.');
  }
  return token;
}

function getSearchActorId(): string {
  const actorId = (config as Record<string, unknown>)['APIFY_ACTOR_ID'] as string | undefined;
  return actorId ?? 'kVYdvNOefemtiDXO5';
}

// Compute a "likely to respond" signal from Pipeline Labs fields.
// High = likely responds to cold email; Low = hard to reach / unverified.
function computeResponseSignal(row: Record<string, unknown>): 'high' | 'medium' | 'low' {
  let score = 0;
  const emailStatus = typeof row.emailStatus === 'string' ? row.emailStatus.toLowerCase() : '';
  if (emailStatus === 'verified' || emailStatus === 'valid') score += 2;
  else if (emailStatus === 'catch_all') score += 1;

  const seniority = typeof row.seniority === 'string' ? row.seniority.toLowerCase() : '';
  if (['manager', 'director', 'senior', 'owner', 'partner'].includes(seniority)) score += 2;
  else if (['vp', 'c_suite'].includes(seniority)) score += 0;
  else score += 1;

  const size = typeof row.companySize === 'string' ? row.companySize : '';
  if (['11-50', '51-200', '201-500'].includes(size)) score += 1;

  if (typeof row.linkedinUrl === 'string' && row.linkedinUrl.includes('linkedin')) score += 1;

  if (score >= 4) return 'high';
  if (score >= 2) return 'medium';
  return 'low';
}

// Pipeline Labs actor output → Continuum lead shape
function mapLeadRow(row: Record<string, unknown>): {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  title: string | null;
  linkedinUrl: string | null;
  location: string | null;
  phone: string | null;
  companyDomain: string | null;
  companySize: string | null;
  companyIndustry: string | null;
  seniority: string | null;
  emailStatus: string | null;
  responseSignal: 'high' | 'medium' | 'low';
} {
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v.trim() : null;

  const city = str(row.personCity);
  const state = str(row.personState);
  const country = str(row.personCountry);
  const locParts = [city, state, country].filter(Boolean);
  const location = locParts.length > 0 ? locParts.join(', ') : null;

  // fullName fallback split
  let firstName = str(row.firstName);
  let lastName = str(row.lastName);
  if (!firstName && !lastName) {
    const full = str(row.fullName) ?? '';
    const parts = full.trim().split(' ');
    firstName = parts[0] ?? null;
    lastName = parts.slice(1).join(' ') || null;
  }

  return {
    email: str(row.email),
    firstName,
    lastName,
    company: str(row.companyName),
    title: str(row.title) ?? str(row.position),
    linkedinUrl: str(row.linkedinUrl),
    location,
    phone: str(row.phone),
    companyDomain: str(row.companyDomain),
    companySize: str(row.companySizeRange) ?? str(row.companySize),
    companyIndustry: str(row.companyIndustry),
    seniority: str(row.seniority),
    emailStatus: str(row.emailStatus),
    responseSignal: computeResponseSignal(row),
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function finderRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /v1/finder/search — start a people search run and return runId
  fastify.post(
    '/finder/search',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const token = getSearchToken();
      const actorId = getSearchActorId();

      const body = request.body as {
        // Job title & role
        personTitleIncludes?: string[];
        personTitleExcludes?: string[];
        includeTitleVariants?: boolean;
        seniorityIncludes?: string[];
        seniorityExcludes?: string[];
        functionIncludes?: string[];
        functionExcludes?: string[];
        roleMatchMode?: 'all' | 'any';
        // Contact
        hasEmail?: boolean;
        hasPhone?: boolean;
        // Person location
        personLocationCountryIncludes?: string[];
        personLocationStateIncludes?: string[];
        personLocationCityIncludes?: string[];
        personLocationCountryExcludes?: string[];
        // Company
        companyNameIncludes?: string[];
        companyNameExcludes?: string[];
        companyIndustryIncludes?: string[];
        companyIndustryExcludes?: string[];
        companyKeywordIncludes?: string[];
        companyKeywordExcludes?: string[];
        // Company size
        companySizeIncludes?: string[];
        companyEmployeeMin?: number;
        companyEmployeeMax?: number;
        // Company domain
        companyDomainIncludes?: string[];
        // Company location
        companyLocationCountryIncludes?: string[];
        companyLocationStateIncludes?: string[];
        companyLocationCityIncludes?: string[];
        // Technologies & revenue
        technologiesIncludes?: string[];
        annualRevenueIncludes?: string[];
        fundingStageIncludes?: string[];
        // Limit
        totalResults?: number;
      };

      const totalResults = Math.min(Math.max(body.totalResults ?? 100, 1), 2500);

      // Build Pipeline Labs actor input — only include non-empty fields
      const actorInput: Record<string, unknown> = { totalResults };

      const addArr = (key: string, val?: string[]) => {
        if (val?.length) actorInput[key] = val;
      };
      const addBool = (key: string, val?: boolean) => {
        if (val !== undefined) actorInput[key] = val;
      };
      const addNum = (key: string, val?: number) => {
        if (val !== undefined && val > 0) actorInput[key] = val;
      };
      const addStr = (key: string, val?: string) => {
        if (val) actorInput[key] = val;
      };

      addArr('personTitleIncludes', body.personTitleIncludes);
      addArr('personTitleExcludes', body.personTitleExcludes);
      addBool('includeTitleVariants', body.includeTitleVariants);
      addArr('seniorityIncludes', body.seniorityIncludes);
      addArr('seniorityExcludes', body.seniorityExcludes);
      addArr('functionIncludes', body.functionIncludes);
      addArr('functionExcludes', body.functionExcludes);
      addStr('roleMatchMode', body.roleMatchMode);
      addBool('hasEmail', body.hasEmail);
      addBool('hasPhone', body.hasPhone);
      addArr('personLocationCountryIncludes', body.personLocationCountryIncludes);
      addArr('personLocationCountryExcludes', body.personLocationCountryExcludes);
      addArr('personLocationStateIncludes', body.personLocationStateIncludes);
      addArr('personLocationCityIncludes', body.personLocationCityIncludes);
      addArr('companyNameIncludes', body.companyNameIncludes);
      addArr('companyNameExcludes', body.companyNameExcludes);
      addArr('companyIndustryIncludes', body.companyIndustryIncludes);
      addArr('companyIndustryExcludes', body.companyIndustryExcludes);
      addArr('companyKeywordIncludes', body.companyKeywordIncludes);
      addArr('companyKeywordExcludes', body.companyKeywordExcludes);
      addArr('companySizeIncludes', body.companySizeIncludes);
      addNum('companyEmployeeMin', body.companyEmployeeMin);
      addNum('companyEmployeeMax', body.companyEmployeeMax);
      addArr('companyDomainIncludes', body.companyDomainIncludes);
      addArr('companyLocationCountryIncludes', body.companyLocationCountryIncludes);
      addArr('companyLocationStateIncludes', body.companyLocationStateIncludes);
      addArr('companyLocationCityIncludes', body.companyLocationCityIncludes);
      addArr('technologiesIncludes', body.technologiesIncludes);
      addArr('annualRevenueIncludes', body.annualRevenueIncludes);
      addArr('fundingStageIncludes', body.fundingStageIncludes);

      const runRes = await fetch(
        `https://api.apify.com/v2/acts/${actorId}/runs?token=${token}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(actorInput),
        },
      );

      if (!runRes.ok) {
        const text = await runRes.text().catch(() => '');
        throw Errors.internalError(`Failed to start search: ${text.slice(0, 200)}`);
      }

      const runData = await runRes.json() as { data?: { id?: string } };
      const runId = runData?.data?.id;
      if (!runId) throw Errors.internalError('Search could not be started. Try again.');

      return reply.status(202).send({ runId, status: 'running', estimatedSeconds: 90 });
    },
  );

  // GET /v1/finder/jobs/:runId/status
  fastify.get(
    '/finder/jobs/:runId/status',
    { preHandler: [requireAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const token = getSearchToken();
      const { runId } = request.params as { runId: string };

      const res = await fetch(
        `https://api.apify.com/v2/actor-runs/${runId}?token=${token}`,
        { headers: { Accept: 'application/json' } },
      );

      if (!res.ok) throw Errors.notFound('Run');

      const data = await res.json() as {
        data?: { id?: string; status?: string; defaultDatasetId?: string; stats?: { itemCount?: number } };
      };
      const raw = data?.data;
      const apifyStatus = raw?.status ?? 'UNKNOWN';

      let status: 'running' | 'succeeded' | 'failed';
      if (['SUCCEEDED', 'READY'].includes(apifyStatus)) {
        status = 'succeeded';
      } else if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(apifyStatus)) {
        status = 'failed';
      } else {
        status = 'running';
      }

      return reply.send({
        runId,
        status,
        ...(status === 'succeeded'
          ? { datasetId: raw?.defaultDatasetId, count: raw?.stats?.itemCount ?? 0 }
          : {}),
      });
    },
  );

  // GET /v1/finder/jobs/:runId/results
  fastify.get(
    '/finder/jobs/:runId/results',
    { preHandler: [requireAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const token = getSearchToken();
      const { runId } = request.params as { runId: string };
      const q = request.query as { offset?: string; limit?: string };
      const offset = Math.max(0, parseInt(q.offset ?? '0', 10));
      const limit = Math.min(200, Math.max(1, parseInt(q.limit ?? '50', 10)));

      const runRes = await fetch(
        `https://api.apify.com/v2/actor-runs/${runId}?fields=defaultDatasetId&token=${token}`,
        { headers: { Accept: 'application/json' } },
      );
      if (!runRes.ok) throw Errors.notFound('Run');

      const runData = await runRes.json() as { data?: { defaultDatasetId?: string } };
      const datasetId = runData?.data?.defaultDatasetId;
      if (!datasetId) {
        throw Errors.validationFailed([{ field: 'runId', message: 'Run has no dataset yet.' }]);
      }

      const [dsRes, infoRes] = await Promise.all([
        fetch(
          `https://api.apify.com/v2/datasets/${datasetId}/items?offset=${offset}&limit=${limit}&token=${token}`,
          { headers: { Accept: 'application/json' } },
        ),
        fetch(
          `https://api.apify.com/v2/datasets/${datasetId}?token=${token}`,
          { headers: { Accept: 'application/json' } },
        ),
      ]);

      if (!dsRes.ok) throw Errors.internalError('Failed to fetch results.');

      const rows = await dsRes.json() as Record<string, unknown>[];
      let total = rows.length;
      if (infoRes.ok) {
        const info = await infoRes.json() as { data?: { itemCount?: number } };
        total = info?.data?.itemCount ?? rows.length;
      }

      const results = rows.map(mapLeadRow);
      return reply.send({ results, total, offset, hasMore: offset + rows.length < total });
    },
  );

  // POST /v1/finder/jobs/:runId/import — import selected results into leads
  fastify.post(
    '/finder/jobs/:runId/import',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const token = getSearchToken();
      const { runId } = request.params as { runId: string };
      const body = request.body as {
        indices?: number[];
        importAll?: boolean;
        sequenceId?: string;
      };
      const apiKeyId = request.apiKey.id;

      const runRes = await fetch(
        `https://api.apify.com/v2/actor-runs/${runId}?fields=defaultDatasetId&token=${token}`,
        { headers: { Accept: 'application/json' } },
      );
      if (!runRes.ok) throw Errors.notFound('Run');

      const runData = await runRes.json() as { data?: { defaultDatasetId?: string } };
      const datasetId = runData?.data?.defaultDatasetId;
      if (!datasetId) {
        throw Errors.validationFailed([{ field: 'runId', message: 'Run has no dataset yet.' }]);
      }

      let rows: Record<string, unknown>[];
      if (body.importAll) {
        const dsRes = await fetch(
          `https://api.apify.com/v2/datasets/${datasetId}/items?limit=2500&token=${token}`,
          { headers: { Accept: 'application/json' } },
        );
        rows = dsRes.ok ? (await dsRes.json() as Record<string, unknown>[]) : [];
      } else if (body.indices?.length) {
        const maxIndex = Math.max(...body.indices);
        const dsRes = await fetch(
          `https://api.apify.com/v2/datasets/${datasetId}/items?limit=${maxIndex + 1}&token=${token}`,
          { headers: { Accept: 'application/json' } },
        );
        const all = dsRes.ok ? (await dsRes.json() as Record<string, unknown>[]) : [];
        rows = body.indices.map((i) => all[i]).filter(Boolean) as Record<string, unknown>[];
      } else {
        return reply.send({ imported: 0, skipped: 0 });
      }

      let imported = 0;
      let skipped = 0;
      const sequenceId = body.sequenceId?.trim() || null;

      for (const row of rows) {
        const mapped = mapLeadRow(row);
        if (!mapped.email) { skipped++; continue; }
        const email = mapped.email.toLowerCase();

        try {
          await prisma.lead.upsert({
            where: { apiKeyId_email: { apiKeyId, email } },
            create: {
              apiKeyId,
              email,
              firstName: mapped.firstName ?? null,
              lastName: mapped.lastName ?? null,
              company: mapped.company ?? null,
              title: mapped.title ?? null,
              customVars: {
                ...(mapped.linkedinUrl ? { linkedin_url: mapped.linkedinUrl } : {}),
                ...(mapped.phone ? { phone: mapped.phone } : {}),
                ...(mapped.companyDomain ? { company_domain: mapped.companyDomain } : {}),
                ...(mapped.companySize ? { company_size: mapped.companySize } : {}),
                ...(mapped.companyIndustry ? { industry: mapped.companyIndustry } : {}),
                ...(mapped.location ? { location: mapped.location } : {}),
                ...(mapped.seniority ? { seniority: mapped.seniority } : {}),
              } as Prisma.InputJsonValue,
            },
            update: {},
          });
          imported++;

          if (sequenceId) {
            await prisma.sequenceEnrollment
              .upsert({
                where: { sequenceId_email: { sequenceId, email } },
                create: { sequenceId, email, status: 'active', nextSendAt: new Date() },
                update: {},
              })
              .catch(() => {/* best-effort */});
          }
        } catch {
          skipped++;
        }
      }

      return reply.send({ imported, skipped });
    },
  );

  // POST /v1/finder/jobs/:runId/verify — bulk-verify all emails from the run
  // Generates a CSV in memory, uploads to storage, and queues a bulk verify job.
  fastify.post(
    '/finder/jobs/:runId/verify',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const token = getSearchToken();
      const { runId } = request.params as { runId: string };
      const apiKeyId = request.apiKey.id;

      const runRes = await fetch(
        `https://api.apify.com/v2/actor-runs/${runId}?fields=defaultDatasetId&token=${token}`,
        { headers: { Accept: 'application/json' } },
      );
      if (!runRes.ok) throw Errors.notFound('Run');

      const runData = await runRes.json() as { data?: { defaultDatasetId?: string } };
      const datasetId = runData?.data?.defaultDatasetId;
      if (!datasetId) {
        throw Errors.validationFailed([{ field: 'runId', message: 'Run has no dataset yet.' }]);
      }

      const dsRes = await fetch(
        `https://api.apify.com/v2/datasets/${datasetId}/items?limit=2500&token=${token}`,
        { headers: { Accept: 'application/json' } },
      );
      if (!dsRes.ok) throw Errors.internalError('Failed to fetch leads for verification.');

      const rows = await dsRes.json() as Record<string, unknown>[];
      const emails = rows
        .map((r) => (typeof r.email === 'string' ? r.email.trim().toLowerCase() : null))
        .filter(Boolean) as string[];

      if (emails.length === 0) {
        return reply.send({ jobId: null, message: 'No emails in this run to verify.' });
      }

      // Build CSV in memory: "email\n..."
      const csv = `email\n${emails.join('\n')}\n`;
      const fileBuffer = Buffer.from(csv, 'utf-8');
      const jobId = randomUUID();
      const fileName = `finder-verify-${runId.slice(0, 8)}.csv`;
      const storagePath = `uploads/${apiKeyId}/${jobId}/${fileName}`;

      try {
        await uploadToStorage(config.STORAGE_BUCKET_UPLOADS, storagePath, fileBuffer, 'text/csv');
      } catch {
        throw Errors.serviceUnavailable('Storage');
      }

      await prisma.bulkJob.create({
        data: {
          id: jobId,
          apiKeyId,
          fileName,
          storagePath,
          totalEmails: emails.length,
          duplicateCount: 0,
          status: 'pending',
        },
      });

      await bulkQueue.add(
        'process-bulk',
        { jobId, apiKeyId, storagePath, fileName },
        { jobId: `bulk-${jobId}` },
      );

      return reply.status(202).send({ jobId, total: emails.length });
    },
  );
}
