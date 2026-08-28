import { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { WorkOS } from '@workos-inc/node';
import { prisma } from '../../lib/prisma.js';
import { signSession, verifySession } from '../../lib/session.js';
import { config } from '../../config.js';
import { Errors } from '../../plugins/errorHandler.js';
import { sendEmail, welcomeEmail, loginAlertEmail } from '../../lib/email.js';
import { hashApiKey } from '../../lib/crypto.js';

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
  // ─── Generic social/SSO initiator ──────────────────────────────────────────
  // GET /auth/login/:provider  — provider: google | microsoft | github | sso
  // Also keeps the legacy /auth/sso/login alias for backwards compat.
  async function initiateLogin(
    provider: 'GoogleOAuth' | 'MicrosoftOAuth' | 'GitHubOAuth' | 'authkit',
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    if (!config.WORKOS_API_KEY || !config.WORKOS_CLIENT_ID) {
      return reply.status(501).send({
        error: 'Auth is not configured on this server.',
        docs: 'Set WORKOS_API_KEY and WORKOS_CLIENT_ID environment variables.',
      });
    }
    const { redirect_uri } = request.query as Record<string, string>;
    const state = Buffer.from(
      JSON.stringify({ redirect_uri: redirect_uri ?? config.DASHBOARD_URL }),
    ).toString('base64url');

    const authorizationURL = getWorkOS().userManagement.getAuthorizationUrl({
      provider,
      clientId: config.WORKOS_CLIENT_ID,
      redirectUri: `${apiBase()}/auth/sso/callback`,
      state,
    });
    return reply.redirect(302, authorizationURL);
  }

  fastify.get('/auth/login/google', (req, rep) => initiateLogin('GoogleOAuth', req, rep));
  fastify.get('/auth/login/microsoft', (req, rep) => initiateLogin('MicrosoftOAuth', req, rep));
  fastify.get('/auth/login/github', (req, rep) => initiateLogin('GitHubOAuth', req, rep));
  fastify.get('/auth/login/sso', (req, rep) => initiateLogin('authkit', req, rep));

  // Legacy alias kept so existing bookmarks / older clients still work
  fastify.get('/auth/sso/login', (req, rep) => initiateLogin('authkit', req, rep));

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
        const keyHash = hashApiKey(raw);

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

      // Welcome email on first sign-in (new key = new user)
      const isNewUser = !await prisma.apiKey.findFirst({ where: { ownerId: user.id, isActive: true, NOT: { id: apiKey.id } } });
      if (isNewUser) {
        const msg = welcomeEmail(apiKey.keyPrefix, workosUser.firstName);
        void sendEmail(user.email, msg.subject, msg.html);
      }

      // Login alert on every sign-in
      const loginMsg = loginAlertEmail({
        browser: request.headers['user-agent']?.slice(0, 80) ?? 'Unknown browser',
        location: 'Unknown location',
        ip: (request.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? request.ip ?? 'Unknown',
        time: new Date().toUTCString(),
        firstName: workosUser.firstName,
      });
      void sendEmail(user.email, loginMsg.subject, loginMsg.html);

      const token = await signSession({
        userId: user.id,
        email: user.email,
        primaryKeyId: apiKey.id,
      });

      const separator = redirectTarget.includes('?') ? '&' : '?';
      return reply.redirect(302, `${redirectTarget}${separator}token=${encodeURIComponent(token)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fastify.log.error({ err, msg }, 'SSO callback failed');
      const errParam = encodeURIComponent(msg.slice(0, 120));
      return reply.redirect(302, `${config.DASHBOARD_URL}/login?error=sso_failed&detail=${errParam}`);
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
