import { readFileSync } from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

// The knowledge base is a checked-in markdown doc (docs/email-generation-
// knowledge-base.md) rather than a string baked into this file, so it can be
// read, reviewed, and revised on its own — including by non-engineers — as
// real send data comes in, without touching application code. Loaded once
// and cached; the doc changes by editing the file and redeploying, not by
// user action, so there's no need to re-read it per request.
let cached: string | null = null;

const FALLBACK_KNOWLEDGE_BASE = `Write specific, human, high-converting cold email copy. Never use corporate clichés, generic openers ("I hope this finds you well"), or filler like "leverage", "seamless", "robust", "unlock". Every email needs one real, specific, checkable detail about the recipient or their segment — not just a name and company. Keep first-touch emails under 100 words, use a single small low-friction ask, and vary sentence rhythm instead of writing symmetrical AI-shaped sentences.`;

export function getEmailKnowledgeBase(): string {
  if (cached) return cached;

  try {
    // Compiles to CommonJS — __dirname is dist/lib at runtime (or src/lib
    // under tsx in dev), both one level away from the repo root the same way.
    const docPath = path.resolve(__dirname, '../../docs/email-generation-knowledge-base.md');
    cached = readFileSync(docPath, 'utf-8');
    return cached;
  } catch (err) {
    logger.error({ err }, 'Failed to load email-generation-knowledge-base.md — falling back to condensed inline rules');
    cached = FALLBACK_KNOWLEDGE_BASE;
    return cached;
  }
}
