import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { prisma } from '../lib/prisma.js';
import { hashApiKey } from '../lib/crypto.js';
import { Errors } from './errorHandler.js';
import { logger } from '../lib/logger.js';
import { verifySession } from '../lib/session.js';

// Minimal local type matching the Prisma ApiKey model shape.
// Replace with `import type { ApiKey } from '@prisma/client'` after `prisma generate`.
interface ApiKeyRecord {
  id: string;
  keyHash: string;
  keyPrefix: string;
  name: string | null;
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
  permission: string;
  restrictedDomainId: string | null;
  lastUsedAt: Date | null;
}

export interface OrgSessionUser {
  userId: string;
  email: string;
  orgId: string | null;
  orgRole: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    apiKey: ApiKeyRecord;
    sessionUser?: OrgSessionUser;
  }
  interface FastifyContextConfig {
    // Declared on the WorkOS/Cal.com webhook routes, but nothing currently
    // populates request.rawBody from it — see routes/webhooks/{workos,calcom}.ts.
    rawBody?: boolean;
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
  // Placeholder until requireAuth's preHandler sets the real value — every
  // actual read happens after that, so request.apiKey's declared type stays
  // non-null everywhere it's used. Fastify v5 requires the decorator default
  // to match that type, hence the cast.
  fastify.decorateRequest('apiKey', null as unknown as ApiKeyRecord);
  fastify.decorateRequest('authenticate', async function (this: FastifyRequest) {
    await resolveApiKey(this);
  });
}

/**
 * Prehandler — attach to any route requiring authentication:
 *   { preHandler: [requireAuth] }
 */
// Routes a sending_access key may call (starts-with match on request.url)
const SEND_ONLY_ALLOWED = ['/v1/send', '/track/', '/v1/unsubscribe'];

export async function requireAuth(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  await resolveApiKey(request);
  if (
    request.apiKey.permission === 'sending_access' &&
    !SEND_ONLY_ALLOWED.some((prefix) => request.url.startsWith(prefix))
  ) {
    throw Errors.forbidden(
      'This API key only has sending access. A full_access key is required for this endpoint.',
    );
  }
}

/**
 * Prehandler — blocks sending_access keys from non-send routes (verify, monitor, lists, etc.)
 * Chain AFTER requireAuth: { preHandler: [requireAuth, requireFullAccess] }
 */
export async function requireFullAccess(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (request.apiKey.permission !== 'full_access') {
    throw Errors.forbidden('This API key only has sending access. A full_access key is required for this endpoint.');
  }
}

export const authPlugin = fp(authPluginFn, {
  name: 'auth',
});

/**
 * Prehandler — verifies session JWT and populates request.sessionUser.
 * Use on org routes that need session context (not API key auth).
 */
export async function requireOrgSession(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    throw Errors.unauthorized('Missing session token');
  }
  let payload: { userId: string; email: string; orgId?: string; orgRole?: string };
  try {
    payload = await verifySession(authHeader.slice(7));
  } catch {
    throw Errors.unauthorized('Session expired — please sign in again');
  }
  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { id: true, email: true, orgId: true },
  });
  if (!user) throw Errors.unauthorized('User not found');
  request.sessionUser = {
    userId: user.id,
    email: user.email,
    orgId: payload.orgId ?? user.orgId ?? null,
    orgRole: payload.orgRole ?? null,
  };
}

/**
 * Prehandler — requires session JWT AND admin role in the org.
 * Chain after requireOrgSession or use standalone (it calls requireOrgSession internally).
 */
export async function requireOrgAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await requireOrgSession(request, reply);
  if (request.sessionUser?.orgRole !== 'admin') {
    throw Errors.forbidden('Admin role required for this action');
  }
}
