/**
 * Derives real, checkable segments from a campaign's actual target list,
 * instead of asking the customer to describe their audience in the abstract.
 *
 * Campaign contacts (MailingList/Contact) only carry email/name plus a
 * freeform customFields JSON blob — whatever came in on the CSV import. The
 * separate Lead/Account tables (used by Finder/sequences) carry much richer
 * structured signal (title, company, industry, employee count) when the
 * same email exists there too, e.g. because it was originally sourced via
 * Finder. This pulls from both and merges by email, so a campaign gets the
 * best signal actually available for its real list rather than only ever
 * seeing a bare email address.
 */
import { prisma } from './prisma.js';

export interface ContactSignal {
  email: string;
  firstName: string | null;
  title: string | null;
  company: string | null;
  industry: string | null;
  employees: number | null;
}

export interface CampaignSegment {
  label: string;
  matchCount: number;
  matchPct: number;
  /** The concrete, checkable summary handed to the model as grounding — not a vibe, a fact about this specific slice of the real list. */
  signalSummary: string;
  sampleTitles: string[];
  contacts: ContactSignal[];
}

// Common CSV header variants customers actually use for these fields —
// normalized so "Job Title", "job_title", "Title", "Position" all resolve
// to the same signal instead of silently missing real data because of
// column-naming differences.
const TITLE_KEYS = ['title', 'job_title', 'jobtitle', 'position', 'role'];
const COMPANY_KEYS = ['company', 'company_name', 'companyname', 'organization', 'org'];
const INDUSTRY_KEYS = ['industry', 'company_industry', 'sector'];
const EMPLOYEES_KEYS = ['employees', 'company_size', 'headcount', 'employee_count'];

function pickField(obj: Record<string, unknown> | null | undefined, keys: string[]): string | null {
  if (!obj) return null;
  for (const key of keys) {
    for (const actualKey of Object.keys(obj)) {
      if (actualKey.toLowerCase().replace(/[\s-]/g, '_') === key) {
        const val = obj[actualKey];
        if (typeof val === 'string' && val.trim()) return val.trim();
        if (typeof val === 'number') return String(val);
      }
    }
  }
  return null;
}

const SENIORITY_KEYWORDS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'C-Suite / Founder', pattern: /\b(ceo|cto|cfo|coo|ciso|cmo|chief|founder|owner)\b/i },
  { label: 'VP / Head of', pattern: /\b(vp|vice president|head of)\b/i },
  { label: 'Director', pattern: /\bdirector\b/i },
  { label: 'Manager', pattern: /\bmanager\b/i },
  { label: 'Senior IC', pattern: /\bsenior|sr\.?\b/i },
];

/**
 * Fetches every contact in the given lists/segments for this API key,
 * enriches each with any matching Lead/Account data by email, and clusters
 * them into up to `maxSegments` real segments with a concrete signalSummary
 * per segment — the grounding fact the generator is required to use instead
 * of writing generically for "the list."
 */
export async function deriveListSegments(
  apiKeyId: string,
  listIds: string[],
  maxSegments = 3,
): Promise<{ totalContacts: number; segments: CampaignSegment[] }> {
  const memberships = await prisma.contactListMembership.findMany({
    where: { listId: { in: listIds }, status: 'subscribed' },
    include: { contact: { select: { email: true, firstName: true, customFields: true } } },
  });

  const seen = new Set<string>();
  const rawContacts = memberships
    .map((m) => m.contact)
    .filter((c) => {
      if (seen.has(c.email)) return false;
      seen.add(c.email);
      return true;
    });

  const totalContacts = rawContacts.length;
  if (totalContacts === 0) return { totalContacts: 0, segments: [] };

  // Enrich by email against Lead/Account where available — this is what
  // turns "we have an email list" into "we know 40% of these are security
  // engineering titles at 200-1000 person companies," which is the entire
  // point: segmentation grounded in the real list, not a guess.
  const emails = rawContacts.map((c) => c.email);
  const leads = await prisma.lead.findMany({
    where: { apiKeyId, email: { in: emails } },
    select: { email: true, title: true, company: true, account: { select: { industry: true, employees: true } } },
  });
  const leadByEmail = new Map(leads.map((l) => [l.email.toLowerCase(), l]));

  const signals: ContactSignal[] = rawContacts.map((c) => {
    const cf = c.customFields as Record<string, unknown> | null;
    const lead = leadByEmail.get(c.email.toLowerCase());
    return {
      email: c.email,
      firstName: c.firstName,
      title: lead?.title ?? pickField(cf, TITLE_KEYS),
      company: lead?.company ?? pickField(cf, COMPANY_KEYS),
      industry: lead?.account?.industry ?? pickField(cf, INDUSTRY_KEYS),
      employees: lead?.account?.employees ?? (() => {
        const raw = pickField(cf, EMPLOYEES_KEYS);
        const n = raw ? parseInt(raw, 10) : NaN;
        return Number.isFinite(n) ? n : null;
      })(),
    };
  });

  return { totalContacts, segments: clusterSignals(signals, totalContacts, maxSegments) };
}

/**
 * Pure clustering step, shared by every real-signal source (campaign
 * lists via customFields+Lead enrichment here, sequence enrollments via
 * Lead/Account directly in sequenceSegments.ts) — the segmentation logic
 * itself doesn't care where the signal came from, only whether there's
 * enough of it to build a real segment claim on.
 */
export function clusterSignals(signals: ContactSignal[], totalContacts: number, maxSegments: number): CampaignSegment[] {
  if (totalContacts === 0) return [];

  // 1. Industry-based segmentation if enough of the list has it (>= 30%
  //    coverage and at least 2 distinct real values — otherwise industry
  //    data is too sparse to build a real segment claim on).
  const withIndustry = signals.filter((s) => s.industry);
  const industryGroups = new Map<string, ContactSignal[]>();
  for (const s of withIndustry) {
    const key = s.industry!;
    if (!industryGroups.has(key)) industryGroups.set(key, []);
    industryGroups.get(key)!.push(s);
  }

  if (withIndustry.length / totalContacts >= 0.3 && industryGroups.size >= 2) {
    const sorted = [...industryGroups.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, maxSegments);
    return sorted.map(([industry, group]) => buildSegment(industry, group, totalContacts));
  }

  // 2. Seniority-based segmentation from titles, if titles are present
  //    widely enough.
  const withTitle = signals.filter((s) => s.title);
  if (withTitle.length / totalContacts >= 0.3) {
    const senGroups = new Map<string, ContactSignal[]>();
    for (const s of withTitle) {
      const match = SENIORITY_KEYWORDS.find((k) => k.pattern.test(s.title!));
      const key = match?.label ?? 'Individual Contributor';
      if (!senGroups.has(key)) senGroups.set(key, []);
      senGroups.get(key)!.push(s);
    }
    const sorted = [...senGroups.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, maxSegments);
    if (sorted.length >= 2) {
      return sorted.map(([label, group]) => buildSegment(label, group, totalContacts));
    }
  }

  // 3. Fallback — not enough structured signal to split meaningfully.
  // One segment, but the summary is honest about what's actually known
  // rather than inventing a fake breakdown.
  return [buildSegment('Full list', signals, totalContacts, /* wholeList */ true)];
}

function buildSegment(label: string, group: ContactSignal[], totalContacts: number, wholeList = false): CampaignSegment {
  const matchCount = group.length;
  const matchPct = Math.round((matchCount / totalContacts) * 100);

  const sampleTitles = [...new Set(group.map((g) => g.title).filter((t): t is string => !!t))].slice(0, 5);
  const companySizes = group.map((g) => g.employees).filter((e): e is number => e !== null);
  const avgSize = companySizes.length ? Math.round(companySizes.reduce((a, b) => a + b, 0) / companySizes.length) : null;

  let signalSummary: string;
  if (wholeList) {
    const titleCoverage = group.filter((g) => g.title).length;
    signalSummary = titleCoverage > 0
      ? `${matchCount} contacts. Titles on file for ${titleCoverage} of them (${sampleTitles.slice(0, 3).join(', ') || 'no consistent pattern'}), but not enough consistent industry/seniority data across the list to split into real segments — treat as one list and lean on whatever title/company data is present per-contact rather than a segment-wide claim.`
      : `${matchCount} contacts. No structured title/industry/company-size data available for this list — segmentation isn't possible from real signal here, so personalization should rely on company name and any available custom fields per-contact rather than a fabricated segment description.`;
  } else {
    const parts = [`${matchPct}% of this list (${matchCount} of ${totalContacts} contacts)`];
    if (sampleTitles.length) parts.push(`common titles: ${sampleTitles.join(', ')}`);
    if (avgSize) parts.push(`average company size ~${avgSize} employees`);
    signalSummary = `Segment "${label}" — ${parts.join('; ')}.`;
  }

  return { label, matchCount, matchPct, signalSummary, sampleTitles, contacts: group };
}
