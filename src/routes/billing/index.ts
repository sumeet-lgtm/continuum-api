import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { getPlanLimit, getSendLimit } from '../../plugins/usageMeter.js';
import { prisma } from '../../lib/prisma.js';
import { config, isProd } from '../../config.js';
import { Errors } from '../../plugins/errorHandler.js';
import { logger } from '../../lib/logger.js';
import { sendEmail, upgradeConfirmEmail, planDowngradedEmail, paymentFailedEmail, subscriptionCancelledEmail, paymentReceiptEmail } from '../../lib/email.js';

// ─── Plan → Dodo product mapping ─────────────────────────────────────────────

const PAID_PLANS = ['starter', 'growth', 'scale'] as const;
type PaidPlan = (typeof PAID_PLANS)[number];

function productIdFor(plan: PaidPlan): string | undefined {
  switch (plan) {
    case 'starter': return config.DODO_PRODUCT_STARTER;
    case 'growth':  return config.DODO_PRODUCT_GROWTH;
    case 'scale':   return config.DODO_PRODUCT_SCALE;
  }
}

function planForProductId(productId: string): PaidPlan | null {
  for (const plan of PAID_PLANS) {
    if (productIdFor(plan) === productId) return plan;
  }
  return null;
}

const checkoutSchema = z.object({
  plan: z.enum(PAID_PLANS),
});

// ─── Standard-webhooks signature verification (Dodo) ─────────────────────────
// HMAC-SHA256 over `${id}.${timestamp}.${payload}` keyed by the base64 part of
// the whsec_ secret; header is a space-separated list of `v1,<base64sig>`.

function verifyWebhookSignature(
  secret: string,
  msgId: string,
  timestamp: string,
  payload: string,
  sigHeader: string,
): boolean {
  // Reject stale/future timestamps (replay window ±5 minutes)
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  const expected = crypto
    .createHmac('sha256', key)
    .update(`${msgId}.${timestamp}.${payload}`)
    .digest('base64');
  const expectedBuf = Buffer.from(expected);

  return sigHeader.split(' ').some((part) => {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) return false;
    const sigBuf = Buffer.from(sig);
    return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
  });
}

// ─── Webhook payload shape (only the fields we read) ─────────────────────────

interface DodoEvent {
  type?: string;
  data?: {
    payment_id?: string;
    subscription_id?: string;
    product_id?: string;
    product_cart?: Array<{ product_id?: string }>;
    metadata?: Record<string, string>;
    customer?: { email?: string };
  };
  metadata?: Record<string, string>;
}

const UPGRADE_EVENTS = new Set([
  'payment.succeeded',
  'subscription.active',
  'subscription.renewed',
]);

const DOWNGRADE_EVENTS = new Set([
  'subscription.cancelled',
  'subscription.expired',
]);

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function billingRoutes(fastify: FastifyInstance): Promise<void> {
  // The webhook must verify the signature against the EXACT raw bytes Dodo
  // signed. This parser applies only inside this plugin's encapsulated scope;
  // both handlers parse JSON manually.
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => done(null, body),
  );

  // ── POST /v1/billing/checkout ───────────────────────────────────────────────
  // Called by the dashboard with the user's API key. Returns a Dodo checkout
  // URL carrying the user/key identity in metadata so the webhook can upgrade
  // the right account.
  fastify.post(
    '/billing/checkout',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse((request.body as string) ?? '');
      } catch {
        throw Errors.validationFailed({ body: 'Body must be valid JSON' });
      }
      const parsed = checkoutSchema.safeParse(parsedBody);
      if (!parsed.success) {
        throw Errors.validationFailed({ plan: `plan must be one of: ${PAID_PLANS.join(', ')}` });
      }
      const { plan } = parsed.data;

      if (!config.DODO_PAYMENTS_API_KEY) {
        throw Errors.serviceUnavailable('Billing');
      }
      const productId = productIdFor(plan);
      if (!productId) {
        throw Errors.serviceUnavailable(`Billing for the ${plan} plan`);
      }

      // apiKey.ownerId is the internal User.id (a cuid), not an email — it
      // never contained '@', so the customerEmail?.includes('@') check below
      // was always false and every Dodo checkout has shipped with no
      // customer identity attached at all. Look the email up from the user
      // record the key actually belongs to.
      const owner = request.apiKey.ownerId
        ? await prisma.user.findUnique({ where: { id: request.apiKey.ownerId }, select: { email: true } })
        : null;
      const customerEmail = owner?.email ?? undefined;
      const res = await fetch('https://live.dodopayments.com/checkouts', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.DODO_PAYMENTS_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          product_cart: [{ product_id: productId, quantity: 1 }],
          ...(customerEmail?.includes('@')
            ? { customer: { email: customerEmail, name: customerEmail.split('@')[0] } }
            : {}),
          return_url: `${config.DASHBOARD_URL}/dashboard?upgraded=1&plan=${plan}`,
          metadata: {
            api_key_id: request.apiKey.id,
            user_id:    request.apiKey.userId ?? '',
            plan,
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });

      const data = await res.json() as { checkout_url?: string; url?: string; payment_link?: string };
      if (!res.ok) {
        logger.error({ status: res.status, data }, 'Dodo checkout creation failed');
        throw Errors.serviceUnavailable('Billing');
      }

      const url = data.checkout_url ?? data.url ?? data.payment_link;
      if (!url) {
        logger.error({ data }, 'Dodo checkout response had no URL');
        throw Errors.serviceUnavailable('Billing');
      }
      return reply.send({ url, plan });
    },
  );

  // ── POST /v1/billing/webhook ────────────────────────────────────────────────
  // Signature IS the auth — no API key preHandler. Fails closed in production.
  fastify.post(
    '/billing/webhook',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const rawBody = (request.body as string) ?? '';

      const headerId  = (request.headers['webhook-id'] ?? request.headers['svix-id'] ?? '') as string;
      const headerTs  = (request.headers['webhook-timestamp'] ?? request.headers['svix-timestamp'] ?? '') as string;
      const headerSig = (request.headers['webhook-signature'] ?? request.headers['svix-signature'] ?? '') as string;

      const secret = config.DODO_WEBHOOK_SECRET;
      if (secret && secret.length > 10) {
        if (!headerId || !headerTs || !headerSig
            || !verifyWebhookSignature(secret, headerId, headerTs, rawBody, headerSig)) {
          logger.warn({ headerId }, 'Dodo webhook rejected: bad or missing signature');
          return reply.status(401).send({ error: 'Invalid signature' });
        }
      } else if (isProd) {
        // This endpoint changes plans — never process unauthenticated in prod
        logger.error('Dodo webhook rejected: DODO_WEBHOOK_SECRET not configured');
        return reply.status(500).send({ error: 'Webhook not configured' });
      }

      let event: DodoEvent;
      try {
        event = JSON.parse(rawBody) as DodoEvent;
      } catch {
        return reply.status(400).send({ error: 'Invalid JSON' });
      }

      const eventType = event.type ?? '';
      const dedupeId  = headerId || event.data?.payment_id || event.data?.subscription_id || '';
      logger.info({ eventType, dedupeId }, 'Dodo billing event');

      // Idempotency — Dodo retries deliveries; never apply the same event twice
      if (dedupeId) {
        try {
          const inserted = await prisma.$executeRaw`
            insert into processed_webhooks (id, source) values (${dedupeId}, 'dodo')
            on conflict (id) do nothing`;
          if (inserted === 0) {
            logger.info({ dedupeId }, 'Dodo webhook duplicate ignored');
            return reply.send({ received: true, duplicate: true });
          }
        } catch (err) {
          // Dedupe table problems must not drop a real payment — process anyway
          logger.warn({ err }, 'Webhook dedupe insert failed — processing anyway');
        }
      }

      try {
        if (UPGRADE_EVENTS.has(eventType)) {
          await applyPlanChange(event, eventType);
        } else if (DOWNGRADE_EVENTS.has(eventType)) {
          await applyDowngrade(event, eventType);
        }
      } catch (err) {
        // Release the idempotency claim so Dodo's retry re-runs the grant
        if (dedupeId) {
          await prisma.$executeRaw`delete from processed_webhooks where id = ${dedupeId}`
            .catch(() => { /* best effort */ });
        }
        logger.error({ err, eventType, dedupeId }, 'Dodo webhook processing failed');
        return reply.status(500).send({ error: 'Processing failed' });
      }

      return reply.send({ received: true });
    },
  );
}

// ─── Plan change application ──────────────────────────────────────────────────

function eventIdentity(event: DodoEvent): {
  apiKeyId: string | null; userId: string | null; email: string | null; productId: string;
} {
  const metadata = event.data?.metadata ?? event.metadata ?? {};
  return {
    apiKeyId:  metadata['api_key_id'] || null,
    userId:    metadata['user_id'] || null,
    email:     event.data?.customer?.email ?? null,
    productId: event.data?.product_cart?.[0]?.product_id ?? event.data?.product_id ?? '',
  };
}

async function applyPlanChange(event: DodoEvent, eventType: string): Promise<void> {
  const { apiKeyId, userId, email, productId } = eventIdentity(event);
  const metadataPlan = (event.data?.metadata ?? event.metadata ?? {})['plan'];

  // Product ID is authoritative (it's what was paid for); metadata plan is the
  // fallback for events that omit the cart.
  const plan = (productId ? planForProductId(productId) : null)
    ?? (PAID_PLANS.includes(metadataPlan as PaidPlan) ? metadataPlan as PaidPlan : null);

  if (!plan) {
    logger.error({ eventType, productId, metadataPlan }, 'PAID EVENT WITH UNMAPPED PRODUCT — reconcile manually');
    return; // ack — retries cannot fix an unmapped product
  }

  const monthlyLimit = getPlanLimit(plan);
  const monthlySendLimit = getSendLimit(plan);
  const updated = await updateKeys({ apiKeyId, userId, email }, plan, monthlyLimit, monthlySendLimit);
  if (updated === 0) {
    logger.error({ eventType, apiKeyId, userId, email, plan }, 'PAID EVENT MATCHED NO API KEY — reconcile manually');
    return;
  }
  if (userId) {
    await prisma.$executeRaw`update profiles set plan = ${plan} where "userId" = ${userId}`
      .catch(() => { /* profile plan is display-only */ });
  }
  logger.info({ plan, monthlyLimit, updated, apiKeyId, userId }, 'Plan upgraded via Dodo');

  if (email) {
    const msg = upgradeConfirmEmail(plan, monthlyLimit);
    void sendEmail(email, msg.subject, msg.html);
  }
}

async function applyDowngrade(event: DodoEvent, eventType: string): Promise<void> {
  const { apiKeyId, userId, email } = eventIdentity(event);
  const updated = await updateKeys(
    { apiKeyId, userId, email }, 'free', getPlanLimit('free'), getSendLimit('free'),
  );
  if (userId) {
    await prisma.$executeRaw`update profiles set plan = 'free' where "userId" = ${userId}`
      .catch(() => { /* profile plan is display-only */ });
  }
  logger.info({ eventType, updated, apiKeyId, userId }, 'Plan downgraded to free via Dodo');

  if (email) {
    const msg = planDowngradedEmail('free');
    void sendEmail(email, msg.subject, msg.html);
  }
}

/** Update the target api_keys row(s); most-specific identity wins. */
async function updateKeys(
  target: { apiKeyId: string | null; userId: string | null; email: string | null },
  plan: string,
  monthlyLimit: number,
  monthlySendLimit: number,
): Promise<number> {
  if (target.apiKeyId) {
    const r = await prisma.apiKey.updateMany({
      where: { id: target.apiKeyId },
      data:  { plan, monthlyLimit, monthlySendLimit },
    });
    if (r.count > 0) return r.count;
  }
  if (target.userId) {
    const r = await prisma.apiKey.updateMany({
      where: { userId: target.userId },
      data:  { plan, monthlyLimit, monthlySendLimit },
    });
    if (r.count > 0) return r.count;
  }
  if (target.email) {
    // ownerId is a User.id (cuid), never an email — this was comparing a
    // cuid column against an email string and could never match anything.
    // Resolve the user by email first, same as the other two paths resolve
    // by an actual identifier.
    const user = await prisma.user.findUnique({ where: { email: target.email }, select: { id: true } });
    if (user) {
      const r = await prisma.apiKey.updateMany({
        where: { ownerId: user.id },
        data:  { plan, monthlyLimit, monthlySendLimit },
      });
      return r.count;
    }
  }
  return 0;
}
