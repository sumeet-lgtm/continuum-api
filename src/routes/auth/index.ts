import { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { WorkOS } from '@workos-inc/node';
import { prisma } from '../../lib/prisma.js';
import { signSession, verifySession } from '../../lib/session.js';
import { config } from '../../config.js';
import { Errors } from '../../plugins/errorHandler.js';
import { sendEmail, welcomeEmail, loginAlertEmail } from '../../lib/email.js';
import { hashApiKey } from '../../lib/crypto.js';
import { requireIpRateLimit } from '../../plugins/rateLimit.js';
import { logAudit } from '../../lib/audit.js';
import { getPlanLimit, getSendLimit } from '../../plugins/usageMeter.js';

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
    return reply.redirect(authorizationURL, 302);
  }

  // No API key exists yet at this point in the flow, so these are IP-scoped
  // rather than key-scoped — previously unlimited.
  const loginRateLimit = { preHandler: [requireIpRateLimit('auth-login', 30)] };
  fastify.get('/auth/login/google', loginRateLimit, (req, rep) => initiateLogin('GoogleOAuth', req, rep));
  fastify.get('/auth/login/microsoft', loginRateLimit, (req, rep) => initiateLogin('MicrosoftOAuth', req, rep));
  fastify.get('/auth/login/github', loginRateLimit, (req, rep) => initiateLogin('GitHubOAuth', req, rep));
  fastify.get('/auth/login/sso', loginRateLimit, (req, rep) => initiateLogin('authkit', req, rep));

  // Legacy alias kept so existing bookmarks / older clients still work
  fastify.get('/auth/sso/login', loginRateLimit, (req, rep) => initiateLogin('authkit', req, rep));

  // ─── GET /auth/sso/callback ─────────────────────────────────────────────────
  // WorkOS redirects here after authentication. Exchanges code for a user
  // profile, upserts the user row, creates an API key if they don't have one,
  // and issues a signed session JWT before redirecting to the dashboard.
  // This is the expensive step (a real WorkOS API round-trip plus DB writes),
  // so it gets its own IP-scoped budget rather than sharing the initiators'.
  fastify.get('/auth/sso/callback', { preHandler: [requireIpRateLimit('auth-callback', 30)] }, async (request: FastifyRequest, reply: FastifyReply) => {
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
      return reply.redirect(`${redirectTarget}?error=missing_code`, 302);
    }

    try {
      const authResult = await getWorkOS().userManagement.authenticateWithCode({
        clientId: config.WORKOS_CLIENT_ID!,
        code,
      });
      const workosUser = authResult.user;
      const workosOrgId = (authResult as unknown as Record<string, unknown>).organizationId as string | undefined;

      // Find the user by WorkOS ID first (the common case), falling back to
      // email — WorkOS can hand back a different user id for the same person
      // across sign-ins (e.g. they used Google last time, Microsoft this
      // time, and automatic account linking isn't configured on every
      // connection). Without this fallback, upserting on workosId alone
      // tries to INSERT a second row with the same email and dies on the
      // unique constraint instead of just linking the new workosId to the
      // existing account.
      const existingUser =
        (await prisma.user.findUnique({ where: { workosId: workosUser.id } })) ??
        (await prisma.user.findUnique({ where: { email: workosUser.email } }));

      const user = existingUser
        ? await prisma.user.update({
            where: { id: existingUser.id },
            data: {
              email: workosUser.email,
              workosId: workosUser.id,
              firstName: workosUser.firstName ?? null,
              lastName: workosUser.lastName ?? null,
              ...(workosOrgId ? { orgId: workosOrgId } : {}),
            },
          })
        : await prisma.user.create({
            data: {
              email: workosUser.email,
              workosId: workosUser.id,
              firstName: workosUser.firstName ?? null,
              lastName: workosUser.lastName ?? null,
              orgId: workosOrgId ?? null,
            },
          });

      // Capture org membership if user authenticated via an org SSO
      let orgRole: string | undefined;
      if (workosOrgId) {
        try {
          const memberships = await getWorkOS().userManagement.listOrganizationMemberships({
            userId: workosUser.id,
            organizationId: workosOrgId,
          });
          const activeMembership = memberships.data.find((m) => m.status === 'active');
          if (activeMembership) {
            const anyMembership = activeMembership as unknown as Record<string, unknown> & { role?: { slug?: string } };
            const roleSlug = anyMembership.role?.slug ?? 'member';
            orgRole = roleSlug;
            await prisma.orgMember.upsert({
              where: { membershipId: activeMembership.id },
              create: {
                userId: user.id,
                orgId: workosOrgId,
                membershipId: activeMembership.id,
                role: roleSlug,
                email: workosUser.email,
                status: 'active',
              },
              update: { role: roleSlug, status: 'active', email: workosUser.email },
            });
          }
        } catch {
          // Non-fatal — proceed without org role in JWT
        }
      }

      // Check if this email belongs to a team member of another workspace
      const teamMembership = await prisma.teamMember.findFirst({
        where: { email: workosUser.email.toLowerCase() },
        orderBy: { joinedAt: 'asc' },
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
            orgId: workosOrgId ?? null,
          },
        });
      } else if (workosOrgId && !apiKey.orgId) {
        // Key predates the user joining this org (or predates this field
        // existing at all) — backfill it so org-admin key management
        // covers keys that were already active, not just newly created ones.
        apiKey = await prisma.apiKey.update({
          where: { id: apiKey.id },
          data: { orgId: workosOrgId },
        });
      }

      // If the user is a team member, override the primary key to the workspace key
      let workspaceRole: string | undefined;
      if (teamMembership) {
        const workspaceKey = await prisma.apiKey.findFirst({
          where: { id: teamMembership.workspaceKeyId, isActive: true },
        });
        if (workspaceKey) {
          apiKey = workspaceKey;
          workspaceRole = teamMembership.role;
        }
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
        workspaceRole,
        orgId: workosOrgId,
        orgRole,
      });

      void logAudit(workosOrgId ?? null, 'user.signed_in', {
        id: user.id,
        email: user.email,
        ip: (request.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? request.ip,
      }, [{ type: 'user', id: user.id, name: user.email }], apiKey.id);

      const separator = redirectTarget.includes('?') ? '&' : '?';
      return reply.redirect(`${redirectTarget}${separator}token=${encodeURIComponent(token)}`, 302);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fastify.log.error({ err, msg }, 'SSO callback failed');
      void logAudit(null, 'user.sign_in_failed', {
        id: 'unknown',
        email: 'unknown',
        ip: (request.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? request.ip,
      }, [{ type: 'auth', id: 'sso_callback', name: msg.slice(0, 100) }]);
      const errParam = encodeURIComponent(msg.slice(0, 120));
      return reply.redirect(`${config.DASHBOARD_URL}/login?error=sso_failed&detail=${errParam}`, 302);
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

    const KEY_SELECT = {
      id: true, keyPrefix: true, keyRaw: true, label: true,
      name: true, plan: true, permission: true,
      currentMonthUsage: true, monthlyLimit: true,
      currentMonthSendUsage: true, monthlySendLimit: true,
      lastUsedAt: true, createdAt: true,
    } as const;

    const [user, ownKeys] = await Promise.all([
      prisma.user.findUnique({ where: { id: payload.userId } }),
      prisma.apiKey.findMany({
        where: { ownerId: payload.userId, isActive: true },
        select: KEY_SELECT,
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    if (!user) {
      throw Errors.unauthorized('User account not found');
    }

    // If primaryKeyId belongs to a workspace the user is a member of (not their own key),
    // fetch it separately so the frontend can use it as the active key.
    let apiKeys = ownKeys as typeof ownKeys;
    if (payload.primaryKeyId && !ownKeys.find((k) => k.id === payload.primaryKeyId)) {
      const workspaceKey = await prisma.apiKey.findUnique({
        where: { id: payload.primaryKeyId },
        select: KEY_SELECT,
      });
      if (workspaceKey) {
        apiKeys = [workspaceKey, ...ownKeys];
      }
    }

    return reply.status(200).send({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
      },
      // monthlyLimit/monthlySendLimit are the raw per-key override columns
      // (default 1,000/500, only meaningful for a plan not in PLAN_LIMITS) —
      // the real ceiling for a standard plan is computed from the plan
      // itself and always wins over that stored default, so the dashboard
      // was showing every paying customer their Free-tier number. These
      // effective* fields are what the UI should actually display.
      apiKeys: apiKeys.map((k) => ({
        ...k,
        effectiveMonthlyLimit: getPlanLimit(k.plan, k.monthlyLimit),
        effectiveMonthlySendLimit: getSendLimit(k.plan, k.monthlySendLimit),
      })),
      primaryKeyId: payload.primaryKeyId,
      workspaceRole: (payload as { workspaceRole?: string }).workspaceRole,
    });
  });

  // ─── PATCH /auth/profile ────────────────────────────────────────────────────
  fastify.patch('/auth/profile', async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) throw Errors.unauthorized('Missing session token');
    let payload: { userId: string };
    try { payload = await verifySession(authHeader.slice(7)); }
    catch { throw Errors.unauthorized('Session expired — please sign in again'); }

    const body = request.body as Record<string, unknown>;
    const firstName = typeof body.firstName === 'string' ? body.firstName.trim().slice(0, 100) || null : undefined;
    const lastName  = typeof body.lastName  === 'string' ? body.lastName.trim().slice(0, 100)  || null : undefined;

    const update: Record<string, unknown> = {};
    if (firstName !== undefined) update.firstName = firstName;
    if (lastName  !== undefined) update.lastName  = lastName;

    if (Object.keys(update).length === 0) {
      return reply.status(400).send({ error: 'No valid fields to update' });
    }

    const user = await prisma.user.update({ where: { id: payload.userId }, data: update });
    return reply.status(200).send({ id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName });
  });

  // ─── DELETE /auth/account ────────────────────────────────────────────────────
  // Deletes the session-authenticated user's login identity (WorkOS + Prisma
  // User row) in addition to revoking all their API keys. This is the
  // session-auth counterpart to DELETE /v1/account (API-key-auth, data only).
  fastify.delete('/auth/account', async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) throw Errors.unauthorized('Missing session token');
    let payload: { userId: string; email: string };
    try { payload = await verifySession(authHeader.slice(7)); }
    catch { throw Errors.unauthorized('Session expired — please sign in again'); }

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, email: true, workosId: true },
    });
    if (!user) throw Errors.notFound('User not found');

    // Revoke all API keys first so running integrations fail fast
    await prisma.apiKey.updateMany({
      where: { ownerId: user.id },
      data: { isActive: false, revokedAt: new Date() },
    });

    // Delete WorkOS identity (removes SSO connection, memberships, etc.)
    if (user.workosId && config.WORKOS_API_KEY) {
      try {
        await getWorkOS().userManagement.deleteUser(user.workosId);
      } catch (err) {
        fastify.log.warn({ err, workosId: user.workosId }, 'WorkOS user deletion failed (proceeding with local delete)');
      }
    }

    // Delete local user record (cascades to OrgMember via FK)
    await prisma.user.delete({ where: { id: user.id } });

    fastify.log.warn({ userId: user.id, email: user.email }, 'User account deleted via DELETE /auth/account');
    return reply.status(200).send({ deleted: true });
  });

  // ─── POST /auth/accept-invite ────────────────────────────────────────────────
  // Accepts a team workspace invitation. Requires a valid session JWT (user must
  // be logged in). Creates a TeamMember record and returns a refreshed session
  // token with the workspace key set as primaryKeyId.
  fastify.post('/auth/accept-invite', async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) throw Errors.unauthorized('Missing session token');
    let payload: { userId: string; email: string };
    try { payload = await verifySession(authHeader.slice(7)); }
    catch { throw Errors.unauthorized('Session expired — please sign in again'); }

    const { token } = request.body as { token?: string };
    if (!token) throw Errors.validationFailed('Missing invite token');

    const invite = await prisma.teamInvite.findUnique({ where: { token } });
    if (!invite || invite.status !== 'pending') throw Errors.notFound('Invite not found or already used');
    if (invite.expiresAt < new Date()) throw Errors.validationFailed('This invite link has expired. Ask the workspace owner for a new one.');
    if (invite.inviteeEmail !== payload.email.toLowerCase()) {
      throw Errors.validationFailed('This invite was sent to a different email address. Sign in with that email to accept it.');
    }

    // Create team member (idempotent)
    await prisma.teamMember.upsert({
      where: { workspaceKeyId_email: { workspaceKeyId: invite.workspaceKeyId, email: invite.inviteeEmail } },
      create: {
        workspaceKeyId: invite.workspaceKeyId,
        email: invite.inviteeEmail,
        role: invite.role,
        invitedBy: invite.invitedBy,
      },
      update: { role: invite.role },
    });

    await prisma.teamInvite.update({ where: { token }, data: { status: 'accepted' } });

    const workspaceKey = await prisma.apiKey.findFirst({ where: { id: invite.workspaceKeyId, isActive: true } });
    if (!workspaceKey) throw Errors.notFound('Workspace not found or no longer active');

    const newToken = await signSession({
      userId: payload.userId,
      email: payload.email,
      primaryKeyId: workspaceKey.id,
      workspaceRole: invite.role,
    });

    return reply.status(200).send({ ok: true, token: newToken, workspaceRole: invite.role });
  });

  // ─── POST /auth/logout ──────────────────────────────────────────────────────
  fastify.post('/auth/logout', async (_request, reply) => {
    return reply.status(200).send({ ok: true });
  });

  // ─── Shared session resolver for enterprise endpoints ───────────────────────
  async function resolveSessionUser(request: FastifyRequest): Promise<{ id: string; email: string; orgId: string | null }> {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) throw Errors.unauthorized('Missing session token');
    let payload: { userId: string };
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
    return user;
  }

  // Personal email domains that shouldn't get enterprise SSO
  const PERSONAL_DOMAINS = new Set([
    'gmail.com','googlemail.com','yahoo.com','yahoo.co.in','outlook.com',
    'hotmail.com','live.com','icloud.com','me.com','protonmail.com',
    'proton.me','aol.com','yandex.com','mail.com',
  ]);

  // ─── GET /auth/enterprise/status ────────────────────────────────────────────
  fastify.get('/auth/enterprise/status', async (request, reply) => {
    const user = await resolveSessionUser(request);
    const domain = user.email.split('@')[1] ?? '';

    if (PERSONAL_DOMAINS.has(domain)) {
      return reply.send({ configured: false, eligible: false, domain, reason: 'personal_domain' });
    }

    if (!user.orgId) {
      return reply.send({ configured: false, eligible: true, domain, organizationId: null });
    }

    try {
      const connections = await getWorkOS().sso.listConnections({ organizationId: user.orgId });
      const active = connections.data.filter((c) => c.state === 'active');
      const firstConn = active[0] as (typeof active[number] & { connectionType?: string }) | undefined;
      return reply.send({
        configured: active.length > 0,
        eligible: true,
        domain,
        organizationId: user.orgId,
        connectionCount: active.length,
        connectionType: firstConn?.connectionType ?? null,
      });
    } catch {
      return reply.send({ configured: false, eligible: true, domain, organizationId: user.orgId });
    }
  });

  // ─── POST /auth/enterprise/portal ───────────────────────────────────────────
  // Creates a WorkOS Organization for the user's domain (once) then returns a
  // short-lived Admin Portal link where the org admin configures their IdP.
  fastify.post('/auth/enterprise/portal', async (request, reply) => {
    const user = await resolveSessionUser(request);
    const domain = user.email.split('@')[1] ?? '';

    if (PERSONAL_DOMAINS.has(domain)) {
      throw Errors.validationFailed([{ field: 'domain', message: 'Enterprise SSO is not available for personal email domains.' }]);
    }

    let orgId = user.orgId;

    if (!orgId) {
      const org = await getWorkOS().organizations.createOrganization({
        name: domain,
        domainData: [{ domain, state: 'verified' as unknown as never }],
      });
      orgId = org.id;
      await prisma.user.update({ where: { id: user.id }, data: { orgId } });
    }

    const { link } = await getWorkOS().adminPortal.generateLink({
      organization: orgId,
      intent: 'sso',
    });

    return reply.status(200).send({ link, organizationId: orgId, domain });
  });
}
