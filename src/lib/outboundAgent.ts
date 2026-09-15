/**
 * Shared by routes/agentRuns/index.ts's POST /:id/approve — creates the
 * real Sequence + SequenceSteps from a drafted-and-reviewed
 * OutboundAgentConfig and enrolls the specified leads, then hands off to
 * the existing, unmodified workers/sequenceWorker.ts send pipeline. This is
 * the only place the Outbound Agent pillar touches real sending, and it
 * never sends anything directly — every guardrail sequenceWorker.ts already
 * enforces (suppression checks, send-window, stop-on-reply/open/click,
 * cross-sequence exclusivity) applies here exactly as it does to a sequence
 * a human built by hand.
 */
import { prisma } from './prisma.js';
import { withTenant } from './tenantContext.js';
import type { OutboundAgentConfig } from '../types/agentRun.js';

export interface OutboundEnrollResult {
  sequenceId: string;
  enrolled: number;
  skipped: number;
  conflicts: number;
}

export async function createSequenceAndEnrollFromDraft(
  apiKeyId: string,
  cfg: OutboundAgentConfig,
): Promise<OutboundEnrollResult> {
  if (!cfg.draft) throw new Error('No draft to send — the agent has not generated one yet.');

  return withTenant(apiKeyId, async (tx) => {
    const leads = await tx.lead.findMany({
      where: { apiKeyId, id: { in: cfg.leadIds } },
      select: { id: true, email: true },
    });

    const sequence = await tx.sequence.create({
      data: {
        apiKeyId,
        name: cfg.draft!.sequenceName,
        mailboxId: cfg.mailboxId ?? null,
        fromName: cfg.fromName,
        fromEmail: cfg.fromEmail,
        trackOpens: true,
        trackClicks: true,
        stopOnReply: true,
        stopOnOpen: false,
        stopOnClick: false,
        sendDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
        sendStartHour: 8,
        sendEndHour: 17,
        timezone: 'UTC',
      },
      select: { id: true },
    });

    for (let i = 0; i < cfg.draft!.steps.length; i++) {
      const step = cfg.draft!.steps[i]!;
      await tx.sequenceStep.create({
        data: {
          sequenceId: sequence.id,
          stepOrder: i,
          delayDays: step.delayDays,
          type: 'email',
          subject: step.subject,
          htmlBody: step.htmlBody,
          textBody: step.textBody,
        },
      });
    }

    let enrolled = 0;
    let skipped = 0;
    let conflicts = 0;

    for (const lead of leads) {
      const existing = await tx.sequenceEnrollment.findUnique({ where: { sequenceId_email: { sequenceId: sequence.id, email: lead.email } } });
      if (existing) { skipped++; continue; }

      // Cross-sequence exclusivity, same rule POST /sequences/:id/contacts
      // applies by default (force_move not offered here — an agent-driven
      // enrollment should never silently bump a lead out of a sequence a
      // human already put them in).
      const conflict = await tx.sequenceEnrollment.findFirst({
        where: { email: lead.email, status: 'active', sequence: { apiKeyId } },
        select: { id: true },
      });
      if (conflict) { conflicts++; continue; }

      await tx.sequenceEnrollment.create({
        data: { sequenceId: sequence.id, email: lead.email, leadId: lead.id, status: 'active', currentStep: 0, nextSendAt: new Date() },
      });
      enrolled++;
    }

    return { sequenceId: sequence.id, enrolled, skipped, conflicts };
  });
}

export async function markAgentRunOutboundComplete(agentRunId: string, config: OutboundAgentConfig, sequenceId: string): Promise<void> {
  await prisma.agentRun.update({
    where: { id: agentRunId },
    data: {
      status: 'completed',
      completedAt: new Date(),
      config: { ...config, sequenceId } as object,
    },
  });
}
