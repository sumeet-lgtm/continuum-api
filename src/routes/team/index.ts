import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { Errors, AppError } from '../../plugins/errorHandler.js';
import { sendEmail } from '../../lib/email.js';
import { config } from '../../config.js';

function inviteEmail(inviteeEmail: string, inviterEmail: string, workspaceName: string, token: string): { subject: string; html: string } {
  const url = `${config.DASHBOARD_URL}/accept-invite?token=${token}`;
  return {
    subject: `You've been invited to join ${workspaceName} on Continuum`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
        <h2 style="margin-bottom:8px">You're invited</h2>
        <p style="color:#555">${inviterEmail} has invited you to collaborate on <strong>${workspaceName}</strong> in Continuum — the cold email platform built for serious outreach.</p>
        <div style="margin:24px 0">
          <a href="${url}" style="background:#000;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">Accept Invitation</a>
        </div>
        <p style="color:#888;font-size:13px">This link expires in 7 days. If you didn't expect this invite, you can ignore it.</p>
      </div>
    `,
  };
}

export async function teamRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /v1/team — list members of this workspace
  fastify.get('/team', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const apiKeyId = request.apiKey.id;

    const members = await prisma.teamMember.findMany({
      where: { workspaceKeyId: apiKeyId },
      orderBy: { joinedAt: 'asc' },
    });

    // Include the owner (the API key itself)
    const ownerKey = request.apiKey;

    return reply.status(200).send({
      data: members,
      owner: {
        email: null, // resolved from workos user on frontend
        keyPrefix: ownerKey.keyPrefix,
        plan: ownerKey.plan,
      },
    });
  });

  // GET /v1/team/invites — list pending invites
  fastify.get('/team/invites', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const apiKeyId = request.apiKey.id;
    const invites = await prisma.teamInvite.findMany({
      where: { workspaceKeyId: apiKeyId, status: 'pending', expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    return reply.status(200).send({ data: invites });
  });

  // POST /v1/team/invite — invite a new member
  fastify.post('/team/invite', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const apiKeyId = request.apiKey.id;
    const body = z.object({
      email: z.string().email(),
      role: z.enum(['admin', 'member']).default('member'),
    }).safeParse(request.body);

    if (!body.success) throw Errors.validationFailed(body.error.issues[0]?.message);

    const { email, role } = body.data;
    const lowerEmail = email.toLowerCase();

    // Check not already a member
    const existing = await prisma.teamMember.findFirst({ where: { workspaceKeyId: apiKeyId, email: lowerEmail } });
    if (existing) throw new AppError(409, 'CONFLICT', `${email} is already a member of this workspace.`);

    // Revoke any existing pending invite for this email
    await prisma.teamInvite.updateMany({
      where: { workspaceKeyId: apiKeyId, inviteeEmail: lowerEmail, status: 'pending' },
      data: { status: 'revoked' },
    });

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const invite = await prisma.teamInvite.create({
      data: {
        workspaceKeyId: apiKeyId,
        inviteeEmail: lowerEmail,
        role,
        expiresAt,
        invitedBy: request.apiKey.label ?? request.apiKey.keyPrefix,
      },
    });

    // Get workspace name for the invite email
    const workspaceName = request.apiKey.label ?? `${request.apiKey.keyPrefix}…`;
    const inviterEmail = request.apiKey.label ?? request.apiKey.keyPrefix;
    const msg = inviteEmail(lowerEmail, inviterEmail, workspaceName, invite.token);
    void sendEmail(lowerEmail, msg.subject, msg.html);

    return reply.status(201).send({ invite, inviteUrl: `${config.DASHBOARD_URL}/accept-invite?token=${invite.token}` });
  });

  // PATCH /v1/team/:memberId — change role
  fastify.patch('/team/:memberId', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { memberId } = request.params as { memberId: string };
    const apiKeyId = request.apiKey.id;
    const body = z.object({ role: z.enum(['admin', 'member']) }).safeParse(request.body);
    if (!body.success) throw Errors.validationFailed(body.error.issues[0]?.message);

    const member = await prisma.teamMember.findFirst({ where: { id: memberId, workspaceKeyId: apiKeyId } });
    if (!member) throw Errors.notFound('Team member');

    const updated = await prisma.teamMember.update({ where: { id: memberId }, data: { role: body.data.role } });
    return reply.status(200).send(updated);
  });

  // DELETE /v1/team/:memberId — remove member
  fastify.delete('/team/:memberId', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { memberId } = request.params as { memberId: string };
    const apiKeyId = request.apiKey.id;

    const member = await prisma.teamMember.findFirst({ where: { id: memberId, workspaceKeyId: apiKeyId } });
    if (!member) throw Errors.notFound('Team member');

    await prisma.teamMember.delete({ where: { id: memberId } });
    return reply.status(200).send({ deleted: true, id: memberId });
  });

  // DELETE /v1/team/invites/:inviteId — revoke invite
  fastify.delete('/team/invites/:inviteId', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { inviteId } = request.params as { inviteId: string };
    const apiKeyId = request.apiKey.id;

    const invite = await prisma.teamInvite.findFirst({ where: { id: inviteId, workspaceKeyId: apiKeyId } });
    if (!invite) throw Errors.notFound('Invite');

    await prisma.teamInvite.update({ where: { id: inviteId }, data: { status: 'revoked' } });
    return reply.status(200).send({ revoked: true });
  });
}
