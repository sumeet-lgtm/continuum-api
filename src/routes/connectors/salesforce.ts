import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Prisma } from '@prisma/client';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../plugins/errorHandler.js';
import { encryptValue, decryptValue } from '../../lib/crypto.js';
import { config } from '../../config.js';
import { signOAuthState, verifyOAuthState } from '../../lib/oauth/state.js';
import { isSalesforceOAuthConfigured, getSalesforceAuthUrl, exchangeSalesforceCode, getSalesforceAccessToken } from '../../lib/oauth/salesforce.js';
import { testConnection, type SalesforceFieldMapping } from '../../lib/salesforceApi.js';
import { logger } from '../../lib/logger.js';

const VALID_BUILTIN_SOURCES = new Set(['firstName', 'lastName', 'company', 'title', 'tags']);

function validateFieldMappings(input: unknown): SalesforceFieldMapping[] {
  if (!Array.isArray(input)) throw Errors.validationFailed({ field_mappings: 'Must be an array' });
  return input.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw Errors.validationFailed({ field_mappings: `Entry ${i} must be an object` });
    }
    const { source, target } = entry as { source?: unknown; target?: unknown };
    if (typeof source !== 'string' || typeof target !== 'string' || !source.trim() || !target.trim()) {
      throw Errors.validationFailed({ field_mappings: `Entry ${i} needs a non-empty "source" and "target"` });
    }
    if (!VALID_BUILTIN_SOURCES.has(source) && !source.startsWith('customVars.')) {
      throw Errors.validationFailed({
        field_mappings: `Entry ${i}: "source" must be one of firstName/lastName/company/title/tags, or "customVars.<key>"`,
      });
    }
    return { source, target: target.trim() } as SalesforceFieldMapping;
  });
}

function getSecret(): string {
  return config.MAILBOX_CREDS_SECRET ?? config.API_KEY_SALT;
}

export async function salesforceConnectorRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /v1/connectors/salesforce/oauth/start — authenticated; returns the
  // Salesforce login/consent URL for the dashboard to redirect to.
  fastify.get('/connectors/salesforce/oauth/start', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isSalesforceOAuthConfigured()) {
      throw Errors.validationFailed({ salesforce: 'Salesforce connect is not configured on this deployment yet.' });
    }
    const state = signOAuthState(request.apiKey.id);
    return reply.status(200).send({ url: getSalesforceAuthUrl(state) });
  });

  // GET /v1/connectors/salesforce/oauth/callback — public; hit directly by
  // Salesforce with only ?code&state, no auth header. Identity comes from
  // the signed state (see mailboxes/index.ts for the same pattern).
  fastify.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/connectors/salesforce/oauth/callback',
    async (request: FastifyRequest<{ Querystring: { code?: string; state?: string; error?: string } }>, reply: FastifyReply) => {
      const { code, state, error } = request.query;
      const dashboardUrl = `${config.DASHBOARD_URL}/dashboard/salesforce`;

      if (error) return reply.redirect(`${dashboardUrl}?oauth_error=${encodeURIComponent(error)}`);
      if (!code || !state) return reply.redirect(`${dashboardUrl}?oauth_error=missing_code`);

      const verified = verifyOAuthState(state);
      if (!verified) return reply.redirect(`${dashboardUrl}?oauth_error=invalid_or_expired_state`);

      try {
        const { refreshToken, instanceUrl, orgId, email } = await exchangeSalesforceCode(code);
        const refreshTokenEnc = encryptValue(refreshToken, getSecret());

        await prisma.salesforceConnection.upsert({
          where: { apiKeyId: verified.apiKeyId },
          create: { apiKeyId: verified.apiKeyId, instanceUrl, refreshTokenEnc, orgId, connectedEmail: email, syncEnabled: true },
          update: { instanceUrl, refreshTokenEnc, orgId, connectedEmail: email, syncEnabled: true, lastErrorMsg: null },
        });

        return reply.redirect(`${dashboardUrl}?connected=salesforce`);
      } catch (err) {
        logger.error({ err }, 'Salesforce OAuth connect failed');
        return reply.redirect(`${dashboardUrl}?oauth_error=connect_failed`);
      }
    },
  );

  // GET /v1/connectors/salesforce — connection status
  fastify.get('/connectors/salesforce', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const conn = await prisma.salesforceConnection.findUnique({
      where: { apiKeyId: request.apiKey.id },
      select: { instanceUrl: true, orgId: true, connectedEmail: true, syncEnabled: true, fieldMappings: true, lastPushedAt: true, lastPulledAt: true, lastErrorMsg: true, createdAt: true },
    });
    if (!conn) return reply.status(200).send({ connected: false });

    const syncedCount = await prisma.salesforceLeadSync.count({ where: { apiKeyId: request.apiKey.id } });
    return reply.status(200).send({ connected: true, ...conn, syncedLeadCount: syncedCount });
  });

  // GET /v1/connectors/salesforce/field-mapping — current custom field mappings
  fastify.get('/connectors/salesforce/field-mapping', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const conn = await prisma.salesforceConnection.findUnique({
      where: { apiKeyId: request.apiKey.id },
      select: { fieldMappings: true },
    });
    if (!conn) throw Errors.notFound('Salesforce connection');
    return reply.status(200).send({ field_mappings: conn.fieldMappings ?? [] });
  });

  // PUT /v1/connectors/salesforce/field-mapping — replace the mapping list.
  // Each entry: { source: "firstName"|"lastName"|"company"|"title"|"tags"|
  // "customVars.<key>", target: "<Salesforce field API name>" }. A mapped
  // built-in overrides its default standard field UNLESS it's LastName or
  // Company (Salesforce requires both on every Lead, so those get the
  // custom field in addition, never instead) — see applyFieldMappings.
  fastify.put('/connectors/salesforce/field-mapping', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { field_mappings?: unknown };
    const mappings = validateFieldMappings(body.field_mappings ?? []);

    const conn = await prisma.salesforceConnection.findUnique({ where: { apiKeyId: request.apiKey.id } });
    if (!conn) throw Errors.notFound('Salesforce connection');

    await prisma.salesforceConnection.update({
      where: { apiKeyId: request.apiKey.id },
      data: { fieldMappings: mappings as unknown as Prisma.InputJsonValue },
    });
    return reply.status(200).send({ field_mappings: mappings });
  });

  // PATCH /v1/connectors/salesforce — toggle sync on/off without disconnecting
  fastify.patch('/connectors/salesforce', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { sync_enabled?: boolean };
    const conn = await prisma.salesforceConnection.findUnique({ where: { apiKeyId: request.apiKey.id } });
    if (!conn) throw Errors.notFound('Salesforce connection');
    if (body.sync_enabled === undefined) throw Errors.validationFailed({ sync_enabled: 'sync_enabled is required' });

    await prisma.salesforceConnection.update({ where: { apiKeyId: request.apiKey.id }, data: { syncEnabled: body.sync_enabled } });
    return reply.status(200).send({ updated: true });
  });

  // DELETE /v1/connectors/salesforce — disconnect (keeps the lead-sync
  // history rows so reconnecting doesn't re-create duplicate SFDC records)
  fastify.delete('/connectors/salesforce', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    await prisma.salesforceConnection.delete({ where: { apiKeyId: request.apiKey.id } }).catch(() => {});
    return reply.status(200).send({ disconnected: true });
  });

  // POST /v1/connectors/salesforce/test — verify the stored refresh token
  // still works, same shape as the mailbox test-connection endpoint.
  fastify.post('/connectors/salesforce/test', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const conn = await prisma.salesforceConnection.findUnique({ where: { apiKeyId: request.apiKey.id } });
    if (!conn) throw Errors.notFound('Salesforce connection');

    try {
      const refreshToken = decryptValue(conn.refreshTokenEnc, getSecret());
      const accessToken = await getSalesforceAccessToken(refreshToken);
      const ok = await testConnection(conn.instanceUrl, accessToken);
      await prisma.salesforceConnection.update({
        where: { apiKeyId: request.apiKey.id },
        data: { lastErrorMsg: ok ? null : 'Connection test failed' },
      });
      return reply.status(200).send({ ok });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection test failed';
      await prisma.salesforceConnection.update({ where: { apiKeyId: request.apiKey.id }, data: { lastErrorMsg: message } });
      return reply.status(200).send({ ok: false, error: message });
    }
  });
}
