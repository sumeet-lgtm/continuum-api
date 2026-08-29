import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { WorkOS } from '@workos-inc/node';
import { config } from '../../config.js';
import { prisma } from '../../lib/prisma.js';
import { hashApiKey } from '../../lib/crypto.js';
import { sendEmail, welcomeEmail } from '../../lib/email.js';
import { logAudit } from '../../lib/audit.js';
import { logger } from '../../lib/logger.js';

let _workos: WorkOS | null = null;

function getWorkOS(): WorkOS {
  if (!_workos) {
    if (!config.WORKOS_API_KEY) throw new Error('WORKOS_API_KEY not configured');
    _workos = new WorkOS(config.WORKOS_API_KEY);
  }
  return _workos;
}

export async function workosWebhookRoutes(fastify: FastifyInstance): Promise<void> {
  // The signature must be verified against the EXACT raw bytes WorkOS signed —
  // re-serializing the parsed body via JSON.stringify is not guaranteed to
  // match byte-for-byte (key order, spacing, escaping). Scoped to this
  // plugin only; the handler below parses JSON manually as a result.
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => done(null, body),
  );

  fastify.post(
    '/webhooks/workos',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const rawBody = request.body as string;
      const sigHeader = request.headers['workos-signature'] as string | undefined;

      // Verify signature when secret is configured
      if (config.WORKOS_WEBHOOK_SECRET) {
        if (!sigHeader) {
          return reply.status(401).send({ error: 'Missing workos-signature header' });
        }
        try {
          // constructEvent returns a Promise and rejects (not throws) on a
          // bad signature — the missing await here used to let that
          // rejection go unhandled and crash the entire process (not just
          // this request) on every invalid signature.
          await getWorkOS().webhooks.constructEvent({
            payload: rawBody,
            sigHeader,
            secret: config.WORKOS_WEBHOOK_SECRET,
          });
        } catch {
          return reply.status(401).send({ error: 'Invalid webhook signature' });
        }
      }

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        return reply.status(400).send({ error: 'Invalid JSON' });
      }
      const eventType = event.event as string;
      const data = event.data as Record<string, unknown>;

      logger.info({ eventType }, 'WorkOS webhook received');

      try {
        switch (eventType) {
          case 'dsync.user.created': {
            const email = data.username as string;
            const firstName = (data.first_name as string) ?? null;
            const lastName = (data.last_name as string) ?? null;
            const orgId = data.organization_id as string;

            const user = await prisma.user.upsert({
              where: { email },
              create: { email, firstName, lastName, orgId },
              update: { firstName, lastName, orgId },
            });

            // Create API key for provisioned user
            const existing = await prisma.apiKey.findFirst({ where: { ownerId: user.id, isActive: true } });
            if (!existing) {
              const raw = `cont_live_${crypto.randomUUID().replace(/-/g, '')}`;
              const newKey = await prisma.apiKey.create({
                data: {
                  keyHash: hashApiKey(raw),
                  keyPrefix: raw.slice(0, 8),
                  keyRaw: raw,
                  label: `${firstName ?? email.split('@')[0]}'s key`,
                  ownerId: user.id,
                  plan: 'free',
                },
              });
              const msg = welcomeEmail(newKey.keyPrefix, firstName ?? undefined);
              void sendEmail(email, msg.subject, msg.html);
            }

            // Create org membership record
            const membershipId = data.id as string;
            await prisma.orgMember.upsert({
              where: { membershipId },
              create: { userId: user.id, orgId, membershipId, role: 'member', email, status: 'active' },
              update: { status: 'active', email },
            });

            void logAudit(orgId, 'directory_sync.user_provisioned', { id: user.id, email }, [
              { type: 'user', id: user.id, name: email },
            ]);
            break;
          }

          case 'dsync.user.deleted': {
            const email = data.username as string;
            const orgId = data.organization_id as string;
            const membershipId = data.id as string;

            const user = await prisma.user.findUnique({ where: { email } });
            if (user) {
              await prisma.apiKey.updateMany({ where: { ownerId: user.id }, data: { isActive: false } });
              await prisma.orgMember.updateMany({ where: { userId: user.id, orgId }, data: { status: 'inactive' } });
              try {
                await prisma.orgMember.update({ where: { membershipId }, data: { status: 'inactive' } });
              } catch { /* membership row may not exist */ }
              void logAudit(orgId, 'directory_sync.user_deprovisioned', { id: user.id, email }, [
                { type: 'user', id: user.id, name: email },
              ]);
            }
            break;
          }

          case 'dsync.user.updated': {
            const email = data.username as string;
            const firstName = (data.first_name as string) ?? undefined;
            const lastName = (data.last_name as string) ?? undefined;
            await prisma.user.update({
              where: { email },
              data: { firstName: firstName ?? null, lastName: lastName ?? null },
            });
            break;
          }

          case 'dsync.group.user_added': {
            const groupName = (data.name as string ?? '').toLowerCase();
            const membershipId = data.id as string;
            if (groupName.includes('admin') || groupName.includes('owner')) {
              await prisma.orgMember.update({ where: { membershipId }, data: { role: 'admin' } });
            }
            break;
          }

          case 'dsync.group.user_removed': {
            const membershipId = data.id as string;
            await prisma.orgMember.update({ where: { membershipId }, data: { role: 'member' } });
            break;
          }

          default:
            logger.info({ eventType }, 'WorkOS webhook event not handled');
        }
      } catch (err) {
        logger.error({ err, eventType }, 'WorkOS webhook handler error');
        return reply.status(500).send({ error: 'Handler error' });
      }

      return reply.status(200).send({ received: true });
    },
  );
}
