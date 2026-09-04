import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { requireMonthlyQuota, incrementUsage, incrementUsageBy } from '../../plugins/usageMeter.js';
import { Errors } from '../../plugins/errorHandler.js';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { detectESP } from '../../lib/espMatch.js';

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

const emailGenerateSchema = z.object({
  type: z.enum(['cold_outreach', 'follow_up', 'newsletter', 'transactional', 're_engagement']),
  about: z.string().min(1).max(500),
  recipient: z.object({
    name: z.string().optional(),
    company: z.string().optional(),
    title: z.string().optional(),
  }).optional(),
  sender: z.object({
    name: z.string().optional(),
    company: z.string().optional(),
    product: z.string().optional(),
  }).optional(),
  tone: z.enum(['professional', 'casual', 'friendly', 'urgent']).default('professional'),
  subject_only: z.boolean().default(false),
  num_variants: z.number().int().min(1).max(5).default(1),
});

const classifyReplySchema = z.object({
  subject: z.string().optional(),
  body: z.string().min(1).max(10000),
});

async function generateEmailContent(
  opts: z.infer<typeof emailGenerateSchema>,
  apiKey: string,
): Promise<Array<{ subject: string; body?: string }>> {
  const recipientCtx = opts.recipient
    ? `Recipient: ${[opts.recipient.name, opts.recipient.title, opts.recipient.company].filter(Boolean).join(', ')}`
    : '';
  const senderCtx = opts.sender
    ? `Sender: ${[opts.sender.name, opts.sender.product].filter(Boolean).join(', ')} at ${opts.sender.company ?? 'the company'}`
    : '';

  const system = `You are an expert email copywriter. Write high-converting ${opts.type} emails. Tone: ${opts.tone}. Be specific, human, and avoid corporate clichés. Never use "I hope this email finds you well" or similar filler openers.`;

  const task = opts.subject_only
    ? `Write ${opts.num_variants} compelling email subject line(s) for an email about: ${opts.about}. ${recipientCtx}. ${senderCtx}. Return as JSON array: [{"subject":"..."}]`
    : `Write ${opts.num_variants} complete email(s) about: ${opts.about}. ${recipientCtx}. ${senderCtx}. Include subject line and body. Return as JSON array: [{"subject":"...","body":"<full HTML email body>"}]`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: opts.subject_only ? 300 : 2000,
      system,
      messages: [{ role: 'user', content: task }],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    throw new Error(`Anthropic API error: ${resp.status} ${err}`);
  }

  const data = await resp.json() as { content?: Array<{ text?: string }> };
  const text = data.content?.[0]?.text?.trim() ?? '[]';

  try {
    const match = text.match(/\[[\s\S]*\]/);
    return match ? JSON.parse(match[0]) as Array<{ subject: string; body?: string }> : [];
  } catch {
    return [{ subject: text.slice(0, 200) }];
  }
}

async function classifyReplyContent(subject: string, body: string, apiKey: string): Promise<{
  category: string;
  confidence: number;
  suggested_action: string;
}> {
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
      system: 'You are an email intent classifier for sales outreach. Classify the reply and return ONLY valid JSON.',
      messages: [{
        role: 'user',
        content: `Classify this email reply.\nSubject: ${subject}\nBody: ${body.slice(0, 2000)}\n\nReturn JSON: {"category":"interested|not_interested|out_of_office|referral|meeting_request|unsubscribe|question","confidence":0.0-1.0,"suggested_action":"reply|close|pause|escalate|unsubscribe"}`,
      }],
    }),
  });

  if (!resp.ok) throw new Error('Anthropic classify error');
  const data = await resp.json() as { content?: Array<{ text?: string }> };
  const raw = data.content?.[0]?.text?.trim() ?? '{}';
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const jsonMatch = stripped.match(/\{[\s\S]*\}/);
  try {
    const jsonStr = jsonMatch ? jsonMatch[0] : stripped;
    return JSON.parse(jsonStr) as { category: string; confidence: number; suggested_action: string };
  } catch {
    return { category: 'unknown', confidence: 0, suggested_action: 'reply' };
  }
}

export async function aiRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /v1/ai/personalize
  fastify.post(
    '/ai/personalize',
    { preHandler: [requireAuth, requireRateLimit, requireMonthlyQuota] },
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

      void incrementUsageBy(request.apiKey!.id, leads.length);
      return reply.status(200).send({
        results,
        model: 'claude-haiku-4-5-20251001',
        usage: { leads_processed: leads.length, successful: results.filter(r => r.first_line !== null).length },
      });
    },
  );

  // POST /v1/ai/generate-email — generate full email content (Growth+ plan)
  fastify.post(
    '/ai/generate-email',
    { preHandler: [requireAuth, requireRateLimit, requireMonthlyQuota] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!config.AI_PERSONALIZATION_ENABLED) {
        throw Errors.forbidden('AI features are not enabled on this account.');
      }
      const plan: string = (request.apiKey as { plan?: string }).plan ?? 'free';
      if (!GROWTH_PLANS.has(plan)) {
        throw Errors.forbidden('AI email generation requires a Growth or Scale plan.');
      }
      const anthropicKey = config.ANTHROPIC_API_KEY;
      if (!anthropicKey) throw Errors.serviceUnavailable('AI service temporarily unavailable.');

      const parsed = emailGenerateSchema.safeParse(request.body);
      if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

      try {
        const variants = await generateEmailContent(parsed.data, anthropicKey);
        void incrementUsageBy(request.apiKey!.id, Math.max(1, variants.length));
        return reply.status(200).send({
          variants,
          model: 'claude-haiku-4-5-20251001',
          usage: { variants_generated: variants.length },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'generation failed';
        logger.error({ err: msg }, 'AI generate-email failed');
        throw Errors.serviceUnavailable('AI generation failed. Please try again.');
      }
    },
  );

  // POST /v1/ai/classify-reply — classify an inbound reply email (Growth+ plan)
  fastify.post(
    '/ai/classify-reply',
    { preHandler: [requireAuth, requireRateLimit, requireMonthlyQuota] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!config.AI_PERSONALIZATION_ENABLED) {
        throw Errors.forbidden('AI features are not enabled on this account.');
      }
      const plan: string = (request.apiKey as { plan?: string }).plan ?? 'free';
      if (!GROWTH_PLANS.has(plan)) {
        throw Errors.forbidden('AI reply classification requires a Growth or Scale plan.');
      }
      const anthropicKey = config.ANTHROPIC_API_KEY;
      if (!anthropicKey) throw Errors.serviceUnavailable('AI service temporarily unavailable.');

      const parsed = classifyReplySchema.safeParse(request.body);
      if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

      try {
        const result = await classifyReplyContent(parsed.data.subject ?? '', parsed.data.body, anthropicKey);
        void incrementUsage(request.apiKey!.id);
        return reply.status(200).send({ ...result, model: 'claude-haiku-4-5-20251001' });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'classify failed';
        logger.error({ err: msg }, 'AI classify-reply failed');
        throw Errors.serviceUnavailable('AI classification failed. Please try again.');
      }
    },
  );

  // POST /v1/ai/generate-sequence — AI brief → full multi-channel sequence plan (Growth+ plan)
  fastify.post(
    '/ai/generate-sequence',
    { preHandler: [requireAuth, requireRateLimit, requireMonthlyQuota] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!config.AI_PERSONALIZATION_ENABLED) {
        throw Errors.forbidden('AI features are not enabled on this account.');
      }
      const plan: string = (request.apiKey as { plan?: string }).plan ?? 'free';
      if (!GROWTH_PLANS.has(plan)) {
        throw Errors.forbidden('AI sequence generation requires a Growth or Scale plan.');
      }
      const anthropicKey = config.ANTHROPIC_API_KEY;
      if (!anthropicKey) throw Errors.serviceUnavailable('AI service temporarily unavailable.');

      const seqGenSchema = z.object({
        icp_description: z.string().min(10).max(1000),
        goal: z.string().min(5).max(500),
        tone: z.enum(['professional', 'casual', 'friendly', 'direct']).default('professional'),
        num_steps: z.number().int().min(2).max(10).default(5),
        allowed_step_types: z.array(z.enum(['email', 'linkedin', 'task'])).default(['email', 'linkedin', 'task']),
        sender_name: z.string().optional(),
        sender_company: z.string().optional(),
        sender_product: z.string().optional(),
      });

      const parsed = seqGenSchema.safeParse(request.body);
      if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

      const { icp_description, goal, tone, num_steps, allowed_step_types, sender_name, sender_company, sender_product } = parsed.data;

      const senderCtx = [sender_name, sender_product, sender_company].filter(Boolean).join(' at ') || 'the sender';
      const typesAllowed = allowed_step_types.join(', ');

      const system = `You are an expert outbound sales strategist. Design multi-channel sequences that convert. Tone: ${tone}. Be specific, not generic. Mix channel types for maximum engagement.`;

      const userPrompt = `Design a ${num_steps}-step outbound sequence.

Target ICP: ${icp_description}
Goal: ${goal}
Sender: ${senderCtx}
Allowed step types: ${typesAllowed}

Rules:
- Mix channels intelligently (don't just send emails)
- Delay days should escalate: first step=0, then space out realistically (1-3 days between early steps, 5-7 between later ones)
- Email steps MUST have subject and html_body (proper HTML, no markdown)
- Call/LinkedIn/Task steps MUST have task_note with specific instructions (what to say/do)
- Each step should have a brief rationale explaining why this channel/timing

Return ONLY valid JSON in this exact format:
{
  "sequence_name": "Sequence name based on goal",
  "steps": [
    {
      "step_order": 1,
      "type": "email|call|linkedin|task",
      "delay_days": 0,
      "delay_hours": 0,
      "subject": "Email subject (email steps only)",
      "html_body": "<p>Full HTML email body (email steps only)</p>",
      "task_note": "Specific instructions for manual step (non-email steps only)",
      "condition": "always",
      "rationale": "Why this step at this point"
    }
  ]
}`;

      try {
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 4000,
            system,
            messages: [{ role: 'user', content: userPrompt }],
          }),
        });

        if (!resp.ok) throw new Error(`Anthropic error: ${resp.status}`);
        const data = await resp.json() as { content?: Array<{ text?: string }> };
        const text = data.content?.[0]?.text?.trim() ?? '{}';
        const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        const jsonMatch = stripped.match(/\{[\s\S]*\}/);

        let result: { sequence_name?: string; steps?: unknown[] };
        try {
          result = jsonMatch ? JSON.parse(jsonMatch[0]) as { sequence_name?: string; steps?: unknown[] } : { steps: [] };
        } catch {
          result = { sequence_name: 'Generated Sequence', steps: [] };
        }

        void incrementUsage(request.apiKey!.id);
        return reply.status(200).send({
          sequence_name: result.sequence_name ?? 'Generated Sequence',
          steps: result.steps ?? [],
          model: 'claude-haiku-4-5-20251001',
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'generation failed';
        logger.error({ err: msg }, 'AI generate-sequence failed');
        throw Errors.serviceUnavailable('AI sequence generation failed. Please try again.');
      }
    },
  );

  // POST /v1/ai/detect-esp — detect email service provider for a list of email addresses
  fastify.post(
    '/ai/detect-esp',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as { emails?: unknown };
      const parsed = z.object({ emails: z.array(z.string().email()).min(1).max(100) }).safeParse(body);
      if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

      const results = await Promise.all(
        parsed.data.emails.map(async (email) => ({
          email,
          esp: await detectESP(email),
        })),
      );

      return reply.status(200).send({ results });
    },
  );
}
