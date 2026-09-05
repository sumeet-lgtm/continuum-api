/**
 * Campaign copy generation, grounded in docs/email-generation-knowledge-base.md
 * rather than a one-line "write good copy" system prompt. Two real model
 * calls per segment, not one:
 *
 *   1. Draft — write against the full knowledge base, given the campaign's
 *      actual offer/sender context and the segment's real signal summary
 *      (see campaignSegments.ts — never a hypothetical audience).
 *   2. Critique + revise — a second, independent pass runs the draft
 *      through the knowledge base's own self-critique checklist (§8) and
 *      returns a corrected final version. This is what makes the checklist
 *      an enforced step instead of a paragraph the model might skim past
 *      while also trying to be creative in the same breath.
 *
 * Uses Sonnet, not Haiku — the knowledge base is a multi-thousand-word style
 * guide with dozens of specific rules (banned words, structural patterns,
 * audience calibration); reliably following that much instruction is exactly
 * where a stronger model earns its cost, on a feature that's gated to
 * Growth+ plans specifically because the output quality is the point.
 */
import { logger } from './logger.js';
import { getEmailKnowledgeBase } from './emailKnowledgeBase.js';
import type { CampaignSegment } from './campaignSegments.js';

const MODEL = 'claude-sonnet-5';

export interface GenerateCopyInput {
  /** What's being offered / the campaign's actual subject matter, in the customer's own words — e.g. "a pentesting-as-a-service tool for security teams at Series B+ companies". */
  about: string;
  sender?: {
    name?: string;
    company?: string;
    product?: string;
  };
  tone?: 'professional' | 'casual' | 'direct' | 'technical';
  segment: CampaignSegment;
  /** Which touch this is in a multi-step sequence, e.g. "step 1 of 5 — the opening spark" or "step 4 of 5 — proof, after two prior touches with no reply". Drives the SPBC framework (knowledge base §5.2): each touch needs a genuinely different angle, not a rephrase. Omit for a single, one-off campaign email. */
  stepContext?: string;
}

export interface GeneratedEmail {
  segmentLabel: string;
  matchCount: number;
  matchPct: number;
  subject: string;
  textBody: string;
  htmlBody: string;
  hookUsed: string;
  revised: boolean;
}

async function callClaude(apiKey: string, system: string, user: string, maxTokens: number): Promise<string> {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    throw new Error(`Anthropic API error: ${resp.status} ${err}`);
  }

  const data = await resp.json() as { content?: Array<{ type?: string; text?: string }> };
  // Sonnet can (and here, reliably does) return a leading `thinking` block
  // before the actual `text` block for a prompt this instruction-dense —
  // content[0] is not reliably the answer. Find the first real text block
  // instead of assuming position 0, which was silently returning an empty
  // string (the thinking block has no `text` field) and blowing up as
  // "Unexpected end of JSON input" one call site downstream.
  const textBlock = data.content?.find((c) => c.type === 'text');
  return textBlock?.text?.trim() ?? '';
}

function extractJson(text: string): Record<string, unknown> {
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const match = stripped.match(/\{[\s\S]*\}/);
  const jsonStr = match ? match[0] : stripped;
  try {
    return JSON.parse(jsonStr) as Record<string, unknown>;
  } catch (err) {
    // Log the actual raw text on parse failure — "Unexpected end of JSON
    // input" alone gives no way to tell a truncated response (hit
    // max_tokens) apart from the model wrapping JSON in prose the regex
    // above didn't fully capture.
    logger.error({ err, rawTextLength: text.length, rawTextPreview: text.slice(0, 500) }, 'Failed to parse model output as JSON');
    throw err;
  }
}

const DRAFT_OUTPUT_CONTRACT = `Return ONLY valid JSON, no other text, in exactly this shape:
{"subject": "...", "textBody": "...", "htmlBody": "...", "hookUsed": "one sentence naming the specific, checkable fact this email is built around"}

textBody is a plain-text email body (no HTML tags) formatted per the knowledge base's plain-text guidance.
htmlBody is the same message with light HTML formatting per the knowledge base's HTML guidance (section 6) — it must NOT look like a marketing template; it should read as a personal email that happens to have a paragraph break or one styled link, using a system font stack, no banners, no stock imagery, no heavy color.`;

async function draftEmail(apiKey: string, knowledgeBase: string, input: GenerateCopyInput): Promise<{ subject: string; textBody: string; htmlBody: string; hookUsed: string }> {
  const senderCtx = input.sender
    ? `Sender: ${[input.sender.name, input.sender.product].filter(Boolean).join(', ')} at ${input.sender.company ?? 'the company'}.`
    : 'Sender: not specified — write in first person without inventing a name or company.';

  const system = `${knowledgeBase}\n\n---\n\nYou are generating copy for a real campaign using the rules above. Follow every rule literally, not as inspiration — the banned-word list, banned-opener list, and structural rules in section 2 are hard constraints, not style suggestions.`;

  const stepCtx = input.stepContext
    ? `\nSequence position: ${input.stepContext}\nThis is one touch in a multi-step sequence, not a standalone email — follow the SPBC framework (section 5.2) and write an angle genuinely specific to this position, not a generic template that could sit at any step.`
    : '';

  const user = `Campaign offer/context: ${input.about}
${senderCtx}
Requested tone: ${input.tone ?? 'match what the audience and awareness stage in the knowledge base call for'}
${stepCtx}
Target segment (this is the ONLY audience information you have — use it as the concrete grounding fact per section 4 of the knowledge base, do not invent details beyond what's given):
${input.segment.signalSummary}

Follow the Generation Protocol (section 7) and the single-email structure (section 5.1). Write ONE email for this segment.

${DRAFT_OUTPUT_CONTRACT}`;

  const raw = await callClaude(apiKey, system, user, 8192);
  const parsed = extractJson(raw);
  return {
    subject: String(parsed.subject ?? ''),
    textBody: String(parsed.textBody ?? ''),
    htmlBody: String(parsed.htmlBody ?? ''),
    hookUsed: String(parsed.hookUsed ?? ''),
  };
}

async function critiqueAndRevise(
  apiKey: string,
  knowledgeBase: string,
  draft: { subject: string; textBody: string; htmlBody: string; hookUsed: string },
  segment: CampaignSegment,
): Promise<{ subject: string; textBody: string; htmlBody: string; changed: boolean }> {
  const system = `${knowledgeBase}\n\n---\n\nYou are a strict, independent editor. You did not write the draft below — your only job is to run it through the Self-Critique Checklist (section 8) point by point and fix anything that fails, including anything from the banned-vocabulary and banned-structural-pattern lists in section 2 that slipped through. Be genuinely critical — most first drafts fail at least one checklist item.`;

  const user = `Segment this was written for: ${segment.signalSummary}

Draft to review:
SUBJECT: ${draft.subject}

TEXT BODY:
${draft.textBody}

HTML BODY:
${draft.htmlBody}

Run the full checklist in section 8. Return ONLY valid JSON in exactly this shape:
{"subject": "...", "textBody": "...", "htmlBody": "...", "changed": true|false, "notes": "one sentence on what, if anything, failed the checklist and was fixed"}

If the draft already passes every checklist item, return it unchanged with "changed": false. Do not make stylistic changes for their own sake — only fix genuine checklist failures.`;

  const raw = await callClaude(apiKey, system, user, 8192);
  const parsed = extractJson(raw);
  return {
    subject: String(parsed.subject ?? draft.subject),
    textBody: String(parsed.textBody ?? draft.textBody),
    htmlBody: String(parsed.htmlBody ?? draft.htmlBody),
    changed: Boolean(parsed.changed),
  };
}

export async function generateSegmentEmail(apiKey: string, input: GenerateCopyInput): Promise<GeneratedEmail> {
  const knowledgeBase = getEmailKnowledgeBase();
  const draft = await draftEmail(apiKey, knowledgeBase, input);

  let final: { subject: string; textBody: string; htmlBody: string } = draft;
  let revised = false;
  try {
    const critiqued = await critiqueAndRevise(apiKey, knowledgeBase, draft, input.segment);
    final = critiqued;
    revised = critiqued.changed;
  } catch (err) {
    // The draft is still a genuinely knowledge-base-grounded email even if
    // the critique pass itself fails (rate limit, transient API error) —
    // better to return it than to fail the whole generation over a
    // best-effort second pass.
    logger.warn({ err }, 'Critique/revise pass failed — returning unrevised draft');
  }

  return {
    segmentLabel: input.segment.label,
    matchCount: input.segment.matchCount,
    matchPct: input.segment.matchPct,
    subject: final.subject,
    textBody: final.textBody,
    htmlBody: final.htmlBody,
    hookUsed: draft.hookUsed,
    revised,
  };
}
