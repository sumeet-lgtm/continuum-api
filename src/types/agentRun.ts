// Shared shapes for AgentRun.config — pillar-specific input stored as JSON.
// Verification, Nurture, and Lead Finding are implemented; the other
// AgentPillar values are reserved for later pillars built on the same
// AgentRun/AgentRunEvent primitive (see prisma/schema.prisma).

import type { FinderSearchFilters } from '../lib/finderSearch.js';

export interface VerificationAgentConfig {
  listId: string;
  // Default off — the agent flags invalid contacts by default and only
  // moves them out of the active list (ContactListMembership.status =
  // 'quarantined', never a hard delete) when the owner opts in.
  autoRemoveInvalid?: boolean;
  // How long a contact's last verification stays "fresh" before the watch
  // re-checks it. Defaults to 30 days.
  cutoffDays?: number;
}

export const DEFAULT_VERIFICATION_CUTOFF_DAYS = 30;

export function parseVerificationAgentConfig(config: unknown): VerificationAgentConfig | null {
  if (!config || typeof config !== 'object') return null;
  const c = config as Record<string, unknown>;
  if (typeof c['listId'] !== 'string' || c['listId'].length === 0) return null;
  const result: VerificationAgentConfig = { listId: c['listId'] };
  if (typeof c['autoRemoveInvalid'] === 'boolean') result.autoRemoveInvalid = c['autoRemoveInvalid'];
  if (typeof c['cutoffDays'] === 'number' && c['cutoffDays'] > 0) result.cutoffDays = c['cutoffDays'];
  return result;
}

// ─── Nurture & Newsletters ──────────────────────────────────────────────────
// One-shot pipeline (not a recurring watch): draft → (approve) → send,
// reusing the existing AI copy-generation flow (emailGenerator.ts,
// campaignSegments.ts) and, for the actual send, the already-hardened
// Campaign/campaignWorker.ts machinery unchanged — this pillar only decides
// WHAT to send and to WHOM; every guardrail on HOW it sends (circuit
// breaker, quota, bounce auto-pause) already exists and is untouched.

export interface NurtureAgentConfig {
  listId: string;
  about: string; // topic/brief in the customer's own words, fed to generateSegmentEmail
  fromName: string;
  fromEmail: string;
  sender?: { name?: string; company?: string; product?: string };
  tone?: 'professional' | 'casual' | 'direct' | 'technical';
  replyTo?: string;
  // Off by default — the agent drafts and waits at status='pending_approval'
  // for a human to approve (POST /v1/agent-runs/:id/approve) before any
  // real send happens. Only set true for a customer who explicitly wants
  // the agent to send unattended.
  autoSend?: boolean;

  // Populated by the worker once drafted — the approve step creates the
  // Campaign from exactly this, without re-generating (re-running the LLM
  // on approve could silently draft different copy than what was reviewed).
  draft?: {
    subject: string;
    htmlBody: string;
    textBody: string;
    segmentLabel: string;
    matchCount: number;
  };
  campaignId?: string; // set once the real Campaign is created
}

// ─── Lead Finding ────────────────────────────────────────────────────────────
// Recurring watch (like Verification, not one-shot like Nurture): each tick
// re-runs a saved Finder search (lib/finderSearch.ts — the same Apify/
// Pipeline Labs flow behind the manual POST /v1/finder/search), verifies new
// results through the existing engine, and imports only the ones never seen
// before (deduped against existing Lead rows) — surfacing net-new matches
// instead of re-showing the same people every cycle.
//
// A search run is async on Apify's side (searches take a minute or more), so
// a tick can't just block waiting for it. Instead: tick N starts the search
// and stores `pendingRunId`; the worker re-enqueues itself with a short
// delay to poll; once Apify reports done, that tick does the dedup/verify/
// import/enroll work, clears `pendingRunId`, and reschedules the normal
// recurring interval. AgentRun.status stays 'active' throughout — only
// `config.pendingRunId`'s presence marks "a search is in flight."

export interface LeadFindingAgentConfig {
  searchFilters: FinderSearchFilters;
  // Optional: auto-enroll newly-found, verified leads into this sequence —
  // the same auto-enroll option POST /v1/finder/jobs/:runId/import already
  // exposes for a manual import, just applied automatically here.
  sequenceId?: string;
  // Worker-managed — not set by the caller at creation.
  pendingRunId?: string;
}

export function parseLeadFindingAgentConfig(config: unknown): LeadFindingAgentConfig | null {
  if (!config || typeof config !== 'object') return null;
  const c = config as Record<string, unknown>;
  if (!c['searchFilters'] || typeof c['searchFilters'] !== 'object') return null;

  const result: LeadFindingAgentConfig = { searchFilters: c['searchFilters'] as FinderSearchFilters };
  if (typeof c['sequenceId'] === 'string' && c['sequenceId'].length > 0) result.sequenceId = c['sequenceId'];
  if (typeof c['pendingRunId'] === 'string' && c['pendingRunId'].length > 0) result.pendingRunId = c['pendingRunId'];
  return result;
}

export function parseNurtureAgentConfig(config: unknown): NurtureAgentConfig | null {
  if (!config || typeof config !== 'object') return null;
  const c = config as Record<string, unknown>;
  if (typeof c['listId'] !== 'string' || c['listId'].length === 0) return null;
  if (typeof c['about'] !== 'string' || c['about'].trim().length === 0) return null;
  if (typeof c['fromName'] !== 'string' || c['fromName'].trim().length === 0) return null;
  if (typeof c['fromEmail'] !== 'string' || c['fromEmail'].trim().length === 0) return null;

  const result: NurtureAgentConfig = {
    listId: c['listId'],
    about: c['about'],
    fromName: c['fromName'],
    fromEmail: c['fromEmail'],
  };
  if (c['sender'] && typeof c['sender'] === 'object') result.sender = c['sender'] as Exclude<NurtureAgentConfig['sender'], undefined>;
  if (typeof c['tone'] === 'string') result.tone = c['tone'] as Exclude<NurtureAgentConfig['tone'], undefined>;
  if (typeof c['replyTo'] === 'string') result.replyTo = c['replyTo'];
  if (typeof c['autoSend'] === 'boolean') result.autoSend = c['autoSend'];
  if (c['draft'] && typeof c['draft'] === 'object') result.draft = c['draft'] as Exclude<NurtureAgentConfig['draft'], undefined>;
  if (typeof c['campaignId'] === 'string') result.campaignId = c['campaignId'];
  return result;
}
