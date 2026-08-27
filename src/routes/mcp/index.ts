/**
 * Continuum MCP Server — Streamable HTTP (Model Context Protocol)
 *
 * Exposes Continuum's capabilities as MCP tools so any MCP-compatible AI
 * (Claude, Cursor, etc.) can verify emails, enroll leads, send emails, etc.
 *
 * Auth: API key via Authorization: Bearer <key> header (same as REST API)
 * Endpoint: POST /mcp
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { type Prisma } from '@prisma/client';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { verifyEmail } from '../../engine/index.js';
import { Errors } from '../../plugins/errorHandler.js';
import { logger } from '../../lib/logger.js';
import { config } from '../../config.js';

const SERVER_INFO = {
  name: 'continuum-api',
  version: '1.0.0',
};

const CAPABILITIES = {
  tools: {},
};

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'verify_email',
    description: 'Verify whether an email address is deliverable. Returns status (valid/invalid/risky/unknown), MX records, SMTP reachability, and a quality score.',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Email address to verify' },
      },
      required: ['email'],
    },
  },
  {
    name: 'send_email',
    description: 'Send a transactional email via AWS SES.',
    inputSchema: {
      type: 'object',
      properties: {
        to:      { type: 'string', description: 'Recipient email address' },
        from:    { type: 'string', description: 'Sender email address (must be verified in SES)' },
        subject: { type: 'string', description: 'Email subject line' },
        html:    { type: 'string', description: 'HTML body content' },
        text:    { type: 'string', description: 'Plain text body content (optional)' },
      },
      required: ['to', 'from', 'subject', 'html'],
    },
  },
  {
    name: 'create_lead',
    description: 'Create or update a lead in Continuum for cold outreach.',
    inputSchema: {
      type: 'object',
      properties: {
        email:       { type: 'string', description: 'Lead email address' },
        first_name:  { type: 'string', description: 'First name' },
        last_name:   { type: 'string', description: 'Last name' },
        company:     { type: 'string', description: 'Company name' },
        title:       { type: 'string', description: 'Job title' },
        sequence_id: { type: 'string', description: 'Sequence ID to auto-enroll the lead in' },
        custom_variables: {
          type: 'object',
          description: 'Custom key-value pairs for personalization in sequences',
        },
      },
      required: ['email'],
    },
  },
  {
    name: 'enroll_lead_in_sequence',
    description: 'Enroll an email address in an outreach sequence.',
    inputSchema: {
      type: 'object',
      properties: {
        email:       { type: 'string', description: 'Lead email address' },
        sequence_id: { type: 'string', description: 'Sequence ID to enroll the lead in' },
        variables:   { type: 'object', description: 'Personalization variables for this enrollment' },
      },
      required: ['email', 'sequence_id'],
    },
  },
  {
    name: 'get_sequence_stats',
    description: 'Get statistics for a sequence including open rates, reply rates, and enrollment counts.',
    inputSchema: {
      type: 'object',
      properties: {
        sequence_id: { type: 'string', description: 'Sequence ID' },
      },
      required: ['sequence_id'],
    },
  },
  {
    name: 'list_sequences',
    description: 'List all active outreach sequences in your account.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'paused', 'archived'], description: 'Filter by status' },
      },
    },
  },
  {
    name: 'get_campaign_stats',
    description: 'Get statistics for a newsletter/broadcast campaign.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', description: 'Campaign ID' },
      },
      required: ['campaign_id'],
    },
  },
  {
    name: 'add_contact_to_list',
    description: 'Subscribe a contact to a mailing list for newsletter campaigns.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id:    { type: 'string', description: 'Mailing list ID' },
        email:      { type: 'string', description: 'Contact email address' },
        first_name: { type: 'string', description: 'First name' },
        last_name:  { type: 'string', description: 'Last name' },
        custom_fields: { type: 'object', description: 'Custom fields for this contact' },
      },
      required: ['list_id', 'email'],
    },
  },
  {
    name: 'check_suppression',
    description: 'Check if an email address is on the suppression list (bounced/unsubscribed/complained).',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Email address to check' },
      },
      required: ['email'],
    },
  },
  {
    name: 'get_account_usage',
    description: 'Get current account usage: verifications used, sends used, monthly limits and reset dates.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
] as const;

// ─── Tool Handlers ─────────────────────────────────────────────────────────────

async function callTool(
  toolName: string,
  args: Record<string, unknown>,
  apiKey: { id: string; currentMonthUsage: number; monthlyLimit: number; currentMonthSendUsage: number; monthlySendLimit: number },
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const apiKeyId = apiKey.id;

  const text = (obj: unknown) => [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }];

  switch (toolName) {
    case 'verify_email': {
      const email = String(args['email'] ?? '');
      const result = await verifyEmail({ email, apiKeyId, bulkJobId: undefined, sourceIp: undefined });
      return { content: text(result) };
    }

    case 'send_email': {
      const sesClient = new SESv2Client({
        region: config.AWS_REGION ?? 'us-east-1',
        ...(config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY
          ? { credentials: { accessKeyId: config.AWS_ACCESS_KEY_ID, secretAccessKey: config.AWS_SECRET_ACCESS_KEY } }
          : {}),
      });
      const cmd = new SendEmailCommand({
        FromEmailAddress: String(args['from']),
        Destination: { ToAddresses: [String(args['to'])] },
        Content: {
          Simple: {
            Subject: { Data: String(args['subject']), Charset: 'UTF-8' },
            Body: {
              Html: { Data: String(args['html']), Charset: 'UTF-8' },
              ...(args['text'] ? { Text: { Data: String(args['text']), Charset: 'UTF-8' } } : {}),
            },
          },
        },
      });
      const res = await sesClient.send(cmd);
      await prisma.sendMessage.create({
        data: {
          apiKeyId,
          to:           String(args['to']),
          from:         String(args['from']),
          subject:      String(args['subject']),
          status:       'sent',
          sesMessageId: res.MessageId ?? null,
          cc: [], bcc: [],
        },
      });
      return { content: text({ sent: true, message_id: res.MessageId }) };
    }

    case 'create_lead': {
      const email = String(args['email'] ?? '').trim().toLowerCase();
      const lead = await prisma.lead.upsert({
        where: { apiKeyId_email: { apiKeyId, email } },
        create: {
          apiKeyId, email,
          firstName: args['first_name'] ? String(args['first_name']) : null,
          lastName:  args['last_name']  ? String(args['last_name'])  : null,
          company:   args['company']    ? String(args['company'])    : null,
          title:     args['title']      ? String(args['title'])      : null,
          customVars: (args['custom_variables'] ?? {}) as Prisma.InputJsonValue,
        },
        update: {
          ...(args['first_name'] ? { firstName: String(args['first_name']) } : {}),
          ...(args['last_name']  ? { lastName:  String(args['last_name'])  } : {}),
          ...(args['company']    ? { company:   String(args['company'])    } : {}),
          ...(args['title']      ? { title:     String(args['title'])      } : {}),
          ...(args['custom_variables'] ? { customVars: args['custom_variables'] as Prisma.InputJsonValue } : {}),
        },
        select: { id: true, email: true, firstName: true, lastName: true, company: true, status: true },
      });

      if (args['sequence_id']) {
        const seqId = String(args['sequence_id']);
        const seq = await prisma.sequence.findFirst({ where: { id: seqId, apiKeyId } });
        if (seq) {
          await prisma.sequenceEnrollment.upsert({
            where: { sequenceId_email: { sequenceId: seqId, email } },
            create: { sequenceId: seqId, email, status: 'active', nextSendAt: new Date() },
            update: {},
          });
        }
      }

      return { content: text(lead) };
    }

    case 'enroll_lead_in_sequence': {
      const email = String(args['email'] ?? '').trim().toLowerCase();
      const seqId = String(args['sequence_id'] ?? '');
      const seq = await prisma.sequence.findFirst({ where: { id: seqId, apiKeyId } });
      if (!seq) throw Errors.notFound('sequence');
      const enrollment = await prisma.sequenceEnrollment.upsert({
        where: { sequenceId_email: { sequenceId: seqId, email } },
        create: { sequenceId: seqId, email, status: 'active', nextSendAt: new Date(), ...(args['variables'] ? { variables: args['variables'] as Prisma.InputJsonValue } : {}) },
        update: { status: 'active', nextSendAt: new Date() },
        select: { id: true, email: true, status: true, currentStep: true, nextSendAt: true },
      });
      return { content: text(enrollment) };
    }

    case 'get_sequence_stats': {
      const seqId = String(args['sequence_id'] ?? '');
      const [seq, stats] = await Promise.all([
        prisma.sequence.findFirst({ where: { id: seqId, apiKeyId }, select: { id: true, name: true, status: true } }),
        prisma.sequenceEnrollment.groupBy({
          by: ['status'],
          where: { sequenceId: seqId },
          _count: { status: true },
        }),
      ]);
      if (!seq) throw Errors.notFound('sequence');
      const counts = Object.fromEntries(stats.map(s => [s.status, s._count.status]));
      return { content: text({ ...seq, enrollments: counts }) };
    }

    case 'list_sequences': {
      const status = args['status'] ? String(args['status']) : undefined;
      const sequences = await prisma.sequence.findMany({
        where: { apiKeyId, ...(status ? { status } : {}) },
        select: { id: true, name: true, status: true, fromEmail: true, stopOnReply: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      return { content: text(sequences) };
    }

    case 'get_campaign_stats': {
      const campaignId = String(args['campaign_id'] ?? '');
      const campaign = await prisma.campaign.findFirst({
        where: { id: campaignId, apiKeyId },
        select: { id: true, subject: true, status: true, totalRecipients: true, sentCount: true, openCount: true, clickCount: true, bounceCount: true, complaintCount: true, sentAt: true },
      });
      if (!campaign) throw Errors.notFound('campaign');
      const openRate  = campaign.sentCount > 0 ? (campaign.openCount / campaign.sentCount * 100).toFixed(1) : '0';
      const clickRate = campaign.sentCount > 0 ? (campaign.clickCount / campaign.sentCount * 100).toFixed(1) : '0';
      return { content: text({ ...campaign, open_rate: `${openRate}%`, click_rate: `${clickRate}%` }) };
    }

    case 'add_contact_to_list': {
      const email   = String(args['email'] ?? '').trim().toLowerCase();
      const listId  = String(args['list_id'] ?? '');
      const suppressed = await prisma.suppression.findUnique({ where: { email } });
      if (suppressed) return { content: text({ error: 'Email is suppressed', reason: suppressed.reason }) };

      const contact = await prisma.contact.upsert({
        where: { apiKeyId_email: { apiKeyId, email } },
        create: { apiKeyId, email, firstName: args['first_name'] ? String(args['first_name']) : null, lastName: args['last_name'] ? String(args['last_name']) : null, ...(args['custom_fields'] ? { customFields: args['custom_fields'] as Prisma.InputJsonValue } : {}) },
        update: {},
        select: { id: true },
      });
      await prisma.contactListMembership.upsert({
        where: { contactId_listId: { contactId: contact.id, listId } },
        create: { contactId: contact.id, listId, status: 'subscribed' },
        update: { status: 'subscribed', unsubscribedAt: null },
      });
      await prisma.mailingList.update({ where: { id: listId }, data: { contactCount: { increment: 1 } } }).catch(() => {});
      return { content: text({ subscribed: true, email, list_id: listId }) };
    }

    case 'check_suppression': {
      const email = String(args['email'] ?? '').trim().toLowerCase();
      const record = await prisma.suppression.findUnique({ where: { email } });
      return { content: text({ email, suppressed: !!record, reason: record?.reason ?? null, suppressed_at: record?.createdAt ?? null }) };
    }

    case 'get_account_usage': {
      return {
        content: text({
          verifications: { used: apiKey.currentMonthUsage, limit: apiKey.monthlyLimit },
          sends:         { used: apiKey.currentMonthSendUsage, limit: apiKey.monthlySendLimit },
        }),
      };
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function mcpRoutes(fastify: FastifyInstance): Promise<void> {
  // MCP discovery endpoint
  fastify.get('/mcp', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send({
      name: SERVER_INFO.name,
      version: SERVER_INFO.version,
      description: 'Continuum API — email verification, sending, sequences, and campaigns',
      mcp_endpoint: '/mcp',
      auth: 'Bearer <continuum-api-key>',
      tools: TOOLS.map(t => t.name),
    });
  });

  // MCP JSON-RPC endpoint
  fastify.post('/mcp', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      jsonrpc?: string;
      id?: string | number | null;
      method?: string;
      params?: Record<string, unknown>;
    };

    if (body.jsonrpc !== '2.0') {
      return reply.status(400).send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' } });
    }

    const { id, method, params } = body;

    const respond = (result: unknown) => reply.send({ jsonrpc: '2.0', id: id ?? null, result });
    const respondError = (code: number, message: string, data?: unknown) =>
      reply.send({ jsonrpc: '2.0', id: id ?? null, error: { code, message, data } });

    try {
      switch (method) {
        case 'initialize':
          return respond({
            protocolVersion: '2024-11-05',
            capabilities: CAPABILITIES,
            serverInfo: SERVER_INFO,
          });

        case 'notifications/initialized':
          return reply.status(204).send();

        case 'ping':
          return respond({});

        case 'tools/list':
          return respond({ tools: TOOLS });

        case 'tools/call': {
          const toolName = String((params as { name?: string })?.name ?? '');
          const args     = ((params as { arguments?: Record<string, unknown> })?.arguments ?? {}) as Record<string, unknown>;

          if (!toolName) return respondError(-32602, 'Invalid params: name is required');

          const toolExists = TOOLS.some(t => t.name === toolName);
          if (!toolExists) return respondError(-32602, `Unknown tool: ${toolName}`);

          logger.info({ toolName, apiKeyId: request.apiKey.id }, 'MCP tool call');

          const result = await callTool(toolName, args, request.apiKey as Parameters<typeof callTool>[2]);
          return respond(result);
        }

        case 'resources/list':
          return respond({ resources: [] });

        case 'prompts/list':
          return respond({ prompts: [] });

        default:
          return respondError(-32601, `Method not found: ${method}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ method, err: msg }, 'MCP tool error');
      return respondError(-32603, `Internal error: ${msg}`);
    }
  });
}
