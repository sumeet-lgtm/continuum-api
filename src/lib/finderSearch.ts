/**
 * Shared Apify (Pipeline Labs actor) search logic — extracted from
 * routes/finder/index.ts so the Lead Finding Agent worker
 * (workers/agentRunWorker.ts) can start/poll/fetch a search exactly the
 * same way the manual POST /v1/finder/search flow does, instead of a
 * second, drifting copy of the actor-input-building and enum-normalization
 * logic (getting that wrong breaks a search with an opaque Apify error —
 * see normalizeFinderFilters's own comment on why this is checked so
 * carefully).
 */
import { AppError, Errors } from '../plugins/errorHandler.js';
import { config } from '../config.js';
import { normalizeFinderFilters } from './apifyActorSchema.js';

export function getSearchToken(): string {
  const token = (config as Record<string, unknown>)['APIFY_API_TOKEN'] as string | undefined;
  if (!token) {
    throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Lead Finder is not configured. Contact support.');
  }
  return token;
}

export function getSearchActorId(): string {
  const actorId = (config as Record<string, unknown>)['APIFY_ACTOR_ID'] as string | undefined;
  return actorId ?? 'kVYdvNOefemtiDXO5';
}

export interface FinderSearchFilters {
  personTitleIncludes?: string[];
  personTitleExcludes?: string[];
  includeTitleVariants?: boolean;
  seniorityIncludes?: string[];
  seniorityExcludes?: string[];
  functionIncludes?: string[];
  functionExcludes?: string[];
  roleMatchMode?: 'all' | 'any';
  hasEmail?: boolean;
  hasPhone?: boolean;
  personLocationCountryIncludes?: string[];
  personLocationStateIncludes?: string[];
  personLocationCityIncludes?: string[];
  personLocationCountryExcludes?: string[];
  companyNameIncludes?: string[];
  companyNameExcludes?: string[];
  companyIndustryIncludes?: string[];
  companyIndustryExcludes?: string[];
  companyKeywordIncludes?: string[];
  companyKeywordExcludes?: string[];
  companySizeIncludes?: string[];
  companyEmployeeMin?: number;
  companyEmployeeMax?: number;
  companyDomainIncludes?: string[];
  companyLocationCountryIncludes?: string[];
  companyLocationStateIncludes?: string[];
  companyLocationCityIncludes?: string[];
  technologiesIncludes?: string[];
  annualRevenueIncludes?: string[];
  fundingStageIncludes?: string[];
  totalResults?: number;
}

export async function buildFinderActorInput(
  body: FinderSearchFilters,
  totalResults: number,
): Promise<{
  actorInput: Record<string, unknown>;
  rejectedByField: Record<string, { invalid: string[]; validSample: string[]; totalValid: number }>;
  droppedByField: Record<string, string[]>;
}> {
  const actorInput: Record<string, unknown> = { totalResults };

  const addArr = (key: string, val?: string[]) => { if (val?.length) actorInput[key] = val; };
  const addBool = (key: string, val?: boolean) => { if (val !== undefined) actorInput[key] = val; };
  const addNum = (key: string, val?: number) => { if (val !== undefined && val > 0) actorInput[key] = val; };
  const addStr = (key: string, val?: string) => { if (val) actorInput[key] = val; };

  addArr('personTitleIncludes', body.personTitleIncludes);
  addArr('personTitleExcludes', body.personTitleExcludes);
  addBool('includeTitleVariants', body.includeTitleVariants);
  addStr('roleMatchMode', body.roleMatchMode);
  addBool('hasEmail', body.hasEmail);
  addBool('hasPhone', body.hasPhone);
  addArr('personLocationCityIncludes', body.personLocationCityIncludes);
  addArr('companyNameIncludes', body.companyNameIncludes);
  addArr('companyNameExcludes', body.companyNameExcludes);
  addArr('companyKeywordIncludes', body.companyKeywordIncludes);
  addArr('companyKeywordExcludes', body.companyKeywordExcludes);
  addNum('companyEmployeeMin', body.companyEmployeeMin);
  addNum('companyEmployeeMax', body.companyEmployeeMax);
  addArr('companyDomainIncludes', body.companyDomainIncludes);
  addArr('companyLocationCityIncludes', body.companyLocationCityIncludes);

  const { actorInput: normalizedInput, rejectedByField, droppedByField } = await normalizeFinderFilters({
    seniorityIncludes: body.seniorityIncludes,
    seniorityExcludes: body.seniorityExcludes,
    functionIncludes: body.functionIncludes,
    functionExcludes: body.functionExcludes,
    personLocationCountryIncludes: body.personLocationCountryIncludes,
    personLocationCountryExcludes: body.personLocationCountryExcludes,
    personLocationStateIncludes: body.personLocationStateIncludes,
    companyIndustryIncludes: body.companyIndustryIncludes,
    companyIndustryExcludes: body.companyIndustryExcludes,
    companySizeIncludes: body.companySizeIncludes,
    companyLocationCountryIncludes: body.companyLocationCountryIncludes,
    companyLocationStateIncludes: body.companyLocationStateIncludes,
    technologiesIncludes: body.technologiesIncludes,
    annualRevenueIncludes: body.annualRevenueIncludes,
    fundingStageIncludes: body.fundingStageIncludes,
  });

  for (const [field, values] of Object.entries(normalizedInput)) {
    actorInput[field] = values;
  }

  return { actorInput, rejectedByField, droppedByField };
}

export async function startFinderRun(actorInput: Record<string, unknown>): Promise<string> {
  const token = getSearchToken();
  const actorId = getSearchActorId();

  const runRes = await fetch(
    `https://api.apify.com/v2/acts/${actorId}/runs?token=${token}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(actorInput) },
  );
  if (!runRes.ok) {
    const text = await runRes.text().catch(() => '');
    throw Errors.internalError(`Failed to start search: ${text.slice(0, 200)}`);
  }
  const runData = await runRes.json() as { data?: { id?: string } };
  const runId = runData?.data?.id;
  if (!runId) throw Errors.internalError('Search could not be started. Try again.');
  return runId;
}

export async function pollFinderRun(runId: string): Promise<{ status: 'running' | 'succeeded' | 'failed'; datasetId?: string }> {
  const token = getSearchToken();
  const apifyRes = await fetch(
    `https://api.apify.com/v2/actor-runs/${runId}?token=${token}`,
    { headers: { Accept: 'application/json' } },
  );
  if (!apifyRes.ok) throw Errors.notFound('Run');

  const apifyData = await apifyRes.json() as {
    data?: { status?: string; defaultDatasetId?: string };
  };
  const apifyStatus = apifyData?.data?.status ?? 'UNKNOWN';
  const datasetId = apifyData?.data?.defaultDatasetId;

  if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(apifyStatus)) return { status: 'failed' };
  if (!['SUCCEEDED', 'READY'].includes(apifyStatus)) return { status: 'running' };
  return { status: 'succeeded', ...(datasetId !== undefined && { datasetId }) };
}

export async function fetchFinderDatasetRows(datasetId: string): Promise<Record<string, unknown>[]> {
  const token = getSearchToken();
  const dsRes = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?limit=2500&token=${token}`,
    { headers: { Accept: 'application/json' } },
  );
  if (!dsRes.ok) throw Errors.internalError('Failed to fetch results.');
  return dsRes.json() as Promise<Record<string, unknown>[]>;
}

// ─── Row mapping (moved from routes/finder/index.ts, re-exported there for
// backward compatibility — also used directly by the Lead Finding Agent
// worker) ───────────────────────────────────────────────────────────────────

// Compute a "likely to respond" signal from Pipeline Labs fields.
// High = likely responds to cold email; Low = hard to reach / unverified.
export function computeResponseSignal(row: Record<string, unknown>): 'high' | 'medium' | 'low' {
  let score = 0;
  // Normalized so "catch-all"/"catch_all"/"catchAll" all match the same way —
  // confirmed live against production that the actor actually returns
  // "deliverable" (not "verified"/"valid" as this previously checked for),
  // which meant every real lead's emailStatus silently contributed zero to
  // its score regardless of how confident the actor itself was.
  const emailStatus = typeof row.emailStatus === 'string' ? row.emailStatus.toLowerCase().replace(/[-_]/g, '') : '';
  if (['verified', 'valid', 'deliverable'].includes(emailStatus)) score += 2;
  else if (emailStatus === 'catchall') score += 1;

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
export function mapLeadRow(row: Record<string, unknown>): {
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
