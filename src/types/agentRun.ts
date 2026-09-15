// Shared shapes for AgentRun.config — pillar-specific input stored as JSON.
// Only the Email Verification pillar is implemented; the other AgentPillar
// values are reserved for later pillars built on the same AgentRun/AgentRunEvent
// primitive (see prisma/schema.prisma).

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
