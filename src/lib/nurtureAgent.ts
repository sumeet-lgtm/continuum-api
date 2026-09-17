/**
 * Shared by workers/agentRunWorker.ts (autoSend path) and
 * routes/agentRuns/index.ts (POST /:id/approve) — creates the real Campaign
 * from a drafted-and-reviewed NurtureAgentConfig and hands it to the
 * existing campaignWorker.ts send pipeline unchanged. This is the only
 * place the Nurture Agent pillar touches real sending; every guardrail
 * campaignWorker.ts already enforces (recipient-isolation circuit breaker,
 * suppression checks, monthly send quota, bounce auto-pause) applies here
 * exactly as it does to a campaign a human created by hand.
 */
import { withTenant } from './tenantContext.js';
import { campaignQueue } from './queue.js';
import type { NurtureAgentConfig } from '../types/agentRun.js';

export async function createAndSendCampaignFromDraft(
  apiKeyId: string,
  cfg: NurtureAgentConfig,
): Promise<string> {
  if (!cfg.draft) throw new Error('No draft to send — the agent has not generated one yet.');

  const campaignId = await withTenant(apiKeyId, async (tx) => {
    const campaign = await tx.campaign.create({
      data: {
        apiKeyId,
        name: cfg.draft!.subject.slice(0, 200),
        fromName: cfg.fromName,
        fromEmail: cfg.fromEmail,
        replyTo: cfg.replyTo ?? null,
        subject: cfg.draft!.subject,
        htmlBody: cfg.draft!.htmlBody,
        textBody: cfg.draft!.textBody,
        listIds: [cfg.listId],
        status: 'sending',
      },
      select: { id: true },
    });
    return campaign.id;
  });

  await campaignQueue.add('send-campaign', { campaignId, apiKeyId }, { jobId: `campaign-${campaignId}` });
  return campaignId;
}

export async function markAgentRunSent(apiKeyId: string, agentRunId: string, config: NurtureAgentConfig, campaignId: string): Promise<void> {
  await withTenant(apiKeyId, (tx) => tx.agentRun.update({
    where: { id: agentRunId },
    data: {
      status: 'completed',
      completedAt: new Date(),
      config: { ...config, campaignId } as object,
    },
  }));
}
