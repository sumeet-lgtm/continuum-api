import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { redis, redisKey } from '../../lib/redis.js';
import { Errors } from '../../plugins/errorHandler.js';
import { logger } from '../../lib/logger.js';
import { config } from '../../config.js';

const PUBLIC_DAILY_LIMIT = 40; // messages per IP per day — generous for a real visitor, bounds abuse cost
const MAX_HISTORY_TURNS = 8; // bounds token cost on long conversations

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(2000),
});

const chatSchema = z.object({
  message: z.string().min(1).max(2000),
  history: z.array(messageSchema).max(MAX_HISTORY_TURNS * 2).optional(),
});

// Grounded in what's actually true today (pricing/page.tsx, page.tsx as of
// 2026-09-06) so the bot can't invent a plan, price, or feature that doesn't
// exist -- told explicitly to defer to a human rather than guess.
const SYSTEM_PROMPT = `You are the support assistant on continuumapi.com, the marketing site for Continuum -- an email infrastructure platform. Answer only questions about Continuum. Be concise (2-4 sentences unless a list is clearer), direct, and never invent a feature, price, or policy you're not sure of -- say so and point to support@continuumapi.com or the /docs page instead.

What Continuum actually is: one platform replacing five separate tools -- email verification (12-layer checks + continuous monitoring), transactional sending, newsletter campaigns (Nurture & Newsletters), cold email sequences (multi-mailbox rotation, inbox warmup, AI personalization), and B2B lead finding (prospect search + Lead CRM). One API key, one dashboard, one bill.

Pricing (USD/month, billed via Dodo Payments):
- Free: $0 forever, no card. 1,000 verifications/mo, 1,000 sends/mo, 1 mailbox, 25 Finder leads/mo, 5 monitors.
- Starter: $29/mo. 5k verifications, 5k sends, 5 mailboxes, cold sequences, inbox warmup, 250 Finder leads/mo, 50 monitors, webhooks.
- Growth: $79/mo. 15k verifications, 15k sends, 25 mailboxes, AI personalization, inbox placement testing, reply detection, unified inbox, 750 Finder leads/mo, 200 monitors.
- Scale: $199/mo. 100k verifications, 100k sends, 100 mailboxes, 2,500 Finder leads/mo, dedicated Slack support, dedicated IP on request.
- Managed Outbound: custom pricing -- a dedicated Continuum operator runs outbound inside the customer's own account. Point interested visitors to support@continuumapi.com to talk pricing.

Key links: docs at /docs, pricing at /pricing, free email checker at /verify, signup at https://app.continuumapi.com/signup, status page at /status.

If asked about something outside Continuum, or something you're not confident is accurate, say you're not sure and suggest emailing support@continuumapi.com. Never make up a feature, an integration, or a support policy.`;

interface AnthropicResponse {
  content?: Array<{ text?: string }>;
}

async function callAssistant(message: string, history: Array<{ role: 'user' | 'assistant'; content: string }>, anthropicKey: string): Promise<string> {
  const trimmedHistory = history.slice(-MAX_HISTORY_TURNS * 2);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: [...trimmedHistory, { role: 'user', content: message }],
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    logger.error({ status: res.status }, 'Anthropic chat call failed');
    throw new Error(`Anthropic error ${res.status}`);
  }

  const data = await res.json() as AnthropicResponse;
  const text = data.content?.[0]?.text?.trim();
  if (!text) throw new Error('Empty response from assistant');
  return text;
}

export async function chatPublicRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /v1/chat/public — no API key, IP rate-limited. Public marketing
  // site + logged-in dashboard both call this; neither has (or needs) a
  // Continuum API key for a product-question chatbot.
  fastify.post(
    '/chat/public',
    {},
    async (request: FastifyRequest, reply: FastifyReply) => {
      const anthropicKey = config.ANTHROPIC_API_KEY;
      if (!anthropicKey) throw Errors.serviceUnavailable('Chat assistant');

      const parsed = chatSchema.safeParse(request.body);
      if (!parsed.success) {
        throw Errors.validationFailed(
          parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        );
      }

      const ip = request.ip ?? '0.0.0.0';
      const rateLimitKey = redisKey.ipRateLimit('chat-public', ip);

      try {
        const count = await redis.incr(rateLimitKey);
        if (count === 1) {
          const secondsUntilMidnight = Math.ceil((new Date().setUTCHours(24, 0, 0, 0) - Date.now()) / 1000);
          await redis.expire(rateLimitKey, secondsUntilMidnight);
        }
        if (count > PUBLIC_DAILY_LIMIT) {
          return reply.status(429).send({
            error: 'rate_limited',
            message: `You've reached today's chat limit. Email support@continuumapi.com and we'll pick it up from there.`,
          });
        }
      } catch (err) {
        logger.warn({ err, ip }, 'Redis rate-limit check failed for public chat — allowing request');
      }

      try {
        const reply_text = await callAssistant(parsed.data.message, parsed.data.history ?? [], anthropicKey);
        return reply.status(200).send({ reply: reply_text });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'chat failed';
        logger.error({ err: msg }, 'Public chat failed');
        throw Errors.serviceUnavailable('Chat assistant');
      }
    },
  );
}
