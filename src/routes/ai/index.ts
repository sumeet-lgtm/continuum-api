import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { Errors } from '../../plugins/errorHandler.js';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';

const GROWTH_PLANS = new Set(['growth', 'scale']);

const leadInputSchema = z.object({
  email: z.string().email(),
  first_name: z.string().max(100).optional(),
  last_name: z.string().max(100).optional(),
  company: z.string().max(200).optional(),
  title: z.string().max(200).optional(),
  company_description: z.string().max(500).optional(),
});

const personalizeSchema = z.object({
  leads: z.array(leadInputSchema).min(1).max(100),
  prompt_template: z.string().max(1000).optional(),
  tone: z.enum(['professional', 'casual', 'witty']).default('professional'),
});

async function generateFirstLine(
  lead: z.infer<typeof leadInputSchema>,
  tone: string,
  promptTemplate: string | undefined,
  apiKey: string,
): Promise<string> {
  const name = lead.first_name ? lead.first_name : lead.email.split('@')[0];
  const company = lead.company ?? 'their company';
  const title = lead.title ? ` (${lead.title})` : '';
  const companyDesc = lead.company_description ? ` — ${lead.company_description}` : '';

  const systemPrompt = promptTemplate
    ? promptTemplate
    : `You write highly personalized cold email opening lines. Tone: ${tone}. Write ONE sentence only. Be specific, natural, and relevant. Never use generic openers like "I hope this finds you well". Do not include any greeting like "Hi" or "Hello". Just the opening line itself.`;

  const userPrompt = `Write a personalized opening line for: ${name}${title} at ${company}${companyDesc}.`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    logger.error({ status: resp.status, body: errText }, 'Anthropic API error');
    throw new Error(`Anthropic API error: ${resp.status}`);
  }

  const data = await resp.json() as { content?: Array<{ text?: string }> };
  return data.content?.[0]?.text?.trim() ?? '';
}

export async function aiRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /v1/ai/personalize
  fastify.post(
    '/ai/personalize',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!config.AI_PERSONALIZATION_ENABLED) {
        throw Errors.forbidden('AI personalization is not enabled on this account. Contact support to enable it.');
      }

      const plan: string = (request.apiKey as { plan?: string }).plan ?? 'free';
      if (!GROWTH_PLANS.has(plan)) {
        throw Errors.forbidden('AI personalization requires a Growth or Scale plan.');
      }

      const anthropicKey = config.ANTHROPIC_API_KEY;
      if (!anthropicKey) {
        throw Errors.serviceUnavailable('AI personalization service is temporarily unavailable.');
      }

      const parsed = personalizeSchema.safeParse(request.body);
      if (!parsed.success) {
        throw Errors.validationFailed(
          parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })),
        );
      }

      const { leads, prompt_template, tone } = parsed.data;

      const results = await Promise.all(
        leads.map(async (lead) => {
          try {
            const firstLine = await generateFirstLine(lead, tone, prompt_template, anthropicKey);
            return { email: lead.email, first_line: firstLine, error: null };
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'generation failed';
            logger.warn({ email: lead.email, err: msg }, 'AI personalize failed for lead');
            return { email: lead.email, first_line: null, error: msg };
          }
        }),
      );

      return reply.status(200).send({
        results,
        model: 'claude-haiku-4-5-20251001',
        usage: { leads_processed: leads.length, successful: results.filter(r => r.first_line !== null).length },
      });
    },
  );
}
