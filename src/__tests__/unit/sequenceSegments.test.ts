import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    sequenceEnrollment: { findMany: vi.fn() },
    lead: { findMany: vi.fn() },
  },
}));

import { deriveSequenceSegments } from '../../lib/sequenceSegments.js';
import { prisma } from '../../lib/prisma.js';

const mockEnrollmentFindMany = vi.mocked(prisma.sequenceEnrollment.findMany);
const mockLeadFindMany = vi.mocked(prisma.lead.findMany);

function lead(email: string, title: string | null, industry: string | null, employees: number | null = null) {
  return { email, firstName: 'Test', title, company: 'Acme', account: industry ? { industry, employees } : null };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('deriveSequenceSegments', () => {
  it('returns zero segments when the sequence has no enrollments and no fallback lead_ids', async () => {
    mockEnrollmentFindMany.mockResolvedValue([] as never);
    const result = await deriveSequenceSegments('key-1', 'seq-1');
    expect(result.totalContacts).toBe(0);
    expect(mockLeadFindMany).not.toHaveBeenCalled();
  });

  it('segments real enrolled leads by industry via the Account relation directly', async () => {
    mockEnrollmentFindMany.mockResolvedValue([
      { leadId: 'l1' }, { leadId: 'l2' }, { leadId: 'l3' }, { leadId: 'l4' },
    ] as never);
    mockLeadFindMany.mockResolvedValue([
      lead('a@x.com', 'CISO', 'Computer & Network Security'),
      lead('b@x.com', 'Security Engineer', 'Computer & Network Security'),
      lead('c@x.com', 'VP Marketing', 'Marketing & Advertising'),
      lead('d@x.com', 'Growth Lead', 'Marketing & Advertising'),
    ] as never);

    const result = await deriveSequenceSegments('key-1', 'seq-1');
    expect(result.totalContacts).toBe(4);
    const labels = result.segments.map((s) => s.label);
    expect(labels).toContain('Computer & Network Security');
    expect(labels).toContain('Marketing & Advertising');
    // Confirms the Prisma query actually scoped to this sequence's enrollments.
    expect(mockLeadFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: ['l1', 'l2', 'l3', 'l4'] } }) }),
    );
  });

  it('falls back to the given lead_ids when the sequence has no enrollments yet (brand-new sequence)', async () => {
    mockEnrollmentFindMany.mockResolvedValue([] as never);
    mockLeadFindMany.mockResolvedValue([
      lead('a@x.com', 'CISO', 'Computer & Network Security'),
    ] as never);

    const result = await deriveSequenceSegments('key-1', 'seq-1', ['lead-a']);
    expect(result.totalContacts).toBe(1);
    expect(mockLeadFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: ['lead-a'] } }) }),
    );
  });

  it('ignores enrollments with no linked leadId', async () => {
    mockEnrollmentFindMany.mockResolvedValue([{ leadId: null }, { leadId: null }] as never);
    const result = await deriveSequenceSegments('key-1', 'seq-1');
    expect(result.totalContacts).toBe(0);
  });

  it('deduplicates repeated leadIds across enrollments', async () => {
    mockEnrollmentFindMany.mockResolvedValue([{ leadId: 'l1' }, { leadId: 'l1' }] as never);
    mockLeadFindMany.mockResolvedValue([lead('a@x.com', 'CISO', 'Computer & Network Security')] as never);

    await deriveSequenceSegments('key-1', 'seq-1');
    expect(mockLeadFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: ['l1'] } }) }),
    );
  });
});
