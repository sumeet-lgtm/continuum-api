import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { webhookQueue } from '../../lib/queue.js';
import { generateWebhookSecret } from '../../lib/crypto.js';
import { dispatchWebhook, buildEventId } from '../../lib/webhooks.js';
import { Errors } from '../../plugins/errorHandler.js';
import { logger } from '../../lib/logger.js';
import { ALL_WEBHOOK_EVENTS } from '../../types/webhook.js';
import type { WebhookRecord, DeliveryRecord, AttemptRecord } from '../../types/webhook.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_WEBHOOKS_PER_KEY = 10;

// ─── Validation schemas ───────────────────────────────────────────────────────

const eventEnum = z.string().refine(
  (v) => (ALL_WEBHOOK_EVENTS as string[]).includes(v),
  { message: `Must be one of: ${ALL_WEBHOOK_EVENTS.join(', ')}` },
);

const createSchema = z.object({
  url: z
    .string({ required_error: 'url is required' })
    .url('url must be a valid HTTPS URL')
    .max(2048)
    .refine((u) => u.startsWith('https://'), { message: 'url must use HTTPS' }),
  events: z
    .array(eventEnum)
    .min(1, 'At least one event type is required')
    .max(ALL_WEBHOOK_EVENTS.length),
  label:       z.string().max(100).optional(),
  description: z.string().max(500).optional(),
});

const updateSchema = z.object({
  url: z
    .string()
    .url('url must be a valid HTTPS URL')
    .max(2048)
    .refine((u) => u.startsWith('https://'), { message: 'url must use HTTPS' })
    .optional(),
  events:      z.array(eventEnum).min(1).max(ALL_WEBHOOK_EVENTS.length).optional(),
  label:       z.string().max(100).optional(),
  description: z.string().max(500).optional(),
  isActive:    z.boolean().optional(),
});

const deliveryQuerySchema = z.object({
  page:              z.coerce.number().int().min(1).default(1),
  limit:             z.coerce.number().int().min(1).max(100).default(20),
  delivered:         z.string().transform((v) => v === 'true' ? true : v === 'false' ? false : undefined).optional(),
  failedPermanently: z.string().transform((v) => v === 'true' ? true : v === 'false' ? false : undefined).optional(),
  event:             z.string().optional(),
});

interface WebhookParams   { id: string }
interface DeliveryParams  { id: string; deliveryId: string }

// ─── Shared select and formatter ──────────────────────────────────────────────

const WEBHOOK_SELECT = {
  id:              true,
  url:             true,
  label:           true,
  description:     true,
  events:          true,
  isActive:        true,
  createdAt:       true,
  lastPingAt:      true,
  lastPingOk:      true,
  totalDeliveries: true,
  successCount:    true,
  failureCount:    true,
} as const;

type WebhookRow = {
  id:              string;
  url:             string;
  label:           string | null;
  description:     string | null;
  events:          string[];
  isActive:        boolean;
  createdAt:       Date;
  lastPingAt:      Date | null;
  lastPingOk:      boolean | null;
  totalDeliveries: number;
  successCount:    number;
  failureCount:    number;
};

function formatWebhook(w: WebhookRow): WebhookRecord {
  return {
    id:              w.id,
    url:             w.url,
    label:           w.label,
    description:     w.description,
    events:          w.events,
    isActive:        w.isActive,
    createdAt:       w.createdAt.toISOString(),
    lastPingAt:      w.lastPingAt?.toISOString()  ?? null,
    lastPingOk:      w.lastPingOk,
    totalDeliveries: w.totalDeliveries,
    successCount:    w.successCount,
    failureCount:    w.failureCount,
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function webhookRoutes(fastify: FastifyInstance): Promise<void> {

  // ── POST /v1/webhooks ─────────────────────────────────────────────────────
  fastify.post(
    '/webhooks',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) {
        throw Errors.validationFailed(
          parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        );
      }

      const count = await prisma.webhook.count({
        where: { apiKeyId: request.apiKey.id, isActive: true },
      });
      if (count >= MAX_WEBHOOKS_PER_KEY) {
        throw Errors.validationFailed({
          limit: `Maximum of ${MAX_WEBHOOKS_PER_KEY} active webhooks per API key.`,
        });
      }

      const { url, events, label, description } = parsed.data;
      const secret = generateWebhookSecret();

      const webhook = await prisma.webhook.create({
        data: {
          apiKeyId:    request.apiKey.id,
          url,
          secret,
          events:      events as unknown as never,
          label:       label       ?? null,
          description: description ?? null,
          isActive:    true,
        },
        select: WEBHOOK_SELECT,
      });

      logger.info({ webhookId: webhook.id, url, events }, 'Webhook created');

      return reply.status(201).send({
        ...formatWebhook(webhook),
        secret,
        _secretNote: 'Save this secret — it will not be shown again. Use it to verify X-Continuum-Signature headers.',
      });
    },
  );

  // ── GET /v1/webhooks ──────────────────────────────────────────────────────
  fastify.get(
    '/webhooks',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const webhooks = await prisma.webhook.findMany({
        where:   { apiKeyId: request.apiKey.id },
        select:  WEBHOOK_SELECT,
        orderBy: { createdAt: 'desc' },
      });

      return reply.status(200).send({
        data:  webhooks.map((w: WebhookRow) => formatWebhook(w)),
        total: webhooks.length,
      });
    },
  );

  // ── GET /v1/webhooks/:id ──────────────────────────────────────────────────
  fastify.get<{ Params: WebhookParams }>(
    '/webhooks/:id',
    {
      preHandler: [requireAuth, requireRateLimit],
      schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    },
    async (request: FastifyRequest<{ Params: WebhookParams }>, reply: FastifyReply) => {
      const webhook = await prisma.webhook.findUnique({
        where:  { id: request.params.id },
        select: WEBHOOK_SELECT,
      });

      if (!webhook || (webhook as WebhookRow & { apiKeyId?: string }).apiKeyId !== request.apiKey.id) {
        // Re-fetch with apiKeyId to validate ownership
        const raw = await prisma.webhook.findUnique({
          where:  { id: request.params.id },
          select: { apiKeyId: true },
        });
        if (!raw || raw.apiKeyId !== request.apiKey.id) {
          throw Errors.notFound('Webhook');
        }
      }

      // Fetch with apiKeyId included for ownership check
      const raw = await prisma.webhook.findUnique({
        where:  { id: request.params.id },
        select: { ...WEBHOOK_SELECT, apiKeyId: true },
      });

      if (!raw || raw.apiKeyId !== request.apiKey.id) {
        throw Errors.notFound('Webhook');
      }

      return reply.status(200).send(formatWebhook(raw));
    },
  );

  // ── PATCH /v1/webhooks/:id ────────────────────────────────────────────────
  fastify.patch<{ Params: WebhookParams }>(
    '/webhooks/:id',
    {
      preHandler: [requireAuth, requireRateLimit],
      schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    },
    async (request: FastifyRequest<{ Params: WebhookParams }>, reply: FastifyReply) => {
      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) {
        throw Errors.validationFailed(
          parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        );
      }

      if (Object.keys(parsed.data).length === 0) {
        throw Errors.validationFailed({ body: 'At least one field is required.' });
      }

      const existing = await prisma.webhook.findUnique({
        where:  { id: request.params.id },
        select: { id: true, apiKeyId: true },
      });
      if (!existing || existing.apiKeyId !== request.apiKey.id) {
        throw Errors.notFound('Webhook');
      }

      const { url, events, label, description, isActive } = parsed.data;

      type UpdateData = {
        url?:         string;
        events?:      never;
        label?:       string | null;
        description?: string | null;
        isActive?:    boolean;
      };

      const data: UpdateData = {};
      if (url         !== undefined) data.url         = url;
      if (events      !== undefined) data.events = events as unknown as never;
      if (label       !== undefined) data.label       = label ?? null;
      if (description !== undefined) data.description = description ?? null;
      if (isActive    !== undefined) data.isActive    = isActive;

      const updated = await prisma.webhook.update({
        where:  { id: request.params.id },
        data,
        select: WEBHOOK_SELECT,
      });

      return reply.status(200).send(formatWebhook(updated));
    },
  );

  // ── DELETE /v1/webhooks/:id ───────────────────────────────────────────────
  fastify.delete<{ Params: WebhookParams }>(
    '/webhooks/:id',
    {
      preHandler: [requireAuth, requireRateLimit],
      schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    },
    async (request: FastifyRequest<{ Params: WebhookParams }>, reply: FastifyReply) => {
      const webhook = await prisma.webhook.findUnique({
        where:  { id: request.params.id },
        select: { id: true, apiKeyId: true },
      });
      if (!webhook || webhook.apiKeyId !== request.apiKey.id) {
        throw Errors.notFound('Webhook');
      }

      await prisma.webhook.delete({ where: { id: request.params.id } });
      return reply.status(200).send({ id: request.params.id, deleted: true });
    },
  );

  // ── POST /v1/webhooks/:id/ping ────────────────────────────────────────────
  fastify.post<{ Params: WebhookParams }>(
    '/webhooks/:id/ping',
    {
      preHandler: [requireAuth, requireRateLimit],
      schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    },
    async (request: FastifyRequest<{ Params: WebhookParams }>, reply: FastifyReply) => {
      const webhook = await prisma.webhook.findUnique({
        where:  { id: request.params.id },
        select: { id: true, apiKeyId: true, url: true, secret: true, isActive: true },
      });
      if (!webhook || webhook.apiKeyId !== request.apiKey.id) {
        throw Errors.notFound('Webhook');
      }
      if (!webhook.isActive) {
        throw Errors.validationFailed({ isActive: 'Webhook is inactive. Reactivate it before pinging.' });
      }

      const pingId  = `ping-${Date.now()}`;
      const eventId = buildEventId('verification.completed', pingId);

      const payload = {
        event:     'verification.completed' as const,
        id:        pingId,
        email:     'ping@continuum.test',
        domain:    'continuum.test',
        status:    'valid',
        subStatus: null,
        score:     100,
        checks: {
          syntaxValid: true, mxFound: true, isDisposable: false, isRoleAccount: false,
          smtpChecked: false, smtpReachable: null, isCatchAll: null, greylisted: false,
        },
        apiKeyId:   request.apiKey.id,
        checkedAt:  new Date().toISOString(),
        apiVersion: '2' as const,
        _note:      'This is a test delivery triggered by POST /ping.',
      };

      const delivery = await prisma.webhookDelivery.create({
        data: {
          webhookId:   webhook.id,
          event:       'verification_complete' as never, // stored as Prisma enum value
          eventId,
          payload:     payload as never,
          maxAttempts: 1, // ping: single attempt only
        },
        select: { id: true },
      });

      await webhookQueue.add(
        'deliver-webhook',
        {
          deliveryId:    delivery.id,
          webhookId:     webhook.id,
          webhookUrl:    webhook.url,
          webhookSecret: webhook.secret,
          event:         'verification.completed',
          eventId,
          payload,
          attemptNumber: 1,
        },
        { jobId: `ping:${delivery.id}`, priority: 1 },
      );

      return reply.status(202).send({
        deliveryId: delivery.id,
        webhookId:  webhook.id,
        url:        webhook.url,
        eventId,
        message:    'Test delivery enqueued.',
      });
    },
  );

  // ── GET /v1/webhooks/:id/deliveries ───────────────────────────────────────
  // Paginated delivery history for a webhook with optional filters.
  fastify.get<{ Params: WebhookParams }>(
    '/webhooks/:id/deliveries',
    {
      preHandler: [requireAuth, requireRateLimit],
      schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    },
    async (request: FastifyRequest<{ Params: WebhookParams }>, reply: FastifyReply) => {
      const qr = deliveryQuerySchema.safeParse(request.query);
      if (!qr.success) {
        throw Errors.validationFailed(qr.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
      }

      const webhook = await prisma.webhook.findUnique({
        where:  { id: request.params.id },
        select: { id: true, apiKeyId: true },
      });
      if (!webhook || webhook.apiKeyId !== request.apiKey.id) {
        throw Errors.notFound('Webhook');
      }

      const { page, limit, delivered, failedPermanently, event } = qr.data;
      const skip = (page - 1) * limit;
      const where = { webhookId: webhook.id, ...(delivered !== undefined && { delivered }), ...(failedPermanently !== undefined && { failedPermanently }) };

      const [deliveries, total] = await Promise.all([
        prisma.webhookDelivery.findMany({
          where,
          select: {
            id:                true,
            webhookId:         true,
            event:             true,
            eventId:           true,
            attempts:          true,
            maxAttempts:       true,
            delivered:         true,
            failedPermanently: true,
            nextRetryAt:       true,
            lastAttemptAt:     true,
            statusCode:        true,
            errorMessage:      true,
            createdAt:         true,
          },
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
        }),
        prisma.webhookDelivery.count({ where }),
      ]);

      type DeliveryRow = typeof deliveries[number];

      const data: DeliveryRecord[] = deliveries.map((d: DeliveryRow) => ({
        id:                d.id,
        webhookId:         d.webhookId,
        event:             d.event,
        eventId:           d.eventId,
        attempts:          d.attempts,
        maxAttempts:       d.maxAttempts,
        delivered:         d.delivered,
        failedPermanently: d.failedPermanently,
        nextRetryAt:       d.nextRetryAt?.toISOString()    ?? null,
        lastAttemptAt:     d.lastAttemptAt?.toISOString()  ?? null,
        statusCode:        d.statusCode,
        errorMessage:      d.errorMessage,
        createdAt:         d.createdAt.toISOString(),
      }));

      return reply.status(200).send({
        webhookId: webhook.id,
        data,
        pagination: {
          page, limit, total,
          totalPages: Math.ceil(total / limit),
          hasNext:    page * limit < total,
          hasPrev:    page > 1,
        },
        filters: {
          delivered:         delivered         ?? null,
          failedPermanently: failedPermanently ?? null,
          event:             event             ?? null,
        },
      });
    },
  );

  // ── GET /v1/webhooks/:id/deliveries/:deliveryId ───────────────────────────
  // Single delivery with all HTTP attempts.
  fastify.get<{ Params: DeliveryParams }>(
    '/webhooks/:id/deliveries/:deliveryId',
    {
      preHandler: [requireAuth, requireRateLimit],
      schema: {
        params: {
          type: 'object',
          required: ['id', 'deliveryId'],
          properties: { id: { type: 'string' }, deliveryId: { type: 'string' } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: DeliveryParams }>, reply: FastifyReply) => {
      // Verify webhook ownership first
      const webhook = await prisma.webhook.findUnique({
        where:  { id: request.params.id },
        select: { id: true, apiKeyId: true },
      });
      if (!webhook || webhook.apiKeyId !== request.apiKey.id) {
        throw Errors.notFound('Webhook');
      }

      const delivery = await prisma.webhookDelivery.findUnique({
        where:  { id: request.params.deliveryId },
        select: {
          id:                true,
          webhookId:         true,
          event:             true,
          eventId:           true,
          payload:           true,
          attempts:          true,
          maxAttempts:       true,
          delivered:         true,
          failedPermanently: true,
          nextRetryAt:       true,
          lastAttemptAt:     true,
          statusCode:        true,
          responseBody:      true,
          errorMessage:      true,
          createdAt:         true,
          attempts_:         {
            select: {
              id:            true,
              deliveryId:    true,
              attemptNumber: true,
              requestedAt:   true,
              respondedAt:   true,
              durationMs:    true,
              statusCode:    true,
              responseBody:  true,
              errorType:     true,
              errorMessage:  true,
              success:       true,
            },
            orderBy: { attemptNumber: 'asc' },
          },
        },
      });

      if (!delivery || delivery.webhookId !== webhook.id) {
        throw Errors.notFound('Delivery');
      }

      type AttemptRow = typeof delivery.attempts_[number];

      const attemptLogs: AttemptRecord[] = delivery.attempts_.map((a: AttemptRow) => ({
        id:            a.id,
        deliveryId:    a.deliveryId,
        attemptNumber: a.attemptNumber,
        requestedAt:   a.requestedAt.toISOString(),
        respondedAt:   a.respondedAt?.toISOString() ?? null,
        durationMs:    a.durationMs,
        statusCode:    a.statusCode,
        responseBody:  a.responseBody,
        errorType:     a.errorType,
        errorMessage:  a.errorMessage,
        success:       a.success,
      }));

      return reply.status(200).send({
        id:                delivery.id,
        webhookId:         delivery.webhookId,
        event:             delivery.event,
        eventId:           delivery.eventId,
        payload:           delivery.payload,
        attempts:          delivery.attempts,
        maxAttempts:       delivery.maxAttempts,
        delivered:         delivery.delivered,
        failedPermanently: delivery.failedPermanently,
        nextRetryAt:       delivery.nextRetryAt?.toISOString()   ?? null,
        lastAttemptAt:     delivery.lastAttemptAt?.toISOString() ?? null,
        statusCode:        delivery.statusCode,
        responseBody:      delivery.responseBody,
        errorMessage:      delivery.errorMessage,
        createdAt:         delivery.createdAt.toISOString(),
        httpAttempts:      attemptLogs,
      });
    },
  );
}
