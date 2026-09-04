import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({
  prisma: { lead: { findMany: vi.fn().mockResolvedValue([]) } },
}));

import { interpretLeadsQuery, runLeadsQuery, summarizeLeadsResult, type LeadsQueryParams } from '../../routes/ai/index.js';
import { prisma } from '../../lib/prisma.js';

const mockFindMany = vi.mocked(prisma.lead.findMany);
const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  global.fetch = originalFetch;
});

function mockAnthropicToolResponse(input: Record<string, unknown>) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ content: [{ type: 'tool_use', name: 'query_leads', input }] }),
  }) as unknown as typeof fetch;
}

describe('interpretLeadsQuery', () => {
  it("extracts limit and default sort from a 'top 10 leads' style question", async () => {
    mockAnthropicToolResponse({ sort_by: 'createdAt', sort_dir: 'desc', limit: 10 });
    const params = await interpretLeadsQuery('who are my top 10 leads', 'fake-key');
    expect(params).toEqual({ status: undefined, search: undefined, tag: undefined, sort_by: 'createdAt', sort_dir: 'desc', limit: 10 });
  });

  it('falls back to safe defaults when the model returns an out-of-range status/sort_by', async () => {
    mockAnthropicToolResponse({ status: 'made_up_status', sort_by: 'not_a_real_field', sort_dir: 'desc', limit: 10 });
    const params = await interpretLeadsQuery('anything', 'fake-key');
    expect(params.status).toBeUndefined();
    expect(params.sort_by).toBe('createdAt');
  });

  it('clamps an out-of-range limit into [1, 50] instead of trusting the model verbatim', async () => {
    mockAnthropicToolResponse({ sort_by: 'createdAt', sort_dir: 'desc', limit: 9999 });
    const params = await interpretLeadsQuery('show me every lead', 'fake-key');
    expect(params.limit).toBe(50);
  });

  it('defaults limit to 10 when the tool call omits it entirely', async () => {
    mockAnthropicToolResponse({ sort_by: 'createdAt', sort_dir: 'desc' });
    const params = await interpretLeadsQuery('recent leads', 'fake-key');
    expect(params.limit).toBe(10);
  });

  it('throws when the Anthropic call itself fails, rather than silently returning defaults', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch;
    await expect(interpretLeadsQuery('anything', 'fake-key')).rejects.toThrow(/500/);
  });
});

describe('runLeadsQuery', () => {
  it('scopes every query to the caller\'s apiKeyId', async () => {
    await runLeadsQuery('key-1', { sort_by: 'createdAt', sort_dir: 'desc', limit: 10 });
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ apiKeyId: 'key-1' }) }),
    );
  });

  it('builds a case-insensitive OR search across email/name/company/title when search is set', async () => {
    await runLeadsQuery('key-1', { search: 'acme', sort_by: 'createdAt', sort_dir: 'desc', limit: 10 });
    const call = mockFindMany.mock.calls[0]![0] as { where: { OR?: unknown[] } };
    expect(call.where.OR).toHaveLength(5);
  });

  it('does not add a status filter when none was requested', async () => {
    await runLeadsQuery('key-1', { sort_by: 'createdAt', sort_dir: 'desc', limit: 10 });
    const call = mockFindMany.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(call.where).not.toHaveProperty('status');
  });
});

describe('summarizeLeadsResult', () => {
  const base: LeadsQueryParams = { sort_by: 'createdAt', sort_dir: 'desc', limit: 10 };

  it('reports zero results with the filters that were applied', () => {
    expect(summarizeLeadsResult({ ...base, status: 'interested' }, 0)).toBe('No leads found with status "interested".');
  });

  it('reports a plain count with no filters applied', () => {
    expect(summarizeLeadsResult(base, 0)).toBe('No leads found.');
  });

  it('pluralizes correctly for exactly one result', () => {
    expect(summarizeLeadsResult(base, 1)).toMatch(/^Found 1 lead\b/);
    expect(summarizeLeadsResult(base, 2)).toMatch(/^Found 2 leads\b/);
  });

  it('mentions every active filter in the summary', () => {
    const text = summarizeLeadsResult({ ...base, status: 'interested', search: 'acme', tag: 'vip' }, 3);
    expect(text).toContain('status "interested"');
    expect(text).toContain('matching "acme"');
    expect(text).toContain('tagged "vip"');
  });
});
