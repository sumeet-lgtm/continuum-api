import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    contactListMembership: { findMany: vi.fn() },
    lead: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

import { deriveListSegments } from '../../lib/campaignSegments.js';
import { prisma } from '../../lib/prisma.js';

const mockMemberships = vi.mocked(prisma.contactListMembership.findMany);
const mockLeadFindMany = vi.mocked(prisma.lead.findMany);

function contact(email: string, customFields: Record<string, unknown> | null = null, firstName = 'Test') {
  return { contact: { email, firstName, customFields } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLeadFindMany.mockResolvedValue([]);
});

describe('deriveListSegments', () => {
  it('returns zero segments for an empty list', async () => {
    mockMemberships.mockResolvedValue([] as never);
    const result = await deriveListSegments('key-1', ['list-1']);
    expect(result.totalContacts).toBe(0);
    expect(result.segments).toEqual([]);
  });

  it('segments by industry when enough of the list carries it', async () => {
    mockMemberships.mockResolvedValue([
      contact('a@x.com', { industry: 'Computer Software' }),
      contact('b@x.com', { industry: 'Computer Software' }),
      contact('c@x.com', { industry: 'Financial Services' }),
      contact('d@x.com', { industry: 'Financial Services' }),
    ] as never);

    const result = await deriveListSegments('key-1', ['list-1']);
    expect(result.totalContacts).toBe(4);
    expect(result.segments.length).toBeGreaterThanOrEqual(2);
    const labels = result.segments.map((s) => s.label);
    expect(labels).toContain('Computer Software');
    expect(labels).toContain('Financial Services');
    for (const seg of result.segments) {
      expect(seg.signalSummary).toContain(seg.label);
      expect(seg.signalSummary).toMatch(/\d+% of this list/);
    }
  });

  it('normalizes differently-cased CSV column names to the same signal', async () => {
    mockMemberships.mockResolvedValue([
      contact('a@x.com', { Industry: 'Computer Software' }),
      contact('b@x.com', { 'company_industry': 'Computer Software' }),
      contact('c@x.com', { industry: 'Financial Services' }),
    ] as never);

    const result = await deriveListSegments('key-1', ['list-1']);
    const softwareSeg = result.segments.find((s) => s.label === 'Computer Software');
    expect(softwareSeg?.matchCount).toBe(2);
  });

  it('falls back to seniority-based segmentation when industry data is too sparse', async () => {
    mockMemberships.mockResolvedValue([
      contact('a@x.com', { title: 'VP of Sales' }),
      contact('b@x.com', { title: 'VP of Marketing' }),
      contact('c@x.com', { title: 'Account Manager' }),
      contact('d@x.com', { title: 'Sales Manager' }),
    ] as never);

    const result = await deriveListSegments('key-1', ['list-1']);
    const labels = result.segments.map((s) => s.label);
    expect(labels).toContain('VP / Head of');
    expect(labels).toContain('Manager');
  });

  it('falls back to a single honest whole-list segment when no structured signal exists', async () => {
    mockMemberships.mockResolvedValue([
      contact('a@x.com', null),
      contact('b@x.com', {}),
      contact('c@x.com', { random_field: 'nonsense' }),
    ] as never);

    const result = await deriveListSegments('key-1', ['list-1']);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].label).toBe('Full list');
    expect(result.segments[0].signalSummary).toMatch(/no structured/i);
  });

  it('enriches from the Lead/Account table by email when a match exists, preferring it over customFields', async () => {
    mockMemberships.mockResolvedValue([
      contact('a@x.com', { industry: 'Should Be Overridden' }),
      contact('b@x.com', { industry: 'Should Be Overridden' }),
      contact('c@x.com', { industry: 'Should Be Overridden' }),
      contact('d@x.com', { industry: 'Should Be Overridden' }),
    ] as never);
    mockLeadFindMany.mockResolvedValue([
      { email: 'a@x.com', title: 'CISO', company: 'Acme', account: { industry: 'Computer & Network Security', employees: 500 } },
      { email: 'b@x.com', title: 'Security Engineer', company: 'Acme', account: { industry: 'Computer & Network Security', employees: 500 } },
      { email: 'c@x.com', title: 'Loan Officer', company: 'Fin Co', account: { industry: 'Banking', employees: 200 } },
      { email: 'd@x.com', title: 'Underwriter', company: 'Fin Co', account: { industry: 'Banking', employees: 200 } },
    ] as never);

    const result = await deriveListSegments('key-1', ['list-1']);
    const labels = result.segments.map((s) => s.label);
    expect(labels).toContain('Computer & Network Security');
    expect(labels).toContain('Banking');
    expect(labels).not.toContain('Should Be Overridden');
  });

  it('caps the number of segments returned at max_segments', async () => {
    mockMemberships.mockResolvedValue([
      contact('a@x.com', { industry: 'A' }),
      contact('b@x.com', { industry: 'B' }),
      contact('c@x.com', { industry: 'C' }),
      contact('d@x.com', { industry: 'D' }),
      contact('e@x.com', { industry: 'E' }),
    ] as never);

    const result = await deriveListSegments('key-1', ['list-1'], 2);
    expect(result.segments.length).toBeLessThanOrEqual(2);
  });
});
