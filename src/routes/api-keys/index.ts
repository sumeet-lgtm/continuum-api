import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { hashApiKey } from '../../lib/crypto.js';
import { Errors } from '../../plugins/errorHandler.js';

const createSchema = z.object({
  name: z.string().min(1).max(100),
  permission: z.enum(['full_access', 'sending_access']).default('full_access'),
  domain_id: z.string().optional(),
});

export async function apiKeyRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /v1/api-keys — list all keys for this account (same ownerId)
  fastify.get(
    '/api-keys',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const key = request.apiKey;
      const ownerId = key.ownerId ?? key.userId ?? key.id;

      const keys = await prisma.apiKey.findMany({
        where: { OR: [{ ownerId }, { userId: ownerId }, { id: key.id }] },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, keyPrefix: true, name: true, label: true, permission: true,
          restrictedDomainId: true, plan: true, isActive: true, revokedAt: true,
          createdAt: true, lastUsedAt: true,
        },
      });

      return reply.status(200).send({ data: keys });
    },
  );

  // POST /v1/api-keys — create additional scoped key
  fastify.post(
    '/api-keys',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

      const parentKey = request.apiKey;
      const { name, permission, domain_id } = parsed.data;

      // Only full_access keys can create new keys
      if (parentKey.permission !== 'full_access') {
        throw Errors.forbidden('Only full_access keys can create additional API keys.');
      }

      const rawKey = `ctm_${randomBytes(24).toString('base64url')}`;
      const keyHash = hashApiKey(rawKey);
      const keyPrefix = rawKey.slice(0, 12);

      const effectiveOwnerId = parentKey.ownerId ?? parentKey.userId ?? parentKey.id;

      const newKey = await prisma.apiKey.create({
        data: {
          keyHash,
          keyPrefix,
          keyRaw: rawKey,
          name,
          label: name,
          permission,
          restrictedDomainId: domain_id ?? null,
          ownerId: effectiveOwnerId,
          userId: parentKey.userId,
          plan: parentKey.plan,
          rateLimit: parentKey.rateLimit,
          monthlyLimit: parentKey.monthlyLimit,
          monthlySendLimit: parentKey.monthlySendLimit,
        },
        select: {
          id: true, keyPrefix: true, name: true, permission: true,
          restrictedDomainId: true, plan: true, createdAt: true,
        },
      });

      // Return raw key once only
      return reply.status(201).send({ ...newKey, key: rawKey });
    },
  );

  // DELETE /v1/api-keys/:id — revoke a key
  fastify.delete(
    '/api-keys/:id',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const parentKey = request.apiKey;

      if (parentKey.permission !== 'full_access') {
        throw Errors.forbidden('Only full_access keys can revoke API keys.');
      }

      if (id === parentKey.id) {
        throw Errors.forbidden('Cannot revoke the currently authenticated key.');
      }

      const target = await prisma.apiKey.findUnique({
        where: { id },
        select: { id: true, ownerId: true, userId: true, isActive: true },
      });
      if (!target) throw Errors.notFound('API key not found.');

      const ownerId = parentKey.ownerId ?? parentKey.userId ?? parentKey.id;
      if (target.ownerId !== ownerId && target.userId !== ownerId) {
        throw Errors.forbidden('Not authorized to revoke this key.');
      }

      await prisma.apiKey.update({
        where: { id },
        data: { isActive: false, revokedAt: new Date() },
      });

      return reply.status(200).send({ revoked: true, id });
    },
  );
}
