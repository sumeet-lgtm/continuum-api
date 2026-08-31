import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { WorkOS } from '@workos-inc/node';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { config } from '../../config.js';
import { Errors } from '../../plugins/errorHandler.js';
import { requireOrgSession, requireOrgAdmin } from '../../plugins/auth.js';
import { logAudit } from '../../lib/audit.js';

let _workos: WorkOS | null = null;

function getWorkOS(): WorkOS {
  if (!_workos) {
    if (!config.WORKOS_API_KEY) throw new Error('WORKOS_API_KEY not configured');
    _workos = new WorkOS(config.WORKOS_API_KEY);
  }
  return _workos;
}

const inviteSchema = z.object({
  email: z.string().email('Invalid email'),
  role: z.enum(['admin', 'member']).default('member'),
});

const updateMemberSchema = z.object({
  role: z.enum(['admin', 'member']),
});

const updateSettingsSchema = z.object({
  name: z.string().max(100).optional(),
  mfaRequired: z.boolean().optional(),
});

export async function orgRoutes(fastify: FastifyInstance): Promise<void> {

  // ── GET /org ──────────────────────────────────────────────────────────────
  fastify.get('/org', { preHandler: [requireOrgSession] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { orgId } = request.sessionUser!;
    if (!orgId) {
      return reply.send({ orgId: null, configured: false, message: 'Not part of an organization' });
    }

    const [settings, memberCount] = await Promise.all([
      prisma.orgSettings.findUnique({ where: { orgId } }),
      prisma.orgMember.count({ where: { orgId, status: 'active' } }),
    ]);

    let org: { name?: string; domains?: Array<{ domain: string }> } | null = null;
    try {
      org = await getWorkOS().organizations.getOrganization(orgId) as { name?: string; domains?: Array<{ domain: string }> };
    } catch {
      // WorkOS org may not exist yet — fallback to local data
    }

    return reply.send({
      orgId,
      name: settings?.name ?? org?.name ?? null,
      domain: settings?.domain ?? org?.domains?.[0]?.domain ?? null,
      mfaRequired: settings?.mfaRequired ?? false,
      memberCount,
      configured: true,
    });
  });

  // ── GET /org/members ──────────────────────────────────────────────────────
  fastify.get('/org/members', { preHandler: [requireOrgSession] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { orgId } = request.sessionUser!;
    if (!orgId) throw Errors.forbidden('Not part of an organization');

    const members = await prisma.orgMember.findMany({
      where: { orgId, status: 'active' },
      orderBy: { createdAt: 'asc' },
    });

    return reply.send({ data: members, total: members.length });
  });

  // ── POST /org/invitations ─────────────────────────────────────────────────
  fastify.post('/org/invitations', { preHandler: [requireOrgAdmin] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { orgId, userId, email: actorEmail } = request.sessionUser!;
    if (!orgId) throw Errors.forbidden('Not part of an organization');

    const parsed = inviteSchema.safeParse(request.body);
    if (!parsed.success) {
      throw Errors.validationFailed(parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
    }

    const { email, role } = parsed.data;

    const invitation = await getWorkOS().userManagement.sendInvitation({
      email,
      organizationId: orgId,
      roleSlug: role,
      inviterUserId: userId,
    });

    void logAudit(orgId, 'member.invited', { id: userId, email: actorEmail, ip: request.ip }, [
      { type: 'user', id: email, name: email },
    ]);

    return reply.status(201).send({ id: invitation.id, email: invitation.email, state: invitation.state });
  });

  // ── GET /org/invitations ──────────────────────────────────────────────────
  fastify.get('/org/invitations', { preHandler: [requireOrgAdmin] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { orgId } = request.sessionUser!;
    if (!orgId) throw Errors.forbidden('Not part of an organization');

    const invitations = await getWorkOS().userManagement.listInvitations({ organizationId: orgId });

    return reply.send({ data: invitations.data, total: invitations.data.length });
  });

  // ── DELETE /org/invitations/:id ───────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>('/org/invitations/:id', { preHandler: [requireOrgAdmin] }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { orgId } = request.sessionUser!;
    if (!orgId) throw Errors.forbidden('Not part of an organization');

    await getWorkOS().userManagement.revokeInvitation(request.params.id);
    return reply.send({ id: request.params.id, revoked: true });
  });

  // ── PATCH /org/members/:membershipId ──────────────────────────────────────
  fastify.patch<{ Params: { membershipId: string } }>('/org/members/:membershipId', { preHandler: [requireOrgAdmin] }, async (request: FastifyRequest<{ Params: { membershipId: string } }>, reply: FastifyReply) => {
    const { orgId, userId, email: actorEmail } = request.sessionUser!;
    if (!orgId) throw Errors.forbidden('Not part of an organization');

    const parsed = updateMemberSchema.safeParse(request.body);
    if (!parsed.success) {
      throw Errors.validationFailed(parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
    }

    const { role } = parsed.data;
    const membershipId = request.params.membershipId;

    await getWorkOS().userManagement.updateOrganizationMembership(membershipId, {
      roleSlug: role,
    });
    await prisma.orgMember.update({
      where: { membershipId },
      data: { role },
    });

    void logAudit(orgId, 'member.role_changed', { id: userId, email: actorEmail, ip: request.ip }, [
      { type: 'membership', id: membershipId },
    ]);

    return reply.send({ membershipId, role, updated: true });
  });

  // ── DELETE /org/members/:membershipId ─────────────────────────────────────
  fastify.delete<{ Params: { membershipId: string } }>('/org/members/:membershipId', { preHandler: [requireOrgAdmin] }, async (request: FastifyRequest<{ Params: { membershipId: string } }>, reply: FastifyReply) => {
    const { orgId, userId, email: actorEmail } = request.sessionUser!;
    if (!orgId) throw Errors.forbidden('Not part of an organization');

    const membershipId = request.params.membershipId;

    await getWorkOS().userManagement.deactivateOrganizationMembership(membershipId);
    await prisma.orgMember.update({
      where: { membershipId },
      data: { status: 'inactive' },
    });

    void logAudit(orgId, 'member.removed', { id: userId, email: actorEmail, ip: request.ip }, [
      { type: 'membership', id: membershipId },
    ]);

    return reply.send({ membershipId, removed: true });
  });

  // ── PATCH /org/settings ───────────────────────────────────────────────────
  fastify.patch('/org/settings', { preHandler: [requireOrgAdmin] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { orgId, userId, email: actorEmail } = request.sessionUser!;
    if (!orgId) throw Errors.forbidden('Not part of an organization');

    const parsed = updateSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      throw Errors.validationFailed(parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
    }

    const { name, mfaRequired } = parsed.data;

    const settings = await prisma.orgSettings.upsert({
      where: { orgId },
      create: { orgId, name: name ?? null, mfaRequired: mfaRequired ?? false },
      update: { ...(name !== undefined ? { name } : {}), ...(mfaRequired !== undefined ? { mfaRequired } : {}) },
    });

    void logAudit(orgId, 'org.settings_updated', { id: userId, email: actorEmail, ip: request.ip }, [
      { type: 'org', id: orgId },
    ]);

    return reply.send(settings);
  });

  // ── POST /org/portal ──────────────────────────────────────────────────────
  fastify.post('/org/portal', { preHandler: [requireOrgAdmin] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { orgId } = request.sessionUser!;
    if (!orgId) throw Errors.forbidden('Not part of an organization');

    const { link } = await getWorkOS().adminPortal.generateLink({
      organization: orgId,
      intent: 'sso',
    });

    return reply.send({ link, organizationId: orgId });
  });

  // ── GET /org/audit-logs ───────────────────────────────────────────────────
  fastify.get('/org/audit-logs', { preHandler: [requireOrgAdmin] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { orgId } = request.sessionUser!;
    if (!orgId) throw Errors.forbidden('Not part of an organization');

    try {
      const workos = getWorkOS();
      const exportResult = await workos.auditLogs.createExport({
        organizationId: orgId,
        rangeStart: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        rangeEnd: new Date(),
      });

      return reply.send({ exportId: exportResult.id, state: exportResult.state, url: exportResult.url ?? null });
    } catch {
      return reply.send({ exportId: null, state: 'unavailable', url: null, message: 'Audit logs not yet configured for this organization.' });
    }
  });

  // ── GET /org/api-keys ──────────────────────────────────────────────────────
  // Previously nothing let an org admin see, let alone act on, the actual
  // product resources their team's API keys own — org roles only reached
  // as far as the WorkOS-managed dashboard shell (invites, role changes).
  // This and the endpoint below are the first real teeth on that: an org
  // admin can now see every key tagged with their org and revoke one,
  // the same way they could already remove a member's org access.
  fastify.get('/org/api-keys', { preHandler: [requireOrgAdmin] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { orgId } = request.sessionUser!;
    if (!orgId) throw Errors.forbidden('Not part of an organization');

    const keys = await prisma.apiKey.findMany({
      where: { orgId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, keyPrefix: true, name: true, label: true, permission: true,
        plan: true, isActive: true, revokedAt: true, createdAt: true, lastUsedAt: true,
      },
    });

    return reply.send({ data: keys, total: keys.length });
  });

  // ── DELETE /org/api-keys/:id ───────────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>('/org/api-keys/:id', { preHandler: [requireOrgAdmin] }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { orgId, userId, email: actorEmail } = request.sessionUser!;
    if (!orgId) throw Errors.forbidden('Not part of an organization');

    const { id } = request.params;

    // Scoped to this org specifically — both "doesn't exist" and "exists
    // but belongs to a different org" return the same 404, rather than
    // confirming which, the same reasoning as the suppressions delete fix.
    const target = await prisma.apiKey.findFirst({ where: { id, orgId }, select: { id: true, isActive: true } });
    if (!target) throw Errors.notFound('API key not found in this organization.');

    await prisma.apiKey.update({
      where: { id },
      data: { isActive: false, revokedAt: new Date() },
    });

    void logAudit(orgId, 'api_key.revoked_by_org_admin', { id: userId, email: actorEmail, ip: request.ip }, [
      { type: 'api_key', id },
    ], id);

    return reply.send({ id, revoked: true });
  });
}
