import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { verifyUnsubToken } from '../../lib/unsubscribe.js';

const CONFIRMATION_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Unsubscribed</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f9fafb; }
  .card { background: white; border-radius: 12px; padding: 48px; text-align: center; max-width: 400px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  h1 { font-size: 24px; color: #111827; margin: 0 0 12px; }
  p { color: #6b7280; margin: 0; }
</style>
</head>
<body>
<div class="card">
  <h1>Unsubscribed</h1>
  <p>You've been successfully removed from this mailing list. You won't receive further emails from this sender.</p>
</div>
</body>
</html>`;

const ALREADY_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Already unsubscribed</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f9fafb;} .card{background:white;border-radius:12px;padding:48px;text-align:center;max-width:400px;}</style>
</head><body><div class="card"><h1>Already unsubscribed</h1><p>This email is already removed from the mailing list.</p></div></body></html>`;

const INVALID_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Invalid link</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f9fafb;} .card{background:white;border-radius:12px;padding:48px;text-align:center;max-width:400px;}</style>
</head><body><div class="card"><h1>Invalid or expired link</h1><p>This unsubscribe link is invalid or has expired.</p></div></body></html>`;

export async function unsubscribeRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /v1/unsubscribe?token=... — browser one-click unsubscribe
  fastify.get(
    '/unsubscribe',
    { preHandler: [requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { token } = request.query as { token?: string };

      if (!token) {
        return reply.status(400).header('Content-Type', 'text/html').send(INVALID_HTML);
      }

      const payload = verifyUnsubToken(token);
      if (!payload) {
        return reply.status(400).header('Content-Type', 'text/html').send(INVALID_HTML);
      }

      const { email } = payload;

      const existing = await prisma.suppression.findUnique({ where: { email } });
      if (existing) {
        return reply.status(200).header('Content-Type', 'text/html').send(ALREADY_HTML);
      }

      await prisma.suppression.create({
        data: { email, reason: 'unsubscribed', apiKeyId: payload.apiKeyId },
      });

      // Also update any contact memberships for this email
      await prisma.contactListMembership.updateMany({
        where: { contact: { email } },
        data: { status: 'unsubscribed', unsubscribedAt: new Date() },
      }).catch(() => { /* ignore if table doesn't have records */ });

      return reply.status(200).header('Content-Type', 'text/html').send(CONFIRMATION_HTML);
    },
  );

  // POST /v1/unsubscribe — RFC 8058 machine-readable one-click
  fastify.post(
    '/unsubscribe',
    { preHandler: [requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as Record<string, string> | undefined;
      const token = (body?.['token'] as string | undefined) ?? (request.query as Record<string, string>)['token'];

      // RFC 8058 also accepts form-encoded body with List-Unsubscribe=One-Click
      const isRfc8058 = body?.['List-Unsubscribe'] === 'One-Click';

      if (!token && !isRfc8058) {
        return reply.status(400).send({ error: 'Missing token' });
      }

      if (token) {
        const payload = verifyUnsubToken(token);
        if (!payload) return reply.status(400).send({ error: 'Invalid or expired token' });

        await prisma.suppression.upsert({
          where: { email: payload.email },
          create: { email: payload.email, reason: 'unsubscribed', apiKeyId: payload.apiKeyId },
          update: {},
        });
      }

      return reply.status(200).send({ unsubscribed: true });
    },
  );
}
