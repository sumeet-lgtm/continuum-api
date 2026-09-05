import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { hashApiKey } from '../../lib/crypto.js';
import { Errors } from '../../plugins/errorHandler.js';
import { logAudit } from '../../lib/audit.js';
import { getPlanLimit, getSendLimit } from '../../plugins/usageMeter.js';

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
          createdAt: true, lastUsedAt: true, allowedIps: true, rateLimit: true,
          currentMonthUsage: true, monthlyLimit: true, currentMonthSendUsage: true,
          usageAlertEnabled: true, expiresAt: true, monthlySendLimit: true,
        },
      });

      // monthlyLimit/monthlySendLimit are raw override columns (default
      // 1,000/500) — a standard plan's real ceiling always overrides them
      // (see getPlanLimit), so callers relying on the raw column alone were
      // reading a stale Free-tier number regardless of actual plan.
      const data = keys.map((k) => ({
        ...k,
        effectiveMonthlyLimit: getPlanLimit(k.plan, k.monthlyLimit),
        effectiveMonthlySendLimit: getSendLimit(k.plan, k.monthlySendLimit),
      }));

      return reply.status(200).send({ data });
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
          orgId: parentKey.orgId,
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

      void logAudit(
        null, 'api_key.created',
        { id: parentKey.id, email: parentKey.label ?? parentKey.name ?? parentKey.keyPrefix, ip: request.ip },
        [{ type: 'api_key', id: newKey.id, name: newKey.name ?? undefined }],
        parentKey.id,
      );

      // Return raw key once only
      return reply.status(201).send({ ...newKey, key: rawKey });
    },
  );

  // PATCH /v1/api-keys/:id/label — rename a key
  fastify.patch(
    '/api-keys/:id/label',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const parentKey = request.apiKey;
      const body = request.body as { label?: unknown };

      if (typeof body?.label !== 'string' || body.label.trim().length === 0) {
        throw Errors.validationFailed([{ field: 'label', message: 'Must be a non-empty string' }]);
      }
      if (body.label.trim().length > 100) {
        throw Errors.validationFailed([{ field: 'label', message: 'Label must be 100 characters or fewer' }]);
      }

      const ownerId = parentKey.ownerId ?? parentKey.userId ?? parentKey.id;
      const target = await prisma.apiKey.findUnique({ where: { id }, select: { id: true, ownerId: true, userId: true } });
      if (!target) throw Errors.notFound('API key not found.');
      if (target.ownerId !== ownerId && target.userId !== ownerId && id !== parentKey.id) {
        throw Errors.forbidden('Not authorized to rename this key.');
      }

      const label = body.label.trim();
      await prisma.apiKey.update({ where: { id }, data: { label, name: label } });

      return reply.status(200).send({ id, label });
    },
  );

  // PATCH /v1/api-keys/:id/quota — override monthly verification quota for a key
  fastify.patch(
    '/api-keys/:id/quota',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const parentKey = request.apiKey;

      if (parentKey.permission !== 'full_access') {
        throw Errors.forbidden('Only full_access keys can adjust quotas.');
      }

      const body = request.body as { monthlyLimit?: unknown };
      const monthlyLimit = Number(body?.monthlyLimit);
      if (!Number.isInteger(monthlyLimit) || monthlyLimit < 0 || monthlyLimit > 10_000_000) {
        throw Errors.validationFailed([{ field: 'monthlyLimit', message: 'Must be an integer between 0 and 10,000,000 (0 = unlimited)' }]);
      }

      const ownerId = parentKey.ownerId ?? parentKey.userId ?? parentKey.id;
      const target = await prisma.apiKey.findUnique({ where: { id }, select: { id: true, ownerId: true, userId: true } });
      if (!target) throw Errors.notFound('API key not found.');
      if (target.ownerId !== ownerId && target.userId !== ownerId && id !== parentKey.id) {
        throw Errors.forbidden('Not authorized to adjust this key.');
      }

      await prisma.apiKey.update({ where: { id }, data: { monthlyLimit } });

      return reply.status(200).send({
        id,
        monthlyLimit,
        message: monthlyLimit === 0 ? 'Monthly quota cleared — unlimited.' : `Monthly quota set to ${monthlyLimit.toLocaleString()} verifications.`,
      });
    },
  );

  // PATCH /v1/api-keys/:id/rate-limit — override rate limit for a key
  fastify.patch(
    '/api-keys/:id/rate-limit',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const parentKey = request.apiKey;

      if (parentKey.permission !== 'full_access') {
        throw Errors.forbidden('Only full_access keys can adjust rate limits.');
      }

      const body = request.body as { rateLimit?: unknown };
      const rateLimit = Number(body?.rateLimit);
      if (!Number.isInteger(rateLimit) || rateLimit < 1 || rateLimit > 10_000) {
        throw Errors.validationFailed([{ field: 'rateLimit', message: 'Must be an integer between 1 and 10,000' }]);
      }

      const ownerId = parentKey.ownerId ?? parentKey.userId ?? parentKey.id;
      const target = await prisma.apiKey.findUnique({ where: { id }, select: { id: true, ownerId: true, userId: true } });
      if (!target) throw Errors.notFound('API key not found.');
      if (target.ownerId !== ownerId && target.userId !== ownerId && id !== parentKey.id) {
        throw Errors.forbidden('Not authorized to adjust this key.');
      }

      await prisma.apiKey.update({ where: { id }, data: { rateLimit } });

      return reply.status(200).send({ id, rateLimit, message: `Rate limit set to ${rateLimit} req/min.` });
    },
  );

  // PATCH /v1/api-keys/:id/ip-allowlist — set/clear IP allowlist for a key
  fastify.patch(
    '/api-keys/:id/ip-allowlist',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const parentKey = request.apiKey;

      if (parentKey.permission !== 'full_access') {
        throw Errors.forbidden('Only full_access keys can manage IP allowlists.');
      }

      const body = request.body as { ips?: unknown };
      if (!Array.isArray(body?.ips)) {
        throw Errors.validationFailed([{ field: 'ips', message: 'Must be an array of IP address strings' }]);
      }
      const ips: string[] = body.ips.filter((ip) => typeof ip === 'string' && ip.trim().length > 0).map((ip) => (ip as string).trim());

      // Basic IP format validation (IPv4 + IPv4 CIDR + IPv6)
      const ipPattern = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$|^[0-9a-fA-F:]+$/;
      const invalid = ips.filter((ip) => !ipPattern.test(ip));
      if (invalid.length > 0) {
        throw Errors.validationFailed([{ field: 'ips', message: `Invalid IP format: ${invalid.join(', ')}` }]);
      }

      const ownerId = parentKey.ownerId ?? parentKey.userId ?? parentKey.id;
      const target = await prisma.apiKey.findUnique({ where: { id }, select: { id: true, ownerId: true, userId: true } });
      if (!target) throw Errors.notFound('API key not found.');
      if (target.ownerId !== ownerId && target.userId !== ownerId && id !== parentKey.id) {
        throw Errors.forbidden('Not authorized to manage this key.');
      }

      await prisma.apiKey.update({ where: { id }, data: { allowedIps: ips } });

      // Evict from in-process cache so the restriction applies within seconds
      // (Cache is module-private, so we rely on its natural 60s TTL.)

      return reply.status(200).send({ id, allowedIps: ips, message: ips.length === 0 ? 'IP allowlist cleared — all IPs now allowed.' : `IP allowlist updated to ${ips.length} address(es).` });
    },
  );

  // PATCH /v1/api-keys/:id/usage-alerts — toggle 80% usage alert emails
  fastify.patch(
    '/api-keys/:id/usage-alerts',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const parentKey = request.apiKey;
      const body = request.body as { enabled?: unknown };

      if (typeof body?.enabled !== 'boolean') {
        throw Errors.validationFailed([{ field: 'enabled', message: 'Must be a boolean' }]);
      }

      const ownerId = parentKey.ownerId ?? parentKey.userId ?? parentKey.id;
      const target = await prisma.apiKey.findUnique({ where: { id }, select: { id: true, ownerId: true, userId: true } });
      if (!target) throw Errors.notFound('API key not found.');
      if (target.ownerId !== ownerId && target.userId !== ownerId && id !== parentKey.id) {
        throw Errors.forbidden('Not authorized to manage this key.');
      }

      await prisma.apiKey.update({ where: { id }, data: { usageAlertEnabled: body.enabled } });

      return reply.status(200).send({ id, usageAlertEnabled: body.enabled });
    },
  );

  // PATCH /v1/api-keys/:id/expiry — set or clear expiry date on a key
  fastify.patch(
    '/api-keys/:id/expiry',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const parentKey = request.apiKey;
      const body = request.body as { expiresAt?: unknown };

      // expiresAt must be an ISO string or null to clear
      let expiresAt: Date | null = null;
      if (body?.expiresAt !== null && body?.expiresAt !== undefined) {
        const parsed = new Date(body.expiresAt as string);
        if (isNaN(parsed.getTime())) {
          throw Errors.validationFailed([{ field: 'expiresAt', message: 'Must be a valid ISO date string or null' }]);
        }
        if (parsed <= new Date()) {
          throw Errors.validationFailed([{ field: 'expiresAt', message: 'Expiry must be in the future' }]);
        }
        expiresAt = parsed;
      }

      const ownerId = parentKey.ownerId ?? parentKey.userId ?? parentKey.id;
      const target = await prisma.apiKey.findUnique({ where: { id }, select: { id: true, ownerId: true, userId: true } });
      if (!target) throw Errors.notFound('API key not found.');
      if (target.ownerId !== ownerId && target.userId !== ownerId && id !== parentKey.id) {
        throw Errors.forbidden('Not authorized to manage this key.');
      }

      await prisma.apiKey.update({ where: { id }, data: { expiresAt } });

      return reply.status(200).send({
        id,
        expiresAt: expiresAt?.toISOString() ?? null,
        message: expiresAt ? `Key will expire at ${expiresAt.toISOString()}` : 'Expiry cleared — key never expires.',
      });
    },
  );

  // POST /v1/api-keys/:id/rotate — atomically create a replacement key and revoke the old one
  fastify.post(
    '/api-keys/:id/rotate',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const parentKey = request.apiKey;

      if (parentKey.permission !== 'full_access') {
        throw Errors.forbidden('Only full_access keys can rotate API keys.');
      }

      const target = await prisma.apiKey.findUnique({
        where: { id },
        select: {
          id: true, ownerId: true, userId: true, orgId: true, name: true, label: true,
          permission: true, plan: true, rateLimit: true, monthlyLimit: true,
          monthlySendLimit: true, restrictedDomainId: true, allowedIps: true,
          isActive: true,
        },
      });
      if (!target) throw Errors.notFound('API key not found.');
      if (!target.isActive) throw Errors.forbidden('Cannot rotate a revoked key.');

      const ownerId = parentKey.ownerId ?? parentKey.userId ?? parentKey.id;
      if (target.ownerId !== ownerId && target.userId !== ownerId && id !== parentKey.id) {
        throw Errors.forbidden('Not authorized to rotate this key.');
      }

      // Create the replacement key first (inherits all settings)
      const rawKey    = `ctm_${randomBytes(24).toString('base64url')}`;
      const keyHash   = hashApiKey(rawKey);
      const keyPrefix = rawKey.slice(0, 12);
      const label     = (target.label ?? target.name ?? 'Key').replace(/\s*\(rotated.*\)$/, '');

      const newKey = await prisma.apiKey.create({
        data: {
          keyHash, keyPrefix, keyRaw: rawKey,
          name:               label,
          label:              label,
          permission:         target.permission,
          plan:               target.plan,
          rateLimit:          target.rateLimit,
          monthlyLimit:       target.monthlyLimit,
          monthlySendLimit:   target.monthlySendLimit,
          restrictedDomainId: target.restrictedDomainId,
          allowedIps:         target.allowedIps,
          ownerId:            target.ownerId,
          userId:             target.userId,
          orgId:              target.orgId,
        },
        select: { id: true, keyPrefix: true, name: true, permission: true, createdAt: true },
      });

      // Revoke the old key
      await prisma.apiKey.update({
        where: { id },
        data:  { isActive: false, revokedAt: new Date() },
      });

      void logAudit(
        null, 'api_key.rotated',
        { id: parentKey.id, email: parentKey.label ?? parentKey.name ?? parentKey.keyPrefix, ip: request.ip },
        [{ type: 'api_key', id, name: 'old' }, { type: 'api_key', id: newKey.id, name: 'new' }],
        parentKey.id,
      );

      return reply.status(201).send({ ...newKey, key: rawKey, rotatedKeyId: id });
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

      void logAudit(
        null, 'api_key.revoked',
        { id: parentKey.id, email: parentKey.label ?? parentKey.name ?? parentKey.keyPrefix, ip: request.ip },
        [{ type: 'api_key', id }],
        parentKey.id,
      );

      return reply.status(200).send({ revoked: true, id });
    },
  );
}
