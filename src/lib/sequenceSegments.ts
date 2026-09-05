/**
 * Derives real segments for a sequence's actual audience, mirroring
 * campaignSegments.ts's approach but reading directly from Lead/Account —
 * sequences enroll individual Leads (SequenceEnrollment.leadId), which
 * already carry title/company, and Account carries industry/employees
 * natively. No customFields heuristics needed here; this is the richer,
 * cleaner signal source campaignSegments.ts falls back to only when it
 * happens to find a matching Lead by email.
 */
import { prisma } from './prisma.js';
import { clusterSignals, type ContactSignal, type CampaignSegment } from './campaignSegments.js';

/**
 * Segments a sequence's current enrollments. Falls back to segmenting a
 * given set of lead IDs (e.g. leads about to be enrolled, picked in the
 * UI before the sequence has any enrollments yet) when the sequence has
 * none yet — a brand-new sequence shouldn't be stuck with "not enough
 * signal" just because nobody's been enrolled in it yet.
 */
export async function deriveSequenceSegments(
  apiKeyId: string,
  sequenceId: string,
  fallbackLeadIds: string[] = [],
  maxSegments = 3,
): Promise<{ totalContacts: number; segments: CampaignSegment[] }> {
  const enrollments = await prisma.sequenceEnrollment.findMany({
    where: { sequenceId, leadId: { not: null } },
    select: { leadId: true },
  });
  let leadIds = [...new Set(enrollments.map((e) => e.leadId).filter((id): id is string => !!id))];

  if (leadIds.length === 0 && fallbackLeadIds.length > 0) {
    leadIds = [...new Set(fallbackLeadIds)];
  }

  if (leadIds.length === 0) return { totalContacts: 0, segments: [] };

  const leads = await prisma.lead.findMany({
    where: { apiKeyId, id: { in: leadIds } },
    select: { email: true, firstName: true, title: true, company: true, account: { select: { industry: true, employees: true } } },
  });

  const totalContacts = leads.length;
  if (totalContacts === 0) return { totalContacts: 0, segments: [] };

  const signals: ContactSignal[] = leads.map((l) => ({
    email: l.email,
    firstName: l.firstName,
    title: l.title,
    company: l.company,
    industry: l.account?.industry ?? null,
    employees: l.account?.employees ?? null,
  }));

  return { totalContacts, segments: clusterSignals(signals, totalContacts, maxSegments) };
}
