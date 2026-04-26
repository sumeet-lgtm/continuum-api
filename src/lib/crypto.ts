import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * Hash a raw API key for storage in the database.
 * Uses SHA-256(salt + rawKey) — the salt prevents rainbow table attacks.
 * The raw key is never stored; only the hash is persisted.
 */
export function hashApiKey(rawKey: string): string {
  return crypto
    .createHash('sha256')
    .update(config.API_KEY_SALT + rawKey)
    .digest('hex');
}

/**
 * Generate a new random API key.
 * Format: cnt_<32 random hex chars>
 * The prefix "cnt_" makes Continuum keys easy to identify in logs.
 */
export function generateApiKey(): string {
  const random = crypto.randomBytes(24).toString('hex');
  return `cnt_${random}`;
}

/**
 * Extract the display prefix from a raw API key (first 8 chars after "cnt_").
 * Used to identify keys in the UI without exposing the full key.
 */
export function getKeyPrefix(rawKey: string): string {
  return rawKey.slice(0, 12); // "cnt_" + 8 chars
}

/**
 * Compute HMAC-SHA256 signature for webhook payload delivery.
 * Format returned: "sha256=<hex digest>"
 * Receivers verify by computing the same HMAC with their secret.
 */
export function signWebhookPayload(secret: string, body: string): string {
  const hmac = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  return `sha256=${hmac}`;
}

/**
 * Verify a webhook signature from an incoming request.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  signature: string,
): boolean {
  const expected = signWebhookPayload(secret, body);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(signature, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Generate a random webhook secret.
 * 32 bytes of entropy encoded as hex — 64 character string.
 */
export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Generate a random ID with an optional prefix.
 * Used for cuid-style IDs when Prisma is not available (e.g. worker payloads).
 */
export function generateId(prefix?: string): string {
  const id = crypto.randomBytes(16).toString('hex');
  return prefix ? `${prefix}_${id}` : id;
}
