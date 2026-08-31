import { WorkOS } from '@workos-inc/node';
import type { Prisma } from '@prisma/client';
import { config } from '../config.js';
import { logger } from './logger.js';
import { prisma } from './prisma.js';

let _workos: WorkOS | null = null;

function getWorkOS(): WorkOS {
  if (!_workos) {
    if (!config.WORKOS_API_KEY) return null as unknown as WorkOS;
    _workos = new WorkOS(config.WORKOS_API_KEY);
  }
  return _workos;
}

export interface AuditActor {
  id: string;
  email: string;
  ip?: string;
}

export interface AuditTarget {
  type: string;
  id: string;
  name?: string | undefined;
}

/**
 * Records an audited action. Previously no-op'd entirely whenever orgId
 * was null or WORKOS_API_KEY was unset — every customer not on the
 * org/SSO flow (the majority) got zero audit trail, and even org
 * customers had no record visible anywhere except WorkOS's own dashboard.
 *
 * Now: always writes a local AuditLog row first (this is the record of
 * record, queryable via GET /v1/audit-logs). When orgId and WORKOS_API_KEY
 * are both present, it additionally mirrors the event to WorkOS's Audit
 * Logs product — additive, not a replacement, and failure there never
 * blocks or fails the local write.
 *
 * apiKeyId is optional and separate from orgId: some audited actions (key
 * creation/revocation, account export/deletion) are scoped to a specific
 * API key rather than an org membership.
 */
export async function logAudit(
  orgId: string | null | undefined,
  action: string,
  actor: AuditActor,
  targets: AuditTarget[],
  apiKeyId?: string,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        orgId: orgId ?? null,
        apiKeyId: apiKeyId ?? null,
        action,
        actorId: actor.id,
        actorEmail: actor.email,
        actorIp: actor.ip ?? null,
        targets: targets as unknown as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    logger.warn({ err, action, orgId, apiKeyId }, 'Local audit log write failed (non-fatal)');
  }

  if (!orgId || !config.WORKOS_API_KEY) return;
  try {
    const workos = getWorkOS();
    if (!workos) return;
    await workos.auditLogs.createEvent(orgId, {
      action,
      occurredAt: new Date(),
      actor: {
        type: 'user',
        id: actor.id,
        name: actor.email,
        ...(actor.ip ? { metadata: { ip: actor.ip } } : {}),
      },
      targets: targets.map((t) => ({
        type: t.type,
        id: t.id,
        ...(t.name ? { name: t.name } : {}),
      })),
      context: { location: actor.ip ?? 'unknown' },
    });
  } catch (err) {
    logger.warn({ err, action, orgId }, 'WorkOS audit log mirror failed (non-fatal)');
  }
}
