import { WorkOS } from '@workos-inc/node';
import { config } from '../config.js';
import { logger } from './logger.js';

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
  name?: string;
}

/**
 * Fire-and-forget audit event. No-ops silently if orgId is null (individual user).
 */
export async function logAudit(
  orgId: string | null | undefined,
  action: string,
  actor: AuditActor,
  targets: AuditTarget[],
): Promise<void> {
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
    logger.warn({ err, action, orgId }, 'Audit log event failed (non-fatal)');
  }
}
