/**
 * Continuum Connectors
 *
 * Webhook intake endpoints for popular tools:
 * - Clay HTTP Enrichment: GET /v1/connectors/clay/enrich?email=xxx
 *   Clay calls this URL to enrich rows with email verification data.
 * - Clay Webhook Intake: POST /v1/connectors/clay/webhook
 *   Clay pushes lead exports here; Continuum creates leads + enrolls in sequence.
 * - Apollo Webhook: POST /v1/connectors/apollo/webhook
 *   Apollo.io contact export webhook.
 * - Generic Intake: POST /v1/connectors/webhook
 *   Any tool (Zapier, Make, n8n) can push JSON payloads here with field mapping.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { type Prisma } from '@prisma/client';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { verifyEmail } from '../../engine/index.js';
import { Errors } from '../../plugins/errorHandler.js';
import { logger } from '../../lib/logger.js';

// ─── Clay Enrichment (HTTP pull — Clay calls Continuum to enrich a row) ───────

export async function connectorRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /v1/connectors/clay/enrich?email=xxx
   * Clay's HTTP Enrichment block calls this URL per row.
   * Returns email verification data + lead info if it exists.
   */
  fastify.get(
    '/connectors/clay/enrich',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const email = String((request.query as { email?: string }).email ?? '').trim().toLowerCase();
      if (!email || !email.includes('@')) {
        throw Errors.validationFailed({ email: 'Valid email is required' });
      }

      const apiKeyId = request.apiKey.id;

      // Run verification + check for existing lead in parallel
      const [verResult, existingLead] = await Promise.all([
        verifyEmail({ email, apiKeyId, bulkJobId: undefined, sourceIp: undefined }),
        prisma.lead.findUnique({
          where: { apiKeyId_email: { apiKeyId, email } },
          select: { id: true, firstName: true, lastName: true, company: true, title: true, status: true, customVars: true },
        }),
      ]);

      // Clay expects flat key-value output for column mapping
      return reply.send({
        email,
        email_status:      verResult.status,
        email_sub_status:  verResult.subStatus,
        email_score:       verResult.score,
        email_deliverable: verResult.status === 'valid',
        mx_found:          verResult.checks.mxFound,
        smtp_checked:      verResult.checks.smtpChecked,
        is_disposable:     verResult.checks.isDisposable,
        is_role_account:   verResult.checks.isRoleAccount,
        is_catch_all:      verResult.checks.isCatchAll,
        // Lead data if previously created
        lead_id:           existingLead?.id ?? null,
        first_name:        existingLead?.firstName ?? null,
        last_name:         existingLead?.lastName ?? null,
        company:           existingLead?.company ?? null,
        title:             existingLead?.title ?? null,
        lead_status:       existingLead?.status ?? null,
      });
    },
  );

  /**
   * POST /v1/connectors/clay/webhook
   * Clay pushes lead data via webhook (after building a table).
   * Accepts Clay's standard webhook payload and creates leads in Continuum.
   *
   * Query params:
   *   sequence_id  — auto-enroll leads in this sequence
   *   verify       — if "true", verify email before creating lead
   *   skip_invalid — if "true", skip leads with invalid emails (requires verify=true)
   */
  fastify.post(
    '/connectors/clay/webhook',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query       = request.query as { sequence_id?: string; verify?: string; skip_invalid?: string };
      const sequenceId  = query.sequence_id;
      const doVerify    = query.verify === 'true';
      const skipInvalid = query.skip_invalid === 'true';

      const apiKeyId = request.apiKey.id;

      // Clay sends: { data: [{ email, firstName, lastName, company, jobTitle, ...custom }] }
      // or a flat object for single-row webhooks
      const body = request.body as { data?: unknown[]; email?: string; [k: string]: unknown };
      const rows: unknown[] = Array.isArray(body.data) ? body.data : [body];

      const clayRowSchema = z.object({
        email:      z.string().email().transform(s => s.trim().toLowerCase()),
        firstName:  z.string().max(100).optional().or(z.literal('').transform(() => undefined)),
        first_name: z.string().max(100).optional().or(z.literal('').transform(() => undefined)),
        lastName:   z.string().max(100).optional().or(z.literal('').transform(() => undefined)),
        last_name:  z.string().max(100).optional().or(z.literal('').transform(() => undefined)),
        company:    z.string().max(200).optional().or(z.literal('').transform(() => undefined)),
        companyName:z.string().max(200).optional().or(z.literal('').transform(() => undefined)),
        jobTitle:   z.string().max(200).optional().or(z.literal('').transform(() => undefined)),
        title:      z.string().max(200).optional().or(z.literal('').transform(() => undefined)),
      }).passthrough();

      const results: Array<{ email: string; status: 'created' | 'skipped' | 'error'; reason?: string }> = [];

      for (const row of rows) {
        const parsed = clayRowSchema.safeParse(row);
        if (!parsed.success) {
          const email = String((row as { email?: string }).email ?? 'unknown');
          results.push({ email, status: 'error', reason: 'invalid row schema' });
          continue;
        }

        const d = parsed.data;
        const email    = d.email;
        const firstName = d.firstName ?? d.first_name;
        const lastName  = d.lastName  ?? d.last_name;
        const company   = d.company   ?? d.companyName;
        const title     = d.jobTitle  ?? d.title;

        // Extract custom variables (everything not in the base schema)
        const customVars: Record<string, unknown> = {};
        const baseKeys = new Set(['email','firstName','first_name','lastName','last_name','company','companyName','jobTitle','title']);
        for (const [k, v] of Object.entries(d)) {
          if (!baseKeys.has(k) && v !== undefined && v !== null && v !== '') {
            customVars[k] = v;
          }
        }

        if (doVerify) {
          const verResult = await verifyEmail({ email, apiKeyId, bulkJobId: undefined, sourceIp: undefined });
          if (skipInvalid && verResult.status === 'invalid') {
            results.push({ email, status: 'skipped', reason: `invalid email: ${verResult.subStatus ?? 'unknown'}` });
            continue;
          }
          customVars['_email_status'] = verResult.status;
          customVars['_email_score']  = verResult.score;
        }

        try {
          const lead = await prisma.lead.upsert({
            where:  { apiKeyId_email: { apiKeyId, email } },
            create: { apiKeyId, email, firstName: firstName ?? null, lastName: lastName ?? null, company: company ?? null, title: title ?? null, customVars: customVars as Prisma.InputJsonValue },
            update: {
              ...(firstName ? { firstName } : {}),
              ...(lastName  ? { lastName }  : {}),
              ...(company   ? { company }   : {}),
              ...(title     ? { title }     : {}),
              customVars: customVars as Prisma.InputJsonValue,
            },
          });

          if (sequenceId) {
            const seq = await prisma.sequence.findFirst({ where: { id: sequenceId, apiKeyId } });
            if (seq) {
              await prisma.sequenceEnrollment.upsert({
                where: { sequenceId_email: { sequenceId, email } },
                create: { sequenceId, email, status: 'active', nextSendAt: new Date(), variables: customVars as Prisma.InputJsonValue },
                update: {},
              });
            }
          }

          results.push({ email: lead.email, status: 'created' });
        } catch (err) {
          logger.warn({ email, err }, 'Clay connector: failed to create lead');
          results.push({ email, status: 'error', reason: err instanceof Error ? err.message : 'unknown error' });
        }
      }

      return reply.send({
        processed: rows.length,
        created:  results.filter(r => r.status === 'created').length,
        skipped:  results.filter(r => r.status === 'skipped').length,
        errors:   results.filter(r => r.status === 'error').length,
        results,
      });
    },
  );

  /**
   * POST /v1/connectors/apollo/webhook
   * Apollo.io contact export webhook.
   * Apollo sends: { contacts: [{ email, first_name, last_name, organization_name, title, ... }] }
   */
  fastify.post(
    '/connectors/apollo/webhook',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query      = request.query as { sequence_id?: string };
      const sequenceId = query.sequence_id;
      const apiKeyId   = request.apiKey.id;

      const body     = request.body as { contacts?: unknown[] };
      const contacts = Array.isArray(body.contacts) ? body.contacts : [body];

      const apolloSchema = z.object({
        email:             z.string().email().transform(s => s.trim().toLowerCase()),
        first_name:        z.string().optional(),
        last_name:         z.string().optional(),
        organization_name: z.string().optional(),
        title:             z.string().optional(),
        phone_number:      z.string().optional(),
        linkedin_url:      z.string().optional(),
        city:              z.string().optional(),
        country:           z.string().optional(),
      }).passthrough();

      const results: Array<{ email: string; status: 'created' | 'error' }> = [];

      for (const contact of contacts) {
        const parsed = apolloSchema.safeParse(contact);
        if (!parsed.success) {
          results.push({ email: String((contact as { email?: string }).email ?? ''), status: 'error' });
          continue;
        }

        const d = parsed.data;
        const customVars: Record<string, unknown> = {};
        if (d.phone_number) customVars['phone']    = d.phone_number;
        if (d.linkedin_url) customVars['linkedin'] = d.linkedin_url;
        if (d.city)         customVars['city']     = d.city;
        if (d.country)      customVars['country']  = d.country;

        try {
          const lead = await prisma.lead.upsert({
            where:  { apiKeyId_email: { apiKeyId, email: d.email } },
            create: { apiKeyId, email: d.email, firstName: d.first_name ?? null, lastName: d.last_name ?? null, company: d.organization_name ?? null, title: d.title ?? null, customVars: customVars as Prisma.InputJsonValue },
            update: {
              ...(d.first_name        ? { firstName: d.first_name }         : {}),
              ...(d.last_name         ? { lastName:  d.last_name }          : {}),
              ...(d.organization_name ? { company:   d.organization_name }  : {}),
              ...(d.title             ? { title:     d.title }              : {}),
              customVars: customVars as Prisma.InputJsonValue,
            },
          });

          if (sequenceId) {
            await prisma.sequenceEnrollment.upsert({
              where: { sequenceId_email: { sequenceId, email: lead.email } },
              create: { sequenceId, email: lead.email, status: 'active', nextSendAt: new Date() },
              update: {},
            });
          }

          results.push({ email: lead.email, status: 'created' });
        } catch {
          results.push({ email: d.email, status: 'error' });
        }
      }

      return reply.send({ processed: contacts.length, created: results.filter(r => r.status === 'created').length, results });
    },
  );

  /**
   * POST /v1/connectors/webhook
   * Generic connector for Zapier, Make, n8n, or any custom source.
   *
   * Body: { rows: object[], field_map: { email, first_name?, last_name?, company?, title? }, action: "create_lead"|"subscribe", sequence_id?, list_id? }
   * field_map maps from incoming payload fields to Continuum fields.
   */
  fastify.post(
    '/connectors/webhook',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const genericSchema = z.object({
        rows: z.array(z.record(z.unknown())).min(1).max(500),
        field_map: z.object({
          email:      z.string(),
          first_name: z.string().optional(),
          last_name:  z.string().optional(),
          company:    z.string().optional(),
          title:      z.string().optional(),
        }),
        action:      z.enum(['create_lead', 'subscribe']).default('create_lead'),
        sequence_id: z.string().optional(),
        list_id:     z.string().optional(),
      });

      const parsed = genericSchema.safeParse(request.body);
      if (!parsed.success) {
        throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));
      }

      const { rows, field_map, action, sequence_id, list_id } = parsed.data;
      const apiKeyId = request.apiKey.id;
      let created = 0;
      let errors  = 0;

      for (const row of rows) {
        const email = String(row[field_map.email] ?? '').trim().toLowerCase();
        if (!email || !email.includes('@')) { errors++; continue; }

        const firstName = field_map.first_name ? String(row[field_map.first_name] ?? '') || null : null;
        const lastName  = field_map.last_name  ? String(row[field_map.last_name]  ?? '') || null : null;
        const company   = field_map.company    ? String(row[field_map.company]    ?? '') || null : null;
        const title     = field_map.title      ? String(row[field_map.title]      ?? '') || null : null;

        // Remaining fields become custom variables
        const mapped = new Set(Object.values(field_map).filter(Boolean));
        const customVars: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row)) {
          if (!mapped.has(k) && v !== undefined && v !== null) customVars[k] = v;
        }

        try {
          if (action === 'create_lead') {
            const lead = await prisma.lead.upsert({
              where:  { apiKeyId_email: { apiKeyId, email } },
              create: { apiKeyId, email, firstName, lastName, company, title, customVars: customVars as Prisma.InputJsonValue },
              update: { ...(firstName ? { firstName } : {}), ...(lastName ? { lastName } : {}), ...(company ? { company } : {}), ...(title ? { title } : {}), customVars: customVars as Prisma.InputJsonValue },
            });

            if (sequence_id) {
              await prisma.sequenceEnrollment.upsert({
                where:  { sequenceId_email: { sequenceId: sequence_id, email: lead.email } },
                create: { sequenceId: sequence_id, email: lead.email, status: 'active', nextSendAt: new Date(), variables: customVars as Prisma.InputJsonValue },
                update: {},
              });
            }
          } else if (action === 'subscribe' && list_id) {
            const contact = await prisma.contact.upsert({
              where:  { apiKeyId_email: { apiKeyId, email } },
              create: { apiKeyId, email, firstName, lastName, customFields: customVars as Prisma.InputJsonValue },
              update: {},
              select: { id: true },
            });
            await prisma.contactListMembership.upsert({
              where:  { contactId_listId: { contactId: contact.id, listId: list_id } },
              create: { contactId: contact.id, listId: list_id, status: 'subscribed' },
              update: { status: 'subscribed', unsubscribedAt: null },
            });
          }
          created++;
        } catch {
          errors++;
        }
      }

      return reply.send({ processed: rows.length, created, errors });
    },
  );

  /**
   * GET /v1/connectors
   * List available connectors and their webhook URLs.
   */
  fastify.get(
    '/connectors',
    { preHandler: [requireAuth, requireRateLimit] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.send({
        connectors: [
          {
            id: 'clay',
            name: 'Clay',
            description: 'Enrich Clay rows with email verification, or push Clay exports as leads',
            endpoints: {
              enrichment:  'GET /v1/connectors/clay/enrich?email={{email}}',
              webhook:     'POST /v1/connectors/clay/webhook?sequence_id=SEQ_ID&verify=true',
            },
            docs: 'https://continuumapi.com/docs',
          },
          {
            id: 'apollo',
            name: 'Apollo.io',
            description: 'Push Apollo contact exports into Continuum sequences',
            endpoints: {
              webhook: 'POST /v1/connectors/apollo/webhook?sequence_id=SEQ_ID',
            },
            docs: 'https://continuumapi.com/docs',
          },
          {
            id: 'generic',
            name: 'Generic Webhook (Zapier / Make / n8n)',
            description: 'Push any JSON payload with custom field mapping',
            endpoints: {
              webhook: 'POST /v1/connectors/webhook',
            },
            docs: 'https://continuumapi.com/docs',
          },
          {
            id: 'mcp',
            name: 'MCP (Model Context Protocol)',
            description: 'Use Continuum as AI tools in Claude, Cursor, and other MCP clients',
            endpoints: {
              mcp: 'POST /mcp',
            },
            docs: 'https://continuumapi.com/docs',
          },
        ],
      });
    },
  );
}
