/**
 * Payment & CRM connector webhook handlers
 *
 * Stripe:    POST /v1/connectors/stripe/webhook
 * Chargebee: POST /v1/connectors/chargebee/webhook
 * Razorpay:  POST /v1/connectors/razorpay/webhook
 * Paddle:    POST /v1/connectors/paddle/webhook
 * HubSpot:   POST /v1/connectors/hubspot/webhook
 *
 * Rules CRUD:
 *   GET  /v1/connectors/rules          — list rules for this key
 *   POST /v1/connectors/rules          — create/update a rule
 *   DELETE /v1/connectors/rules/:id    — delete a rule
 *
 * Secrets CRUD:
 *   GET  /v1/connectors/secrets        — list connectors with secret status
 *   POST /v1/connectors/secrets        — set signing secret for a connector
 *   DELETE /v1/connectors/secrets/:connector — remove secret
 *
 * Event log:
 *   GET  /v1/connectors/events         — recent connector events
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createHmac, timingSafeEqual } from 'crypto';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';

// ─── Normalised event schema ──────────────────────────────────────────────────

interface NormalizedEvent {
  event_type:     string;   // e.g. "payment.succeeded"
  customer_email: string | null;
  customer_name:  string | null;
  amount:         number | null;   // in minor units (cents/paise)
  currency:       string | null;
  invoice_id:     string | null;
  subscription_id: string | null;
  metadata:       Record<string, unknown>;
}

// ─── Stripe ──────────────────────────────────────────────────────────────────

function normalizeStripe(body: Record<string, unknown>): NormalizedEvent {
  const type = String(body.type ?? '');
  const obj  = (body.data as Record<string, unknown>)?.object as Record<string, unknown> ?? {};

  const emailFromCustomer = (obj.customer_email as string) ?? null;
  const emailFromReceipt  = (obj.receipt_email as string) ?? null;
  const emailFromBilling  = ((obj.billing_details as Record<string, unknown>)?.email as string) ?? null;
  const customer_email    = emailFromCustomer ?? emailFromReceipt ?? emailFromBilling;
  const customer_name     = (obj.billing_details as Record<string, unknown>)?.name as string ?? null;

  const amount   = typeof obj.amount === 'number' ? obj.amount : typeof obj.amount_paid === 'number' ? obj.amount_paid : null;
  const currency = (obj.currency as string ?? null)?.toUpperCase() ?? null;

  const eventMap: Record<string, string> = {
    'payment_intent.succeeded': 'payment.succeeded',
    'payment_intent.payment_failed': 'payment.failed',
    'invoice.paid': 'invoice.paid',
    'invoice.payment_failed': 'invoice.payment_failed',
    'customer.subscription.created': 'subscription.created',
    'customer.subscription.updated': 'subscription.updated',
    'customer.subscription.deleted': 'subscription.cancelled',
    'checkout.session.completed': 'payment.succeeded',
  };

  return {
    event_type:      eventMap[type] ?? type,
    customer_email,
    customer_name,
    amount,
    currency,
    invoice_id:      (obj.id as string) ?? null,
    subscription_id: (obj.subscription as string) ?? null,
    metadata:        { source: 'stripe', stripe_event_type: type, stripe_id: body.id },
  };
}

// ─── Chargebee ───────────────────────────────────────────────────────────────

function normalizeChargebee(body: Record<string, unknown>): NormalizedEvent {
  const type    = String(body.event_type ?? '');
  const content = body.content as Record<string, unknown> ?? {};
  const inv     = (content.invoice ?? content.subscription ?? {}) as Record<string, unknown>;
  const cust    = content.customer as Record<string, unknown> ?? {};

  const eventMap: Record<string, string> = {
    'payment_succeeded':         'payment.succeeded',
    'payment_failed':            'payment.failed',
    'subscription_created':      'subscription.created',
    'subscription_renewed':      'invoice.paid',
    'subscription_cancelled':    'subscription.cancelled',
    'subscription_reactivated':  'subscription.reactivated',
    'invoice_generated':         'invoice.created',
  };

  return {
    event_type:      eventMap[type] ?? type,
    customer_email:  (cust.email as string) ?? null,
    customer_name:   (cust.first_name ? `${cust.first_name} ${cust.last_name ?? ''}`.trim() : null),
    amount:          typeof inv.amount_paid === 'number' ? inv.amount_paid : typeof inv.total === 'number' ? inv.total : null,
    currency:        (inv.currency_code as string ?? null),
    invoice_id:      (inv.id as string) ?? null,
    subscription_id: (inv.subscription_id as string) ?? null,
    metadata:        { source: 'chargebee', chargebee_event_type: type },
  };
}

// ─── Razorpay ────────────────────────────────────────────────────────────────

function normalizeRazorpay(body: Record<string, unknown>): NormalizedEvent {
  const type    = String(body.event ?? '');
  const payload = body.payload as Record<string, unknown> ?? {};
  const payment = (payload.payment as Record<string, unknown>)?.entity as Record<string, unknown> ?? {};
  const sub     = (payload.subscription as Record<string, unknown>)?.entity as Record<string, unknown> ?? {};

  const eventMap: Record<string, string> = {
    'payment.captured': 'payment.succeeded',
    'payment.failed':   'payment.failed',
    'subscription.activated': 'subscription.created',
    'subscription.charged':   'invoice.paid',
    'subscription.cancelled': 'subscription.cancelled',
    'subscription.completed': 'subscription.cancelled',
  };

  return {
    event_type:      eventMap[type] ?? type,
    customer_email:  (payment.email as string) ?? null,
    customer_name:   (payment.name  as string) ?? null,
    amount:          typeof payment.amount === 'number' ? payment.amount : null,
    currency:        (payment.currency as string ?? null),
    invoice_id:      (payment.id as string) ?? null,
    subscription_id: (sub.id as string) ?? null,
    metadata:        { source: 'razorpay', razorpay_event: type },
  };
}

// ─── Paddle ──────────────────────────────────────────────────────────────────

function normalizePaddle(body: Record<string, unknown>): NormalizedEvent {
  const type  = String(body.event_type ?? body.alert_name ?? '');
  const data  = body.data as Record<string, unknown> ?? body;

  const eventMap: Record<string, string> = {
    'transaction.completed':  'payment.succeeded',
    'transaction.payment_failed': 'payment.failed',
    'subscription.created':   'subscription.created',
    'subscription.updated':   'subscription.updated',
    'subscription.cancelled': 'subscription.cancelled',
    'subscription.past_due':  'payment.failed',
    // legacy billing alert names
    'payment_succeeded':      'payment.succeeded',
    'payment_refunded':       'payment.refunded',
    'subscription_created':   'subscription.created',
    'subscription_cancelled': 'subscription.cancelled',
  };

  const customer = (data.customer ?? data) as Record<string, unknown>;

  return {
    event_type:      eventMap[type] ?? type,
    customer_email:  (customer.email as string) ?? null,
    customer_name:   (customer.name  as string) ?? null,
    amount:          null,
    currency:        null,
    invoice_id:      (data.id as string) ?? null,
    subscription_id: (data.subscription_id as string) ?? null,
    metadata:        { source: 'paddle', paddle_event_type: type },
  };
}

// ─── HubSpot ─────────────────────────────────────────────────────────────────

function normalizeHubSpot(body: unknown[]): NormalizedEvent[] {
  return body.map((ev) => {
    const e = ev as Record<string, unknown>;
    const type = String(e.subscriptionType ?? '');
    const eventMap: Record<string, string> = {
      'contact.creation':    'contact.created',
      'contact.propertyChange': 'contact.updated',
      'deal.creation':       'deal.created',
      'deal.propertyChange': 'deal.updated',
    };
    return {
      event_type:      eventMap[type] ?? type,
      customer_email:  null,
      customer_name:   null,
      amount:          null,
      currency:        null,
      invoice_id:      null,
      subscription_id: null,
      metadata:        { source: 'hubspot', object_id: e.objectId, portal_id: e.portalId },
    };
  });
}

// ─── Signature verification ───────────────────────────────────────────────────

async function getSecret(apiKeyId: string, connector: string): Promise<string | null> {
  const row = await prisma.connector_secrets.findUnique({ where: { api_key_id_connector: { api_key_id: apiKeyId, connector } } });
  return row?.secret ?? null;
}

function verifyStripeSignature(payload: string, header: string, secret: string): boolean {
  const parts = Object.fromEntries(header.split(',').map(p => p.split('=')));
  const timestamp = parts['t'];
  const sig       = parts['v1'];
  if (!timestamp || !sig) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  try { return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex')); } catch { return false; }
}

function verifyRazorpaySignature(payload: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  try { return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex')); } catch { return false; }
}

// ─── Execute connector rule ───────────────────────────────────────────────────

async function executeRule(apiKeyId: string, connector: string, normalized: NormalizedEvent): Promise<{ status: string; error?: string }> {
  const rule = await prisma.connector_rules.findFirst({
    where: { api_key_id: apiKeyId, connector, event_type: normalized.event_type, enabled: true },
  });

  if (!rule) return { status: 'no_rule' };

  if (rule.action === 'send_template' && rule.template_id && normalized.customer_email) {
    const template = await prisma.email_templates.findFirst({ where: { id: rule.template_id, apiKeyId } });
    if (!template) return { status: 'error', error: 'template not found' };

    const apiKey = await prisma.api_keys.findUnique({ where: { id: apiKeyId }, select: { keyRaw: true } });
    if (!apiKey?.keyRaw) return { status: 'error', error: 'api key not found' };

    const variables: Record<string, string> = {
      customer_email: normalized.customer_email ?? '',
      customer_name:  normalized.customer_name  ?? '',
      amount:         normalized.amount != null ? String(normalized.amount / 100) : '',
      currency:       normalized.currency ?? '',
      invoice_id:     normalized.invoice_id ?? '',
    };

    try {
      const res = await fetch('https://api.continuumapi.com/v1/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey.keyRaw },
        body: JSON.stringify({
          to: normalized.customer_email,
          template_id: rule.template_id,
          variables,
        }),
      });
      return res.ok ? { status: 'sent' } : { status: 'error', error: `send returned ${res.status}` };
    } catch (err) {
      return { status: 'error', error: (err as Error).message };
    }
  }

  if (rule.action === 'enroll_sequence' && rule.sequence_id && normalized.customer_email) {
    await prisma.sequenceEnrollment.upsert({
      where:  { sequenceId_email: { sequenceId: rule.sequence_id, email: normalized.customer_email } },
      create: { sequenceId: rule.sequence_id, email: normalized.customer_email, status: 'active', nextSendAt: new Date(), variables: normalized.metadata as Parameters<typeof prisma.sequenceEnrollment.create>[0]['data']['variables'] },
      update: {},
    });
    return { status: 'enrolled' };
  }

  return { status: 'no_action' };
}

// ─── Route handler factory ────────────────────────────────────────────────────

async function handlePaymentWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
  connector: string,
  normalize: (body: Record<string, unknown>) => NormalizedEvent | NormalizedEvent[],
  verify?: (rawBody: string, headers: Record<string, string>, secret: string) => boolean,
): Promise<void> {
  const apiKeyId  = request.apiKey.id;
  const rawBody   = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
  const body      = typeof request.body === 'string' ? JSON.parse(request.body) : request.body as Record<string, unknown>;
  const headers   = request.headers as Record<string, string>;

  if (verify) {
    const secret = await getSecret(apiKeyId, connector);
    if (secret) {
      const valid = verify(rawBody, headers, secret);
      if (!valid) {
        return reply.status(401).send({ error: 'Invalid webhook signature' });
      }
    }
  }

  const events = Array.isArray(normalize(body)) ? normalize(body) as NormalizedEvent[] : [normalize(body) as NormalizedEvent];

  const results = await Promise.all(events.map(async (normalized) => {
    try {
      const result = await executeRule(apiKeyId, connector, normalized);
      await prisma.connector_events.create({
        data: {
          api_key_id: apiKeyId,
          connector,
          event_type: normalized.event_type,
          normalized: normalized as unknown as Parameters<typeof prisma.connector_events.create>[0]['data']['normalized'],
          status:     result.status,
          error_msg:  result.error ?? null,
        },
      });
      return { event_type: normalized.event_type, status: result.status };
    } catch (err) {
      logger.warn({ connector, err }, 'connector event processing error');
      return { event_type: normalized.event_type, status: 'error' };
    }
  }));

  return reply.send({ received: true, processed: results.length, results });
}

// ─── Register routes ──────────────────────────────────────────────────────────

export async function paymentConnectorRoutes(fastify: FastifyInstance): Promise<void> {

  /** POST /v1/connectors/stripe/webhook */
  fastify.post('/connectors/stripe/webhook', { preHandler: [requireAuth] }, async (req, reply) => {
    await handlePaymentWebhook(req, reply, 'stripe', normalizeStripe as (b: Record<string, unknown>) => NormalizedEvent,
      (raw, headers, secret) => verifyStripeSignature(raw, headers['stripe-signature'] ?? '', secret));
  });

  /** POST /v1/connectors/chargebee/webhook */
  fastify.post('/connectors/chargebee/webhook', { preHandler: [requireAuth] }, async (req, reply) => {
    await handlePaymentWebhook(req, reply, 'chargebee', normalizeChargebee as (b: Record<string, unknown>) => NormalizedEvent);
  });

  /** POST /v1/connectors/razorpay/webhook */
  fastify.post('/connectors/razorpay/webhook', { preHandler: [requireAuth] }, async (req, reply) => {
    await handlePaymentWebhook(req, reply, 'razorpay', normalizeRazorpay as (b: Record<string, unknown>) => NormalizedEvent,
      (raw, headers, secret) => verifyRazorpaySignature(raw, headers['x-razorpay-signature'] ?? '', secret));
  });

  /** POST /v1/connectors/paddle/webhook */
  fastify.post('/connectors/paddle/webhook', { preHandler: [requireAuth] }, async (req, reply) => {
    await handlePaymentWebhook(req, reply, 'paddle', normalizePaddle as (b: Record<string, unknown>) => NormalizedEvent);
  });

  /** POST /v1/connectors/hubspot/webhook */
  fastify.post('/connectors/hubspot/webhook', { preHandler: [requireAuth] }, async (req, reply) => {
    const body = req.body as unknown[];
    const events = normalizeHubSpot(Array.isArray(body) ? body : [body]);
    await handlePaymentWebhook(req, reply, 'hubspot', () => events[0]);
  });

  // ── Rules CRUD ──────────────────────────────────────────────────────────────

  fastify.get('/connectors/rules', { preHandler: [requireAuth, requireRateLimit] }, async (req, reply) => {
    const apiKeyId = req.apiKey.id;
    const rules = await prisma.connector_rules.findMany({ where: { api_key_id: apiKeyId }, orderBy: { created_at: 'asc' } });
    return reply.send({ data: rules });
  });

  fastify.post('/connectors/rules', { preHandler: [requireAuth, requireRateLimit] }, async (req, reply) => {
    const apiKeyId = req.apiKey.id;
    const body = req.body as { connector: string; event_type: string; action?: string; template_id?: string; sequence_id?: string; enabled?: boolean };
    const rule = await prisma.connector_rules.upsert({
      where:  { api_key_id_connector_event_type: { api_key_id: apiKeyId, connector: body.connector, event_type: body.event_type } },
      create: { api_key_id: apiKeyId, connector: body.connector, event_type: body.event_type, action: body.action ?? 'send_template', template_id: body.template_id ?? null, sequence_id: body.sequence_id ?? null, enabled: body.enabled ?? true },
      update: { action: body.action ?? 'send_template', template_id: body.template_id ?? null, sequence_id: body.sequence_id ?? null, enabled: body.enabled ?? true },
    });
    return reply.send(rule);
  });

  fastify.delete('/connectors/rules/:id', { preHandler: [requireAuth, requireRateLimit] }, async (req, reply) => {
    const apiKeyId = req.apiKey.id;
    const id = (req.params as { id: string }).id;
    await prisma.connector_rules.deleteMany({ where: { id, api_key_id: apiKeyId } });
    return reply.send({ deleted: true });
  });

  // ── Secrets CRUD ────────────────────────────────────────────────────────────

  fastify.get('/connectors/secrets', { preHandler: [requireAuth, requireRateLimit] }, async (req, reply) => {
    const apiKeyId = req.apiKey.id;
    const secrets = await prisma.connector_secrets.findMany({ where: { api_key_id: apiKeyId }, select: { connector: true, created_at: true } });
    return reply.send({ data: secrets });
  });

  fastify.post('/connectors/secrets', { preHandler: [requireAuth, requireRateLimit] }, async (req, reply) => {
    const apiKeyId = req.apiKey.id;
    const body = req.body as { connector: string; secret: string };
    await prisma.connector_secrets.upsert({
      where:  { api_key_id_connector: { api_key_id: apiKeyId, connector: body.connector } },
      create: { api_key_id: apiKeyId, connector: body.connector, secret: body.secret },
      update: { secret: body.secret },
    });
    return reply.send({ saved: true, connector: body.connector });
  });

  fastify.delete('/connectors/secrets/:connector', { preHandler: [requireAuth, requireRateLimit] }, async (req, reply) => {
    const apiKeyId  = req.apiKey.id;
    const connector = (req.params as { connector: string }).connector;
    await prisma.connector_secrets.deleteMany({ where: { api_key_id: apiKeyId, connector } });
    return reply.send({ deleted: true });
  });

  // ── Event log ───────────────────────────────────────────────────────────────

  fastify.get('/connectors/events', { preHandler: [requireAuth, requireRateLimit] }, async (req, reply) => {
    const apiKeyId = req.apiKey.id;
    const query = req.query as { connector?: string; limit?: string };
    const limit = Math.min(100, parseInt(query.limit ?? '50', 10));
    const events = await prisma.connector_events.findMany({
      where: { api_key_id: apiKeyId, ...(query.connector ? { connector: query.connector } : {}) },
      orderBy: { created_at: 'desc' },
      take: limit,
    });
    return reply.send({ data: events });
  });
}
