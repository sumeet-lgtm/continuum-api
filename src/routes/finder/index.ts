import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { AppError, Errors } from '../../plugins/errorHandler.js';
import { config } from '../../config.js';
import { Prisma } from '@prisma/client';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getApifyToken(): string {
  const token = (config as Record<string, unknown>)['APIFY_API_TOKEN'] as string | undefined;
  if (!token) {
    throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Lead Finder is not configured. Contact support.');
  }
  return token;
}

function getActorId(): string {
  const actorId = (config as Record<string, unknown>)['APIFY_ACTOR_ID'] as string | undefined;
  return actorId ?? 'code_crafter~apollo-io-scraper';
}

function buildApolloUrl(params: {
  titles?: string[];
  companies?: string[];
  industries?: string[];
  locations?: string[];
  headcountMin?: number;
  headcountMax?: number;
  keywords?: string;
}): string {
  const parts: string[] = [
    'https://app.apollo.io/#/people?sortByField=recommendations_score&sortAscending=false&page=1',
  ];

  for (const t of params.titles ?? []) {
    parts.push(`&personTitles[]=${encodeURIComponent(t)}`);
  }
  for (const l of params.locations ?? []) {
    parts.push(`&personLocations[]=${encodeURIComponent(l)}`);
  }
  for (const i of params.industries ?? []) {
    parts.push(`&organizationIndustryTagIds[]=${encodeURIComponent(i)}`);
  }
  if (params.companies?.[0]) {
    parts.push(`&q_organization_name=${encodeURIComponent(params.companies[0])}`);
  }
  if (params.headcountMin !== undefined || params.headcountMax !== undefined) {
    const min = params.headcountMin ?? 1;
    const max = params.headcountMax ?? 1000000;
    parts.push(`&numEmployeesRanges[]=${min},${max}`);
  }
  if (params.keywords?.trim()) {
    parts.push(`&q_keywords=${encodeURIComponent(params.keywords.trim())}`);
  }

  return parts.join('');
}

// Map a raw Apify dataset row to Continuum's lead + finder shape.
function mapFinderRow(row: Record<string, unknown>): {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  title: string | null;
  linkedinUrl: string | null;
  location: string | null;
} {
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v.trim() : null;
  const nested = (obj: unknown, key: string): string | null =>
    obj !== null && typeof obj === 'object'
      ? str((obj as Record<string, unknown>)[key])
      : null;

  const city = str(row.city);
  const country = str(row.country);
  const location =
    city && country
      ? `${city}, ${country}`
      : city ?? country ?? str(row.location);

  return {
    email:
      str(row.email) ??
      str(row.work_email) ??
      str(row.Email),
    firstName:
      str(row.firstName) ??
      str(row.first_name) ??
      str(row['First Name']),
    lastName:
      str(row.lastName) ??
      str(row.last_name) ??
      str(row['Last Name']),
    company:
      str(row.company) ??
      str(row.companyName) ??
      nested(row.organization, 'name') ??
      str(row.organization_name),
    title:
      str(row.title) ??
      str(row.jobTitle) ??
      str(row.headline),
    linkedinUrl:
      str(row.linkedin_url) ??
      str(row.linkedinUrl) ??
      str(row.linkedin),
    location,
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function finderRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /v1/finder/search — start an Apify run and return the runId immediately
  fastify.post(
    '/finder/search',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const token = getApifyToken();
      const actorId = getActorId();

      const body = request.body as {
        titles?: string[];
        companies?: string[];
        industries?: string[];
        locations?: string[];
        headcountMin?: number;
        headcountMax?: number;
        keywords?: string;
        limit?: number;
      };

      const searchUrl = buildApolloUrl({
        titles: body.titles,
        companies: body.companies,
        industries: body.industries,
        locations: body.locations,
        headcountMin: body.headcountMin,
        headcountMax: body.headcountMax,
        keywords: body.keywords,
      });

      const maxResults = Math.min(body.limit ?? 100, 1000);

      const runRes = await fetch(
        `https://api.apify.com/v2/acts/${actorId}/runs?token=${token}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            input: {
              searchUrl,
              maxResults,
              proxy: { useApifyProxy: true },
            },
          }),
        },
      );

      if (!runRes.ok) {
        const text = await runRes.text().catch(() => '');
        throw Errors.internalError(`Failed to start search: ${text.slice(0, 200)}`);
      }

      const runData = await runRes.json() as { data?: { id?: string } };
      const runId = runData?.data?.id;
      if (!runId) throw Errors.internalError('Search could not be started. Try again.');

      return reply.status(202).send({ runId, status: 'running', estimatedSeconds: 120 });
    },
  );

  // GET /v1/finder/jobs/:runId/status — poll Apify for run status
  fastify.get(
    '/finder/jobs/:runId/status',
    { preHandler: [requireAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const token = getApifyToken();
      const { runId } = request.params as { runId: string };

      const res = await fetch(
        `https://api.apify.com/v2/actor-runs/${runId}?token=${token}`,
        { headers: { Accept: 'application/json' } },
      );

      if (!res.ok) throw Errors.notFound('Run');

      const data = await res.json() as {
        data?: { id?: string; status?: string; defaultDatasetId?: string };
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
        ...(status === 'succeeded' ? { datasetId: raw?.defaultDatasetId } : {}),
      });
    },
  );

  // GET /v1/finder/jobs/:runId/results — fetch mapped results from the dataset
  fastify.get(
    '/finder/jobs/:runId/results',
    { preHandler: [requireAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const token = getApifyToken();
      const { runId } = request.params as { runId: string };
      const q = request.query as { offset?: string; limit?: string };
      const offset = Math.max(0, parseInt(q.offset ?? '0', 10));
      const limit = Math.min(200, Math.max(1, parseInt(q.limit ?? '50', 10)));

      // Resolve dataset ID from run
      const runRes = await fetch(
        `https://api.apify.com/v2/actor-runs/${runId}?fields=defaultDatasetId&token=${token}`,
        { headers: { Accept: 'application/json' } },
      );
      if (!runRes.ok) throw Errors.notFound('Run');

      const runData = await runRes.json() as { data?: { defaultDatasetId?: string } };
      const datasetId = runData?.data?.defaultDatasetId;
      if (!datasetId) {
        throw Errors.validationFailed([
          { field: 'runId', message: 'Run has no dataset yet — has it finished?' },
        ]);
      }

      // Fetch dataset items
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

      const results = rows.map(mapFinderRow);
      return reply.send({ results, total, hasMore: offset + rows.length < total });
    },
  );

  // POST /v1/finder/jobs/:runId/import — import selected (or all) results as leads
  fastify.post(
    '/finder/jobs/:runId/import',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const token = getApifyToken();
      const { runId } = request.params as { runId: string };
      const body = request.body as {
        indices?: number[];
        importAll?: boolean;
        sequenceId?: string;
      };
      const apiKeyId = request.apiKey.id;

      // Resolve dataset ID
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

      // Fetch the rows we need
      let rows: Record<string, unknown>[];
      if (body.importAll) {
        const dsRes = await fetch(
          `https://api.apify.com/v2/datasets/${datasetId}/items?limit=1000&token=${token}`,
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
        const mapped = mapFinderRow(row);
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
              customVars: {} as Prisma.InputJsonValue,
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
}
