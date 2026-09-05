/**
 * Validates/normalizes Finder search filters against the Pipeline Labs
 * actor's own input schema, instead of forwarding whatever the customer
 * typed straight to Apify and surfacing its raw actor-run error.
 *
 * Several Finder fields (industry, country, etc.) are strict enums on the
 * actor's side — a free-text value that doesn't match exactly (wrong
 * case, "USA" instead of "United States", "SaaS" instead of "Computer
 * Software") fails the whole search with an opaque error. This fetches
 * the actor's real enum list once (cached, since it rarely changes) and
 * does case-insensitive matching so obvious near-misses just work, while
 * genuine mismatches get a clear error instead of an Apify stack trace.
 */
import { logger } from './logger.js';
import { config } from '../config.js';

interface EnumField {
  values: string[];
  lowerToCanonical: Map<string, string>;
}

let cachedActorId: string | null = null;
let cachedSchema: Map<string, EnumField> | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // actor enums change rarely — a day-old cache is fine

async function fetchActorEnumSchema(actorId: string, token: string): Promise<Map<string, EnumField>> {
  const actorRes = await fetch(`https://api.apify.com/v2/acts/${actorId}?token=${encodeURIComponent(token)}`);
  if (!actorRes.ok) throw new Error(`Apify actor lookup failed: HTTP ${actorRes.status}`);
  const actorData = await actorRes.json() as { data?: { taggedBuilds?: { latest?: { buildId?: string } } } };
  const buildId = actorData.data?.taggedBuilds?.latest?.buildId;
  if (!buildId) throw new Error('Apify actor has no tagged latest build');

  const buildRes = await fetch(`https://api.apify.com/v2/acts/${actorId}/builds/${buildId}?token=${encodeURIComponent(token)}`);
  if (!buildRes.ok) throw new Error(`Apify build lookup failed: HTTP ${buildRes.status}`);
  const buildData = await buildRes.json() as { data?: { inputSchema?: string } };
  const inputSchemaRaw = buildData.data?.inputSchema;
  if (!inputSchemaRaw) throw new Error('Apify build has no inputSchema');

  const schema = JSON.parse(inputSchemaRaw) as {
    properties?: Record<string, { items?: { enum?: string[] }; enum?: string[] }>;
  };

  const result = new Map<string, EnumField>();
  for (const [field, prop] of Object.entries(schema.properties ?? {})) {
    const values = prop.items?.enum ?? prop.enum;
    if (!values || values.length === 0) continue;
    const lowerToCanonical = new Map<string, string>();
    for (const v of values) lowerToCanonical.set(v.toLowerCase(), v);
    result.set(field, { values, lowerToCanonical });
  }
  return result;
}

async function getEnumSchema(actorId: string, token: string): Promise<Map<string, EnumField>> {
  const fresh = cachedActorId === actorId && cachedSchema && (Date.now() - cachedAt) < CACHE_TTL_MS;
  if (fresh) return cachedSchema!;

  try {
    const schema = await fetchActorEnumSchema(actorId, token);
    cachedActorId = actorId;
    cachedSchema = schema;
    cachedAt = Date.now();
    return schema;
  } catch (err) {
    logger.warn({ err, actorId }, 'Failed to fetch/refresh Apify actor enum schema — skipping enum validation for this request');
    // Stale cache beats no validation at all; if we've never fetched
    // successfully, fall back to an empty map (no enum fields get
    // validated) rather than blocking the search entirely on our own
    // schema-fetch hiccup.
    return cachedSchema ?? new Map();
  }
}

export interface NormalizeResult {
  actorInput: Record<string, string[]>;
  /** Field -> values that couldn't be matched even case-insensitively, and were dropped. */
  droppedByField: Record<string, string[]>;
  /** Field -> values with no exact/case-insensitive match but a strict validation error is warranted (small enum, likely a genuine typo). */
  rejectedByField: Record<string, { invalid: string[]; validSample: string[]; totalValid: number }>;
}

// Enums this size or smaller get a hard validation error on a bad value
// (a typo is more likely than a legitimate value we don't know about, and
// listing a sample of valid options is actually useful at this size).
// Above this, a bad value is more likely a legitimately obscure entry
// (a technology, a small country) than a typo, so it's silently dropped
// instead of failing the whole search.
const STRICT_VALIDATION_MAX_SIZE = 150;

export async function normalizeFinderFilters(
  rawFields: Record<string, string[] | undefined>,
): Promise<NormalizeResult> {
  const actorId = (config as Record<string, unknown>)['APIFY_ACTOR_ID'] as string | undefined ?? 'kVYdvNOefemtiDXO5';
  const token = (config as Record<string, unknown>)['APIFY_API_TOKEN'] as string | undefined;

  const result: NormalizeResult = { actorInput: {}, droppedByField: {}, rejectedByField: {} };
  if (!token) return result;

  const schema = await getEnumSchema(actorId, token);

  for (const [field, rawValues] of Object.entries(rawFields)) {
    if (!rawValues?.length) continue;
    const enumField = schema.get(field);
    if (!enumField) {
      // Not an actor-enforced enum (free text field) — pass through as-is.
      result.actorInput[field] = rawValues;
      continue;
    }

    const matched: string[] = [];
    const unmatched: string[] = [];
    for (const raw of rawValues) {
      const canonical = enumField.lowerToCanonical.get(raw.trim().toLowerCase());
      if (canonical) matched.push(canonical);
      else unmatched.push(raw);
    }

    if (matched.length) result.actorInput[field] = matched;

    if (unmatched.length) {
      if (enumField.values.length <= STRICT_VALIDATION_MAX_SIZE) {
        result.rejectedByField[field] = {
          invalid: unmatched,
          validSample: enumField.values.slice(0, 15),
          totalValid: enumField.values.length,
        };
      } else {
        result.droppedByField[field] = unmatched;
      }
    }
  }

  return result;
}
