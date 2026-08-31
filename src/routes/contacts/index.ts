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
}
