import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../plugins/errorHandler.js';
import { generateDkimKeyPair, dnsPublicKeyValue } from '../../lib/dkim.js';
import { getDomainHealth } from '../../lib/deliverability.js';
import { checkDomainBlacklists } from '../../engine/deliverability.js';
import { config } from '../../config.js';

const createSchema = z.object({
  name: z.string().min(3).max(253),
  region: z.enum(['us-east-1', 'eu-west-1', 'ap-southeast-1']).default('us-east-1'),
  track_opens: z.boolean().default(true),
  track_clicks: z.boolean().default(true),
});

function getDkimSecret(): string {
  return (config as Record<string, unknown>)['DOMAIN_KEY_SECRET'] as string ?? config.API_KEY_SALT;
}

export async function domainRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /v1/domains
  fastify.post(
    '/domains',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

      const { name, region, track_opens, track_clicks } = parsed.data;
      const apiKeyId = request.apiKey.id;

      const existing = await prisma.sendingDomain.findUnique({ where: { apiKeyId_name: { apiKeyId, name } } });
      if (existing) throw Errors.validationFailed([{ field: 'name', message: 'Domain already registered.' }]);

      const kp = generateDkimKeyPair(getDkimSecret());
      const dnsValue = dnsPublicKeyValue(kp.publicKey);

      const domain = await prisma.sendingDomain.create({
        data: {
          apiKeyId, name, region, trackOpens: track_opens, trackClicks: track_clicks,
          dkimSelector: kp.selector,
          dkimPublicKey: kp.publicKey,
          dkimPrivateKeyEnc: kp.privateKeyEnc,
        },
        select: { id: true, name: true, status: true, region: true, dkimSelector: true, createdAt: true },
      });

      return reply.status(201).send({
        ...domain,
        dns_records: {
          dkim: {
            name: `${kp.selector}._domainkey.${name}`,
            type: 'TXT',
            value: dnsValue,
          },
          spf: {
            name: name,
            type: 'TXT',
            value: 'v=spf1 include:amazonses.com ~all',
          },
          return_path: {
            name: `bounce.${name}`,
            type: 'MX',
            value: 'feedback-smtp.us-east-1.amazonses.com',
            priority: 10,
          },
          dmarc: {
            name: `_dmarc.${name}`,
            type: 'TXT',
            value: 'v=DMARC1; p=quarantine; rua=mailto:dmarc@continuumapi.com',
          },
        },
      });
    },
  );

  // GET /v1/domains
  fastify.get(
    '/domains',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const apiKeyId = request.apiKey.id;
      const domains = await prisma.sendingDomain.findMany({
        where: { apiKeyId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, name: true, status: true, region: true, dkimSelector: true,
          spfStatus: true, dkimStatus: true, returnPathStatus: true,
          trackOpens: true, trackClicks: true, createdAt: true, verifiedAt: true,
        },
      });
      return reply.status(200).send({ data: domains });
    },
  );

  // GET /v1/domains/:id
  fastify.get(
    '/domains/:id',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const apiKeyId = request.apiKey.id;

      const domain = await prisma.sendingDomain.findFirst({
        where: { id, apiKeyId },
        select: {
          id: true, name: true, status: true, region: true, dkimSelector: true,
          dkimPublicKey: true, spfStatus: true, dkimStatus: true, returnPathStatus: true,
          trackOpens: true, trackClicks: true, createdAt: true, verifiedAt: true,
        },
      });
      if (!domain) throw Errors.notFound('Domain not found.');

      return reply.status(200).send(domain);
    },
  );

  // POST /v1/domains/:id/verify — re-check DNS status
  fastify.post(
    '/domains/:id/verify',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const apiKeyId = request.apiKey.id;

      const domain = await prisma.sendingDomain.findFirst({ where: { id, apiKeyId } });
      if (!domain) throw Errors.notFound('Domain not found.');

      const health = await getDomainHealth(domain.name, domain.dkimStatus === 'verified');
      const allVerified = health.spf.valid && health.dkim.valid && health.dmarc.valid;

      const updated = await prisma.sendingDomain.update({
        where: { id },
        data: {
          spfStatus: health.spf.valid ? 'verified' : 'pending',
          dkimStatus: health.dkim.valid ? 'verified' : 'pending',
          status: allVerified ? 'verified' : 'pending',
          ...(allVerified ? { verifiedAt: new Date() } : {}),
        },
        select: { id: true, name: true, status: true, spfStatus: true, dkimStatus: true, returnPathStatus: true, verifiedAt: true },
      });

      return reply.status(200).send({ ...updated, health });
    },
  );

  // GET /v1/domains/:id/health
  fastify.get(
    '/domains/:id/health',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const apiKeyId = request.apiKey.id;

      const domain = await prisma.sendingDomain.findFirst({ where: { id, apiKeyId } });
      if (!domain) throw Errors.notFound('Domain not found.');

      const health = await getDomainHealth(domain.name, domain.dkimStatus === 'verified');
      return reply.status(200).send(health);
    },
  );

  // DELETE /v1/domains/:id
  fastify.delete(
    '/domains/:id',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const apiKeyId = request.apiKey.id;

      const domain = await prisma.sendingDomain.findFirst({ where: { id, apiKeyId } });
      if (!domain) throw Errors.notFound('Domain not found.');

      await prisma.sendingDomain.delete({ where: { id } });
      return reply.status(200).send({ deleted: true, id });
    },
  );

  // GET /v1/domains/:id/blacklist-status — comprehensive blacklist check (15+ providers)
  fastify.get(
    '/domains/:id/blacklist-status',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const apiKeyId = request.apiKey.id;

      const domain = await prisma.sendingDomain.findFirst({ where: { id, apiKeyId } });
      if (!domain) throw Errors.notFound('Domain not found.');

      const result = await checkDomainBlacklists(domain.name);
      return reply.status(200).send(result);
    },
  );

  // GET /v1/domains/blacklist-check?domain=example.com — ad-hoc check for any domain
  fastify.get(
    '/domains/blacklist-check',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const q = request.query as { domain?: string };
      if (!q.domain) throw Errors.validationFailed([{ field: 'domain', message: 'domain query param required' }]);

      const result = await checkDomainBlacklists(q.domain.toLowerCase());
      return reply.status(200).send(result);
    },
  );
}
