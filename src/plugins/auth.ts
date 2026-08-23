import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { prisma } from '../lib/prisma.js';
import { hashApiKey } from '../lib/crypto.js';
import { Errors } from './errorHandler.js';
import { logger } from '../lib/logger.js';

// Minimal local type matching the Prisma ApiKey model shape.
// Replace with `import type { ApiKey } from '@prisma/client'` after `prisma generate`.
interface ApiKeyRecord {
  id: string;
  keyHash: string;
  keyPrefix: string;
  label: string | null;
  ownerId: string | null;
  userId: string | null;
  keyRaw: string | null;
  rateLimit: number;
  monthlyLimit: number;
  currentMonthUsage: number;
  monthlySendLimit: number;
  currentMonthSendUsage: number;
  sendUsageResetAt: Date | null;
  usageResetAt: Date | null;
  plan: string;
  isActive: boolean;
  createdAt: Date;
  revokedAt: Date | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    apiKey: ApiKeyRecord;
  }
}

function extractRawKey(request: FastifyRequest): string | null {
  const authHeader = request.headers['authorization'];
  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0]?.toLowerCase() === 'bearer') {
      return parts[1] ?? null;
    }
  }
  const xApiKey = request.headers['x-api-key'];
  if (typeof xApiKey === 'string' && xApiKey.length > 0) {
    return xApiKey;
  }
  return null;
}

// In-process cache: keyHash → { record, expiresAt }
// Avoids a DB hit on every request. Evicts after 60 s, so revocations propagate quickly.
const keyCache = new Map<string, { record: ApiKeyRecord; expiresAt: number }>();
const KEY_CACHE_TTL_MS = 60_000;
const KEY_CACHE_MAX_SIZE = 10_000;

function getCachedKey(hash: string): ApiKeyRecord | null {
  const entry = keyCache.get(hash);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    keyCache.delete(hash);
    return null;
  }
  return entry.record;
}

function setCachedKey(hash: string, record: ApiKeyRecord): void {
  if (keyCache.size >= KEY_CACHE_MAX_SIZE) {
    const firstKey = keyCache.keys().next().value;
    if (firstKey !== undefined) keyCache.delete(firstKey);
  }
  keyCache.set(hash, { record, expiresAt: Date.now() + KEY_CACHE_TTL_MS });
}

async function resolveApiKey(request: FastifyRequest): Promise<void> {
  const rawKey = extractRawKey(request);

  if (!rawKey) {
    throw Errors.unauthorized(
      'No API key provided. Use "Authorization: Bearer <key>" or "X-API-Key: <key>".',
    );
  }

  const hash = hashApiKey(rawKey);

  const cached = getCachedKey(hash);
  if (cached) {
    if (!cached.isActive) throw Errors.unauthorized('API key has been revoked.');
    request.apiKey = cached;
    return;
  }

  let apiKey: ApiKeyRecord | null;
  try {
    apiKey = await prisma.apiKey.findUnique({ where: { keyHash: hash } });
  } catch (err) {
    logger.error({ err }, 'Database error during API key lookup');
    throw Errors.serviceUnavailable('Database');
  }

  if (!apiKey) throw Errors.unauthorized('Invalid API key.');
  if (!apiKey.isActive) throw Errors.unauthorized('API key has been revoked.');
  if (apiKey.revokedAt && apiKey.revokedAt <= new Date()) {
    throw Errors.unauthorized('API key has expired.');
  }

  setCachedKey(hash, apiKey);
  request.apiKey = apiKey;
}

async function authPluginFn(fastify: FastifyInstance): Promise<void> {
  fastify.decorateRequest('apiKey', null);
  fastify.decorateRequest('authenticate', async function (this: FastifyRequest) {
    await resolveApiKey(this);
  });
}

/**
 * Prehandler — attach to any route requiring authentication:
 *   { preHandler: [requireAuth] }
 */
export async function requireAuth(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  await resolveApiKey(request);
}

export const authPlugin = fp(authPluginFn, {
  name: 'auth',
});
