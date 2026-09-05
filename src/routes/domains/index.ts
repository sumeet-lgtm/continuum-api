import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { SESv2Client, CreateEmailIdentityCommand, DeleteEmailIdentityCommand } from '@aws-sdk/client-sesv2';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { logAudit } from '../../lib/audit.js';
import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../plugins/errorHandler.js';
import { generateDkimKeyPair, dnsPublicKeyValue, pemToRawBase64 } from '../../lib/dkim.js';
import { getDomainHealth } from '../../lib/deliverability.js';
import { checkDomainBlacklists } from '../../engine/deliverability.js';
import { config } from '../../config.js';
import { verifyDomain } from '../../lib/domainVerify.js';
import { logger } from '../../lib/logger.js';

let _sesClient: SESv2Client | null = null;
function getSesClient(region: string): SESv2Client {
  if (!_sesClient) {
    const clientConfig = config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY
      ? {
          region: region ?? config.AWS_REGION ?? 'us-east-1',
          credentials: { accessKeyId: config.AWS_ACCESS_KEY_ID, secretAccessKey: config.AWS_SECRET_ACCESS_KEY },
        }
      : { region: region ?? config.AWS_REGION ?? 'us-east-1' };
    _sesClient = new SESv2Client(clientConfig);
  }
  return _sesClient;
}

const createSchema = z.object({
  name: z.string().min(3).max(253),
  region: z.enum(['us-east-1', 'eu-west-1', 'ap-southeast-1']).default('us-east-1'),
  track_opens: z.boolean().default(true),
  track_clicks: z.boolean().default(true),
  tracking_domain: z.string().min(3).max(253).optional(), // custom tracking subdomain e.g. "track.yourdomain.com"
});

function getDkimSecret(): string {
  return config.DOMAIN_KEY_SECRET ?? config.API_KEY_SALT;
}

export async function domainRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /v1/domains
  fastify.post(
    '/domains',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

      const { name, region, track_opens, track_clicks, tracking_domain } = parsed.data;
      const apiKeyId = request.apiKey.id;

      const existing = await prisma.sendingDomain.findUnique({ where: { apiKeyId_name: { apiKeyId, name } } });
      if (existing) throw Errors.validationFailed([{ field: 'name', message: 'Domain already registered.' }]);

      const kp = generateDkimKeyPair(getDkimSecret());
      const dnsValue = dnsPublicKeyValue(kp.publicKey);

      const domain = await prisma.sendingDomain.create({
        data: {
          apiKeyId, name, region, trackOpens: track_opens, trackClicks: track_clicks,
          trackingDomain: tracking_domain ?? null,
          dkimSelector: kp.selector,
          dkimPublicKey: kp.publicKey,
          dkimPrivateKeyEnc: kp.privateKeyEnc,
        },
        select: { id: true, name: true, status: true, region: true, dkimSelector: true, createdAt: true },
      });

      // Register domain in AWS SES so it can send emails through our infrastructure
      if (config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY) {
        try {
          const ses = getSesClient(region);
          await ses.send(new CreateEmailIdentityCommand({
            EmailIdentity: name,
            DkimSigningAttributes: {
              DomainSigningSelector: kp.selector,
              // SES requires the raw base64 body only, not the full PEM
              // string — passing the PEM straight through fails validation
              // on every call (see pemToRawBase64's own comment).
              DomainSigningPrivateKey: pemToRawBase64(kp.rawPrivateKey),
            },
          }));
        } catch (sesErr) {
          // Don't fail the API call if SES registration fails — DNS records are still useful
          // The user can retry verification which will re-check SES status
          const errMsg = sesErr instanceof Error ? sesErr.message : 'Unknown SES error';
          logger.error({ err: sesErr, domainId: domain.id, domain: name }, 'SES CreateEmailIdentity failed at domain-add time');
          await prisma.sendingDomain.update({ where: { id: domain.id }, data: { status: 'pending' } }).catch(() => {});
          void errMsg; // logged via healthcheck
        }
      }

      void logAudit(null, 'sending_domain.added', { id: apiKeyId, email: 'api', ip: (request.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? request.ip }, [{ type: 'domain', id: domain.id, name: domain.name }], apiKeyId);

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

      const { updated, health } = await verifyDomain(domain);

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

      // Remove from SES first (non-fatal if it fails — may already be removed)
      if (config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY) {
        try {
          const ses = getSesClient(domain.region);
          await ses.send(new DeleteEmailIdentityCommand({ EmailIdentity: domain.name }));
        } catch { /* ignore — domain may not be registered in SES */ }
      }

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

  // POST /v1/domains/:id/rotate-dkim
  // Generates a new DKIM key pair and returns the DNS record to publish.
  // The old key continues signing until the domain is re-verified with the new key.
  fastify.post(
    '/domains/:id/rotate-dkim',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const apiKeyId = request.apiKey.id;

      const domain = await prisma.sendingDomain.findFirst({ where: { id, apiKeyId } });
      if (!domain) throw Errors.notFound('Domain not found.');

      // Generate fresh key pair with a new time-stamped selector.
      // Was passing domain.name (public, guessable) as the encryption
      // secret instead of the real DOMAIN_KEY_SECRET — every rotated DKIM
      // private key was encrypted with a "secret" anyone could read off the
      // domain's own DNS records, and any code correctly decrypting with
      // the real secret would fail against it anyway.
      const kp = generateDkimKeyPair(getDkimSecret());

      // Update domain record — status resets to pending until DNS re-verifies
      const updated = await prisma.sendingDomain.update({
        where: { id },
        data: {
          dkimSelector:       kp.selector,
          dkimPublicKey:      kp.publicKey,
          dkimPrivateKeyEnc:  kp.privateKeyEnc,
          dkimStatus:         'pending',
        },
        select: { id: true, name: true, dkimSelector: true, dkimPublicKey: true, dkimStatus: true },
      });

      // Re-register in SES with the new BYODKIM private key
      if (config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY) {
        try {
          const ses = getSesClient(domain.region);
          await ses.send(new CreateEmailIdentityCommand({
            EmailIdentity: domain.name,
            DkimSigningAttributes: {
              DomainSigningSelector:   kp.selector,
              DomainSigningPrivateKey: pemToRawBase64(kp.rawPrivateKey),
            },
          }));
        } catch (sesErr) {
          logger.error({ err: sesErr, domainId: domain.id, domain: domain.name }, 'SES CreateEmailIdentity failed during DKIM rotation');
        }
      }

      void logAudit(
        request.apiKey.orgId ?? null,
        'sending_domain.dkim_rotated',
        { id: request.apiKey.id, email: request.apiKey.label ?? 'api-key' },
        [{ type: 'sending_domain', id: domain.id, name: domain.name }],
        apiKeyId,
      );

      const dnsHost = `${kp.selector}._domainkey.${domain.name}`;
      const dnsValue = dnsPublicKeyValue(kp.publicKey);

      return reply.status(200).send({
        ...updated,
        dnsRecord: {
          type:  'TXT',
          host:  dnsHost,
          value: dnsValue,
        },
        message: 'DKIM keys rotated. Publish the new DNS record and re-verify the domain.',
      });
    },
  );
}
