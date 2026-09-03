import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit, requireIpRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../plugins/errorHandler.js';
import { generateOptinToken, verifyOptinToken } from '../../lib/optinToken.js';
import { config } from '../../config.js';

const sesClient = new SESv2Client({ region: config.AWS_REGION ?? 'us-east-1' });

const subscribeSchema = z.object({
  email: z.string().email().transform(s => s.trim().toLowerCase()),
  first_name: z.string().max(100).optional(),
  last_name: z.string().max(100).optional(),
  custom_fields: z.record(z.unknown()).optional(),
  gdpr_consent: z.boolean().default(false),
  silent: z.boolean().default(true),
  double_optin: z.boolean().default(false),
  confirm_url: z.string().url().optional(), // base URL for confirmation link; defaults to API origin
});

const importSchema = z.object({
  list_id: z.string(),
  csv_content: z.string(), // base64
});

export async function contactRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /v1/lists/:id/contacts
  fastify.post('/lists/:id/contacts', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id: listId } = request.params as { id: string };
    const parsed = subscribeSchema.safeParse(request.body);
    if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

    const apiKeyId = request.apiKey.id;
    const { email, first_name, last_name, custom_fields, gdpr_consent, double_optin, confirm_url } = parsed.data;

    // Check list ownership
    const list = await prisma.mailingList.findFirst({ where: { id: listId, apiKeyId } });
    if (!list) throw Errors.notFound('List not found.');

    // Suppression check
    const suppressed = await prisma.suppression.findUnique({ where: { email } });
    if (suppressed) {
      throw { statusCode: 422, message: `${email} is suppressed and cannot be subscribed.` };
    }

    // Upsert contact
    const contact = await prisma.contact.upsert({
      where: { apiKeyId_email: { apiKeyId, email } },
      create: { apiKeyId, email, firstName: first_name ?? null, lastName: last_name ?? null, customFields: (custom_fields ?? {}) as Prisma.InputJsonValue },
      update: {
        ...(first_name !== undefined && { firstName: first_name }),
        ...(last_name !== undefined && { lastName: last_name }),
        ...(custom_fields !== undefined && { customFields: custom_fields as Prisma.InputJsonValue }),
      },
      select: { id: true, email: true },
    });

    // Determine initial membership status
    const membershipStatus = double_optin ? 'pending_confirmation' : 'subscribed';

    // Upsert membership
    const membership = await prisma.contactListMembership.upsert({
      where: { contactId_listId: { contactId: contact.id, listId } },
      create: { contactId: contact.id, listId, status: membershipStatus, gdprConsent: gdpr_consent },
      update: { status: membershipStatus, gdprConsent: gdpr_consent },
      select: { id: true, status: true, subscribedAt: true },
    });

    // Update list contact count
    if (!double_optin) {
      await prisma.mailingList.update({
        where: { id: listId },
        data: { contactCount: { increment: 1 } },
      }).catch(() => { /* best effort */ });
    }

    // Send double opt-in confirmation email if requested
    if (double_optin) {
      const token = generateOptinToken(contact.id, listId);
      const baseUrl = confirm_url ?? `https://${request.hostname}/v1/confirm`;
      const confirmLink = `${baseUrl}?token=${token}`;
      const fromEmail = process.env['DEFAULT_FROM_EMAIL'] ?? 'noreply@continuumapi.com';
      const listName = list.name;

      await sesClient.send(new SendEmailCommand({
        FromEmailAddress: `${listName} <${fromEmail}>`,
        Destination: { ToAddresses: [email] },
        Content: {
          Simple: {
            Subject: { Data: `Please confirm your subscription to ${listName}`, Charset: 'UTF-8' },
            Body: {
              Html: {
                Data: `<p>Hi${first_name ? ` ${first_name}` : ''},</p><p>Please confirm your subscription to <strong>${listName}</strong> by clicking the link below:</p><p><a href="${confirmLink}" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">Confirm subscription</a></p><p>This link expires in 7 days. If you did not request this, you can ignore this email.</p>`,
                Charset: 'UTF-8',
              },
              Text: {
                Data: `Please confirm your subscription to ${listName}:\n\n${confirmLink}\n\nThis link expires in 7 days.`,
                Charset: 'UTF-8',
              },
            },
          },
        },
      })).catch(() => { /* email failure is non-fatal — membership is already pending */ });
    }

    return reply.status(201).send({ contact_id: contact.id, membership_id: membership.id, email, status: membership.status, pending_confirmation: double_optin });
  });

  // GET /v1/lists/:id/contacts
  fastify.get('/lists/:id/contacts', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id: listId } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const q = request.query as { status?: string; search?: string; page?: string; limit?: string };
    const page = Math.max(1, parseInt(q.page ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(q.limit ?? '50', 10)));

    const list = await prisma.mailingList.findFirst({ where: { id: listId, apiKeyId } });
    if (!list) throw Errors.notFound('List not found.');

    const memberships = await prisma.contactListMembership.findMany({
      where: {
        listId,
        ...(q.status ? { status: q.status } : {}),
        ...(q.search ? { contact: { email: { contains: q.search, mode: 'insensitive' } } } : {}),
      },
      orderBy: { subscribedAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: { contact: { select: { email: true, firstName: true, lastName: true, customFields: true } } },
    });

    return reply.status(200).send({ data: memberships, page, limit });
  });

  // GET /v1/lists/:id/contacts/export — download all contacts as CSV
  fastify.get('/lists/:id/contacts/export', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id: listId } = request.params as { id: string };
    const apiKeyId = request.apiKey.id;
    const q = request.query as { status?: string };

    const list = await prisma.mailingList.findFirst({ where: { id: listId, apiKeyId } });
    if (!list) throw Errors.notFound('List not found.');

    const date = new Date().toISOString().slice(0, 10);
    const safeName = (list.name ?? 'contacts').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${safeName}-${date}.csv"`);

    let offset = 0;
    const batchSize = 1000;
    const where = {
      listId,
      ...(q.status ? { status: q.status } : {}),
    };

    let csv = 'email,first_name,last_name,status,subscribed_at,unsubscribed_at\n';

    while (true) {
      const batch = await prisma.contactListMembership.findMany({
        where,
        orderBy: { subscribedAt: 'desc' },
        skip: offset,
        take: batchSize,
        include: { contact: { select: { email: true, firstName: true, lastName: true } } },
      });
      if (batch.length === 0) break;
      for (const m of batch) {
        const email = m.contact.email.includes(',') ? `"${m.contact.email}"` : m.contact.email;
        const first = (m.contact.firstName ?? '').replace(/"/g, '""');
        const last = (m.contact.lastName ?? '').replace(/"/g, '""');
        csv += `${email},"${first}","${last}",${m.status},${m.subscribedAt?.toISOString() ?? ''},${m.unsubscribedAt?.toISOString() ?? ''}\n`;
      }
      offset += batch.length;
      if (batch.length < batchSize) break;
    }

    return reply.status(200).send(csv);
  });

  // GET /v1/lists/:id/contacts/:email
  fastify.get('/lists/:id/contacts/:email', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id: listId, email: rawEmail } = request.params as { id: string; email: string };
    const email = decodeURIComponent(rawEmail).toLowerCase();
    const apiKeyId = request.apiKey.id;

    const contact = await prisma.contact.findUnique({ where: { apiKeyId_email: { apiKeyId, email } }, select: { id: true } });
    if (!contact) throw Errors.notFound('Contact not found.');

    const membership = await prisma.contactListMembership.findUnique({
      where: { contactId_listId: { contactId: contact.id, listId } },
    });
    if (!membership) throw Errors.notFound('Contact not subscribed to this list.');

    return reply.status(200).send(membership);
  });

  // DELETE /v1/lists/:id/contacts/:email — unsubscribe (soft delete)
  fastify.delete('/lists/:id/contacts/:email', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id: listId, email: rawEmail } = request.params as { id: string; email: string };
    const email = decodeURIComponent(rawEmail).toLowerCase();
    const apiKeyId = request.apiKey.id;

    const contact = await prisma.contact.findUnique({ where: { apiKeyId_email: { apiKeyId, email } }, select: { id: true } });
    if (!contact) throw Errors.notFound('Contact not found.');

    const membership = await prisma.contactListMembership.findUnique({
      where: { contactId_listId: { contactId: contact.id, listId } },
    });
    if (!membership) throw Errors.notFound('Contact not subscribed to this list.');

    await prisma.contactListMembership.update({
      where: { id: membership.id },
      data: { status: 'unsubscribed', unsubscribedAt: new Date() },
    });

    return reply.status(200).send({ unsubscribed: true, email, list_id: listId });
  });

  // GET /v1/contacts/:email — find contact globally
  fastify.get('/contacts/:email', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { email: rawEmail } = request.params as { email: string };
    const email = decodeURIComponent(rawEmail).toLowerCase();
    const apiKeyId = request.apiKey.id;

    const contact = await prisma.contact.findUnique({
      where: { apiKeyId_email: { apiKeyId, email } },
      include: { memberships: { include: { list: { select: { id: true, name: true } } } } },
    });
    if (!contact) throw Errors.notFound('Contact not found.');

    return reply.status(200).send(contact);
  });

  // PATCH /v1/contacts/:email — update contact fields (firstName, lastName, customFields)
  fastify.patch('/contacts/:email', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { email: rawEmail } = request.params as { email: string };
    const email = decodeURIComponent(rawEmail).toLowerCase();
    const apiKeyId = request.apiKey.id;

    const patchSchema = z.object({
      first_name:    z.string().max(200).optional(),
      last_name:     z.string().max(200).optional(),
      custom_fields: z.record(z.unknown()).optional(),
    });
    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));

    const contact = await prisma.contact.findUnique({ where: { apiKeyId_email: { apiKeyId, email } } });
    if (!contact) throw Errors.notFound('Contact not found.');

    const { first_name, last_name, custom_fields } = parsed.data;
    const updated = await prisma.contact.update({
      where: { apiKeyId_email: { apiKeyId, email } },
      data: {
        ...(first_name !== undefined && { firstName: first_name }),
        ...(last_name  !== undefined && { lastName:  last_name }),
        ...(custom_fields !== undefined && { customFields: custom_fields as Prisma.InputJsonValue }),
      },
      select: { id: true, email: true, firstName: true, lastName: true, customFields: true, updatedAt: true },
    });
    return reply.status(200).send(updated);
  });

  // GET /v1/contacts/:email/engagement — contact engagement score (0-100)
  fastify.get('/contacts/:email/engagement', { preHandler: [requireAuth, requireRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { email: rawEmail } = request.params as { email: string };
    const email = decodeURIComponent(rawEmail).toLowerCase();
    const apiKeyId = request.apiKey.id;

    const contact = await prisma.contact.findUnique({ where: { apiKeyId_email: { apiKeyId, email } } });
    if (!contact) throw Errors.notFound('Contact not found.');

    const [sendCount, opens, clicks, bounces, complaints, lastEvent] = await Promise.all([
      prisma.sendMessage.count({ where: { apiKeyId, to: email } }),
      prisma.trackingEvent.count({ where: { email, type: 'open', sendMessage: { apiKeyId } } }),
      prisma.trackingEvent.count({ where: { email, type: 'click', sendMessage: { apiKeyId } } }),
      prisma.sendMessage.count({ where: { apiKeyId, to: email, status: 'bounced' } }),
      prisma.sendMessage.count({ where: { apiKeyId, to: email, status: 'complained' } }),
      prisma.trackingEvent.findFirst({
        where: { email, sendMessage: { apiKeyId } },
        orderBy: { occurredAt: 'desc' },
        select: { occurredAt: true },
      }),
    ]);

    const delivered = sendCount - bounces - complaints;
    const openRate  = delivered > 0 ? opens / delivered : 0;
    const clickRate = delivered > 0 ? clicks / delivered : 0;

    // Recency score: 100 if engaged in last 7 days, 50 within 30 days, 25 within 90 days, 0 beyond
    let recencyScore = 0;
    if (lastEvent) {
      const daysSince = (Date.now() - lastEvent.occurredAt.getTime()) / 86_400_000;
      if (daysSince <= 7)  recencyScore = 100;
      else if (daysSince <= 30) recencyScore = 50;
      else if (daysSince <= 90) recencyScore = 25;
    }

    // Score: 40% open rate, 30% click rate, 30% recency
    const score = Math.min(100, Math.round(openRate * 40 + clickRate * 30 + recencyScore * 0.3));

    const tier = score >= 70 ? 'highly_engaged'
      : score >= 40 ? 'engaged'
      : score >= 15 ? 'low_engagement'
      : 'inactive';

    return reply.send({
      email,
      engagement_score: score,
      tier,
      metrics: {
        emails_sent: sendCount,
        delivered,
        opens,
        clicks,
        bounces,
        complaints,
        open_rate: parseFloat((openRate * 100).toFixed(2)),
        click_rate: parseFloat((clickRate * 100).toFixed(2)),
      },
      last_engaged_at: lastEvent?.occurredAt ?? null,
    });
  });

  // GET /v1/confirm?token=xxx — double opt-in confirmation (no auth required — email link)
  fastify.get('/confirm', { preHandler: [requireIpRateLimit('confirm', 60)] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as { token?: string };
    if (!q.token) {
      return reply.status(400).type('text/html').send('<h2>Invalid confirmation link.</h2>');
    }

    const payload = verifyOptinToken(q.token);
    if (!payload) {
      return reply.status(400).type('text/html').send('<h2>This confirmation link is expired or invalid.</h2>');
    }

    const { contactId, listId } = payload;

    const membership = await prisma.contactListMembership.findUnique({
      where: { contactId_listId: { contactId, listId } },
      include: { list: { select: { name: true } }, contact: { select: { email: true } } },
    });

    if (!membership) {
      return reply.status(404).type('text/html').send('<h2>Subscription not found.</h2>');
    }

    if (membership.status !== 'pending_confirmation') {
      return reply.status(200).type('text/html').send(`<h2>You're already confirmed for ${membership.list.name}!</h2>`);
    }

    await prisma.contactListMembership.update({
      where: { contactId_listId: { contactId, listId } },
      data: { status: 'subscribed' },
    });

    // Increment list counter now that confirmation is complete
    await prisma.mailingList.update({
      where: { id: listId },
      data: { contactCount: { increment: 1 } },
    }).catch(() => {});

    return reply.status(200).type('text/html').send(
      `<!doctype html><html><head><meta charset=utf-8><title>Subscribed</title><style>body{font-family:system-ui,sans-serif;max-width:480px;margin:60px auto;text-align:center;color:#111}h1{font-size:2rem;margin-bottom:.5rem}p{color:#555}</style></head><body><h1>✓ You're subscribed!</h1><p>You've confirmed your subscription to <strong>${membership.list.name}</strong>.</p><p>Email: ${membership.contact.email}</p></body></html>`,
    );
  });

  // ── POST /v1/contacts/import ──────────────────────────────────────────────
  // Bulk migration import. Accepts up to 50,000 contacts in one request.
  // Upserts contacts and optionally adds them to a list. Also accepts a
  // separate suppression list (unsubscribes/bounces from the source platform).
  fastify.post(
    '/contacts/import',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const bulkSchema = z.object({
        list_id: z.string().optional(),
        list_name: z.string().max(200).optional(),
        contacts: z.array(z.object({
          email: z.string().email(),
          first_name: z.string().max(200).optional().nullable(),
          last_name: z.string().max(200).optional().nullable(),
          custom_fields: z.record(z.string()).optional(),
        })).max(50_000),
        suppressions: z.array(z.object({
          email: z.string().email(),
          reason: z.string().optional(),
        })).max(50_000).optional(),
        source_platform: z.string().optional(),
      });

      const parsed = bulkSchema.safeParse(request.body);
      if (!parsed.success) throw Errors.validationFailed(parsed.error.issues[0]?.message ?? 'Invalid body');

      const { contacts, suppressions = [], list_id, list_name, source_platform } = parsed.data;
      const apiKeyId = request.apiKey.id;

      // Resolve or create target list
      let resolvedListId = list_id ?? null;
      if (!resolvedListId && list_name) {
        const newList = await prisma.mailingList.create({
          data: { apiKeyId, name: list_name, description: `Imported from ${source_platform ?? 'CSV'}` },
          select: { id: true },
        });
        resolvedListId = newList.id;
      }
      if (resolvedListId) {
        const listOwned = await prisma.mailingList.findFirst({ where: { id: resolvedListId, apiKeyId }, select: { id: true } });
        if (!listOwned) throw Errors.notFound('List not found');
      }

      // Load existing suppressions in bulk to skip them
      const suppressionEmails = new Set(
        (await prisma.suppression.findMany({
          where: { email: { in: contacts.map(c => c.email.toLowerCase()) } },
          select: { email: true },
        })).map(s => s.email),
      );

      let imported = 0, skipped = 0;
      const BATCH = 500;

      for (let i = 0; i < contacts.length; i += BATCH) {
        const batch = contacts.slice(i, i + BATCH).filter(c => !suppressionEmails.has(c.email.toLowerCase()));
        if (batch.length === 0) { skipped += BATCH; continue; }

        await prisma.$transaction(async (tx) => {
          for (const c of batch) {
            const email = c.email.toLowerCase();
            const contact = await tx.contact.upsert({
              where: { apiKeyId_email: { apiKeyId, email } },
              create: {
                apiKeyId, email,
                firstName: c.first_name ?? null,
                lastName: c.last_name ?? null,
                customFields: (c.custom_fields ?? {}) as Prisma.InputJsonValue,
              },
              update: {
                ...(c.first_name != null && { firstName: c.first_name }),
                ...(c.last_name != null && { lastName: c.last_name }),
              },
              select: { id: true },
            });

            if (resolvedListId) {
              await tx.contactListMembership.upsert({
                where: { contactId_listId: { contactId: contact.id, listId: resolvedListId } },
                create: { contactId: contact.id, listId: resolvedListId, status: 'subscribed' },
                update: {},
              });
            }
          }
        });

        imported += batch.length;
        skipped += BATCH - batch.length;
      }

      // Bulk-upsert suppressions
      let suppressionsAdded = 0;
      if (suppressions.length > 0) {
        for (let i = 0; i < suppressions.length; i += BATCH) {
          const batch = suppressions.slice(i, i + BATCH);
          await prisma.$executeRaw`
            INSERT INTO suppressions (email, reason, "createdAt")
            SELECT unnest(${batch.map(s => s.email.toLowerCase())}::text[]),
                   unnest(${batch.map(s => s.reason ?? 'unsubscribed')}::text[]),
                   now()
            ON CONFLICT (email) DO NOTHING`;
          suppressionsAdded += batch.length;
        }
      }

      if (resolvedListId) {
        await prisma.mailingList.update({
          where: { id: resolvedListId },
          data: { contactCount: imported },
        }).catch(() => {});
      }

      return reply.send({
        imported,
        skipped,
        suppressions_added: suppressionsAdded,
        list_id: resolvedListId,
      });
    },
  );
}
