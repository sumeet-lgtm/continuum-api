import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The module caches the fetched actor schema at module scope (deliberately —
// it's a slow-changing enum list, not worth re-fetching every request), so
// each test needs a fresh module instance to control what "the actor
// returned" looks like without bleeding into other tests.
vi.mock('../../config.js', () => ({
  config: { APIFY_API_TOKEN: 'test-token', APIFY_ACTOR_ID: 'test-actor' },
}));

const ACTOR_META_RESPONSE = {
  data: { taggedBuilds: { latest: { buildId: 'build-1' } } },
};

function buildInputSchema(properties: Record<string, unknown>) {
  return { data: { inputSchema: JSON.stringify({ properties }) } };
}

const originalFetch = global.fetch;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('normalizeFinderFilters', () => {
  it('case-insensitively normalizes a value to the actor\'s canonical casing', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ACTOR_META_RESPONSE })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => buildInputSchema({
          companyIndustryIncludes: { items: { enum: ['Computer Software', 'Financial Services'] } },
        }),
      }) as unknown as typeof fetch;

    const { normalizeFinderFilters } = await import('../../lib/apifyActorSchema.js');
    const result = await normalizeFinderFilters({ companyIndustryIncludes: ['computer software'] });

    expect(result.actorInput.companyIndustryIncludes).toEqual(['Computer Software']);
    expect(result.rejectedByField).toEqual({});
    expect(result.droppedByField).toEqual({});
  });

  it('rejects a genuinely invalid value for a small enum with a helpful message instead of forwarding it to Apify', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ACTOR_META_RESPONSE })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => buildInputSchema({
          companyIndustryIncludes: { items: { enum: ['Computer Software', 'Financial Services'] } },
        }),
      }) as unknown as typeof fetch;

    const { normalizeFinderFilters } = await import('../../lib/apifyActorSchema.js');
    const result = await normalizeFinderFilters({ companyIndustryIncludes: ['SaaS'] });

    expect(result.actorInput.companyIndustryIncludes).toBeUndefined();
    expect(result.rejectedByField.companyIndustryIncludes.invalid).toEqual(['SaaS']);
    expect(result.rejectedByField.companyIndustryIncludes.validSample).toContain('Computer Software');
  });

  it('silently drops (rather than rejects) an unmatched value for a huge enum like technologies', async () => {
    const hugeEnum = Array.from({ length: 200 }, (_, i) => `Tech${i}`);
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ACTOR_META_RESPONSE })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => buildInputSchema({
          technologiesIncludes: { items: { enum: hugeEnum } },
        }),
      }) as unknown as typeof fetch;

    const { normalizeFinderFilters } = await import('../../lib/apifyActorSchema.js');
    const result = await normalizeFinderFilters({ technologiesIncludes: ['NotARealTechnology'] });

    expect(result.actorInput.technologiesIncludes).toBeUndefined();
    expect(result.rejectedByField).toEqual({});
    expect(result.droppedByField.technologiesIncludes).toEqual(['NotARealTechnology']);
  });

  it('passes through a field with no actor-side enum (free text) unchanged', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ACTOR_META_RESPONSE })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => buildInputSchema({
          companyIndustryIncludes: { items: { enum: ['Computer Software'] } },
        }),
      }) as unknown as typeof fetch;

    const { normalizeFinderFilters } = await import('../../lib/apifyActorSchema.js');
    const result = await normalizeFinderFilters({ companyNameIncludes: ['Anything Goes Inc'] });

    expect(result.actorInput.companyNameIncludes).toEqual(['Anything Goes Inc']);
    expect(result.rejectedByField).toEqual({});
  });

  it('falls back to passing values through unvalidated when the schema fetch itself fails', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;

    const { normalizeFinderFilters } = await import('../../lib/apifyActorSchema.js');
    const result = await normalizeFinderFilters({ companyIndustryIncludes: ['anything'] });

    // No enum schema available at all — nothing to validate against, so the
    // raw value passes through rather than blocking every search whenever
    // our own schema-fetch has a hiccup.
    expect(result.actorInput.companyIndustryIncludes).toEqual(['anything']);
    expect(result.rejectedByField).toEqual({});
  });
});
