import { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { WorkOS } from '@workos-inc/node';
import { prisma } from '../../lib/prisma.js';
import { signSession, verifySession } from '../../lib/session.js';
import { config } from '../../config.js';
import { Errors } from '../../plugins/errorHandler.js';

let _workos: WorkOS | null = null;

function getWorkOS(): WorkOS {
  if (!_workos) {
    if (!config.WORKOS_API_KEY) {
      throw new Error('WORKOS_API_KEY is not configured');
    }
    _workos = new WorkOS(config.WORKOS_API_KEY);
  }
  return _workos;
}

function apiBase(): string {
  return config.API_BASE_URL ?? 'https://api.continuumapi.com';
}

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  // ─── GET /auth/sso/login ────────────────────────────────────────────────────
  // Initiates the WorkOS AuthKit flow. Accepts optional redirect_uri query param
  // so the dashboard can control where the callback lands after login.
  fastify.get('/auth/sso/login', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!config.WORKOS_API_KEY || !config.WORKOS_CLIENT_ID) {
      return reply.status(501).send({
        error: 'SSO is not configured on this server.',
        docs: 'Set WORKOS_API_KEY and WORKOS_CLIENT_ID environment variables.',
      });
    }

    const { redirect_uri } = request.query as Record<string, string>;
    const state = Buffer.from(
      JSON.stringify({ redirect_uri: redirect_uri ?? config.DASHBOARD_URL }),
    ).toString('base64url');

    const authorizationURL = getWorkOS().userManagement.getAuthorizationUrl({
      provider: 'authkit',
      clientId: config.WORKOS_CLIENT_ID,
      redirectUri: `${apiBase()}/auth/sso/callback`,
      state,
    });

    return reply.redirect(302, authorizationURL);
  });

  // ─── GET /auth/sso/callback ─────────────────────────────────────────────────
  // WorkOS redirects here after authentication. Exchanges code for a user
  // profile, upserts the user row, creates an API key if they don't have one,
  // and issues a signed session JWT before redirecting to the dashboard.
  fastify.get('/auth/sso/callback', async (request: FastifyRequest, reply: FastifyReply) => {
    const { code, state } = request.query as Record<string, string>;

    let redirectTarget = config.DASHBOARD_URL;
    try {
      if (state) {
        const parsed = JSON.parse(Buffer.from(state, 'base64url').toString());
        if (typeof parsed.redirect_uri === 'string') {
          redirectTarget = parsed.redirect_uri;
        }
      }
    } catch {
      // malformed state — fall back to default dashboard URL
    }

    if (!code) {
      return reply.redirect(302, `${redirectTarget}?error=missing_code`);
    }

    try {
      const { user: workosUser } = await getWorkOS().userManagement.authenticateWithCode({
        clientId: config.WORKOS_CLIENT_ID!,
        code,
      });

      // Upsert user by WorkOS ID
      const user = await prisma.user.upsert({
        where: { workosId: workosUser.id },
        create: {
          email: workosUser.email,
          workosId: workosUser.id,
          firstName: workosUser.firstName ?? null,
          lastName: workosUser.lastName ?? null,
        },
        update: {
          email: workosUser.email,
          firstName: workosUser.firstName ?? null,
          lastName: workosUser.lastName ?? null,
        },
      });

      // Find or create a primary API key scoped to this user
      let apiKey = await prisma.apiKey.findFirst({
        where: { ownerId: user.id, isActive: true },
        orderBy: { createdAt: 'asc' },
      });

      if (!apiKey) {
        const raw = `cont_live_${crypto.randomUUID().replace(/-/g, '')}`;
        const hashBuf = await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(config.API_KEY_SALT + raw),
        );
        const keyHash = Buffer.from(hashBuf).toString('hex');

        apiKey = await prisma.apiKey.create({
          data: {
            keyHash,
            keyPrefix: raw.slice(0, 8),
            keyRaw: raw,
            label: `${workosUser.firstName ?? workosUser.email.split('@')[0]}'s key`,
            ownerId: user.id,
            plan: 'free',
          },
        });
      }

      const token = await signSession({
        userId: user.id,
        email: user.email,
        primaryKeyId: apiKey.id,
      });

      const separator = redirectTarget.includes('?') ? '&' : '?';
      return reply.redirect(302, `${redirectTarget}${separator}token=${encodeURIComponent(token)}`);
    } catch (err) {
      fastify.log.error(err, 'SSO callback failed');
      return reply.redirect(302, `${config.DASHBOARD_URL}/login?error=sso_failed`);
    }
  });

  // ─── GET /auth/me ───────────────────────────────────────────────────────────
  // Returns the authenticated user's profile and their API keys.
  // Requires: Authorization: Bearer <session_jwt>
  fastify.get('/auth/me', async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw Errors.unauthorized('Missing session token — use /auth/sso/login to sign in');
    }

    let payload;
    try {
      payload = await verifySession(authHeader.slice(7));
    } catch {
      throw Errors.unauthorized('Session expired or invalid — please sign in again');
    }

    const [user, apiKeys] = await Promise.all([
      prisma.user.findUnique({ where: { id: payload.userId } }),
      prisma.apiKey.findMany({
        where: { ownerId: payload.userId, isActive: true },
        select: {
          id: true,
          keyPrefix: true,
          keyRaw: true,
          label: true,
          name: true,
          plan: true,
          permission: true,
          currentMonthUsage: true,
          monthlyLimit: true,
          currentMonthSendUsage: true,
          monthlySendLimit: true,
          lastUsedAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    if (!user) {
      throw Errors.unauthorized('User account not found');
    }

    return reply.status(200).send({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
      },
      apiKeys,
      primaryKeyId: payload.primaryKeyId,
    });
  });

  // ─── POST /auth/logout ──────────────────────────────────────────────────────
  // Stateless — JWTs expire automatically. This endpoint exists for clients
  // to call on logout; they should discard the token on their side.
  fastify.post('/auth/logout', async (_request, reply) => {
    return reply.status(200).send({ ok: true });
  });
}
