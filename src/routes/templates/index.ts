import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { Errors } from '../../plugins/errorHandler.js';
import { compileMjml } from '../../lib/mjml.js';
import { sendViaSes } from '../../lib/ses.js';

const baseTemplateShape = {
  name: z.string().min(1).max(200),
  subject: z.string().min(1).max(500),
  html_body: z.string().optional(),
  mjml_body: z.string().optional(),
  text_body: z.string().optional(),
  preheader: z.string().max(200).optional(),
  variables: z.array(z.string()).optional(),
};

const createSchema = z.object(baseTemplateShape).refine(
  v => v.html_body || v.mjml_body,
  { message: 'Either html_body or mjml_body is required', path: ['html_body'] },
);

const updateSchema = z.object({
  name:      z.string().min(1).max(200).optional(),
  subject:   z.string().min(1).max(500).optional(),
  html_body: z.string().optional(),
  mjml_body: z.string().optional(),
  text_body: z.string().optional(),
  preheader: z.string().max(200).optional(),
  variables: z.array(z.string()).optional(),
});

export async function templateRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /v1/templates
  fastify.post(
    '/templates',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map((i: { path: (string | number)[]; message: string }) => ({ field: i.path.join('.'), message: i.message })));

      const { name, subject, html_body, mjml_body, text_body, preheader, variables } = parsed.data;
      const apiKeyId = request.apiKey.id;

      // Compile MJML to HTML if provided
      const htmlBody = mjml_body ? await compileMjml(mjml_body) : html_body!;

      const template = await prisma.emailTemplate.create({
        data: { apiKeyId, name, subject, htmlBody, textBody: text_body ?? null, preheader: preheader ?? null, variables: variables ?? [] },
        select: { id: true, name: true, subject: true, variables: true, createdAt: true },
      });

      return reply.status(201).send(template);
    },
  );

  // GET /v1/templates
  fastify.get(
    '/templates',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const apiKeyId = request.apiKey.id;
      const q = request.query as { page?: string; limit?: string };
      const page = Math.max(1, parseInt(q.page ?? '1', 10));
      const limit = Math.min(100, Math.max(1, parseInt(q.limit ?? '50', 10)));

      const [items, total] = await Promise.all([
        prisma.emailTemplate.findMany({
          where: { apiKeyId },
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
          select: { id: true, name: true, subject: true, variables: true, createdAt: true, updatedAt: true },
        }),
        prisma.emailTemplate.count({ where: { apiKeyId } }),
      ]);

      return reply.status(200).send({ data: items, total, page, limit });
    },
  );

  // GET /v1/templates/:id
  fastify.get(
    '/templates/:id',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const apiKeyId = request.apiKey.id;

      const template = await prisma.emailTemplate.findFirst({
        where: { id, apiKeyId },
        select: { id: true, name: true, subject: true, htmlBody: true, textBody: true, preheader: true, variables: true, createdAt: true, updatedAt: true },
      });
      if (!template) throw Errors.notFound('Template not found.');

      return reply.status(200).send(template);
    },
  );

  // PATCH /v1/templates/:id
  fastify.patch(
    '/templates/:id',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) throw Errors.validationFailed(parsed.error.issues.map((i: { path: (string | number)[]; message: string }) => ({ field: i.path.join('.'), message: i.message })));

      const apiKeyId = request.apiKey.id;
      const existing = await prisma.emailTemplate.findFirst({ where: { id, apiKeyId } });
      if (!existing) throw Errors.notFound('Template not found.');

      // Save the current state as a version snapshot before overwriting
      const versionCount = await prisma.emailTemplateVersion.count({ where: { templateId: id } });
      void prisma.emailTemplateVersion.create({
        data: {
          templateId: id,
          version:    versionCount + 1,
          name:       existing.name,
          subject:    existing.subject,
          htmlBody:   existing.htmlBody,
          textBody:   existing.textBody ?? null,
          variables:  existing.variables ?? [],
          savedBy:    request.apiKey.label ?? null,
        },
      }).catch(() => { /* best-effort */ });

      const { name, subject, html_body, mjml_body, text_body, preheader, variables } = parsed.data;
      const htmlBody = mjml_body ? await compileMjml(mjml_body) : html_body;

      const updated = await prisma.emailTemplate.update({
        where: { id },
        data: {
          ...(name !== undefined && { name }),
          ...(subject !== undefined && { subject }),
          ...(htmlBody !== undefined && { htmlBody }),
          ...(text_body !== undefined && { textBody: text_body }),
          ...(preheader !== undefined && { preheader: preheader ?? null }),
          ...(variables !== undefined && { variables }),
        },
        select: { id: true, name: true, subject: true, variables: true, updatedAt: true },
      });

      return reply.status(200).send(updated);
    },
  );

  // GET /v1/templates/:id/versions
  fastify.get(
    '/templates/:id/versions',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const apiKeyId = request.apiKey.id;

      const template = await prisma.emailTemplate.findFirst({ where: { id, apiKeyId }, select: { id: true } });
      if (!template) throw Errors.notFound('Template not found.');

      const versions = await prisma.emailTemplateVersion.findMany({
        where: { templateId: id },
        orderBy: { version: 'desc' },
        select: { id: true, version: true, name: true, subject: true, savedAt: true, savedBy: true },
      });

      return reply.status(200).send({ data: versions });
    },
  );

  // GET /v1/templates/:id/versions/:versionId
  fastify.get(
    '/templates/:id/versions/:versionId',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id, versionId } = request.params as { id: string; versionId: string };
      const apiKeyId = request.apiKey.id;

      const template = await prisma.emailTemplate.findFirst({ where: { id, apiKeyId }, select: { id: true } });
      if (!template) throw Errors.notFound('Template not found.');

      const version = await prisma.emailTemplateVersion.findFirst({
        where: { id: versionId, templateId: id },
      });
      if (!version) throw Errors.notFound('Version not found.');

      return reply.status(200).send(version);
    },
  );

  // POST /v1/templates/:id/versions/:versionId/restore
  fastify.post(
    '/templates/:id/versions/:versionId/restore',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id, versionId } = request.params as { id: string; versionId: string };
      const apiKeyId = request.apiKey.id;

      const existing = await prisma.emailTemplate.findFirst({ where: { id, apiKeyId } });
      if (!existing) throw Errors.notFound('Template not found.');

      const version = await prisma.emailTemplateVersion.findFirst({
        where: { id: versionId, templateId: id },
      });
      if (!version) throw Errors.notFound('Version not found.');

      // Save the current state before restoring
      const versionCount = await prisma.emailTemplateVersion.count({ where: { templateId: id } });
      void prisma.emailTemplateVersion.create({
        data: {
          templateId: id,
          version:    versionCount + 1,
          name:       existing.name,
          subject:    existing.subject,
          htmlBody:   existing.htmlBody,
          textBody:   existing.textBody ?? null,
          variables:  existing.variables ?? [],
          savedBy:    request.apiKey.label ?? null,
        },
      }).catch(() => { /* best-effort */ });

      const restored = await prisma.emailTemplate.update({
        where: { id },
        data: {
          name:     version.name,
          subject:  version.subject,
          htmlBody: version.htmlBody,
          textBody: version.textBody ?? null,
          variables: version.variables ?? [],
        },
        select: { id: true, name: true, subject: true, variables: true, updatedAt: true },
      });

      return reply.status(200).send({ ...restored, restoredFromVersion: version.version });
    },
  );

  // POST /v1/templates/:id/test-send — sends a real preview email to a specified address.
  // Rate-limited to 10/hr per key to avoid abuse.
  fastify.post(
    '/templates/:id/test-send',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const apiKeyId = request.apiKey.id;

      const body = request.body as Record<string, unknown>;
      const to          = (typeof body.to === 'string' ? body.to : '').trim().toLowerCase();
      const fromName    = typeof body.from_name === 'string' ? body.from_name.trim() : 'Test Send';
      const fromEmail   = typeof body.from_email === 'string' ? body.from_email.trim() : '';
      const variables   = (body.variables && typeof body.variables === 'object' && !Array.isArray(body.variables))
        ? body.variables as Record<string, string>
        : {};

      if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw Errors.validationFailed([{ field: 'to', message: 'A valid recipient email is required.' }]);
      if (!fromEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail)) throw Errors.validationFailed([{ field: 'from_email', message: 'A valid sender email is required.' }]);

      const template = await prisma.emailTemplate.findFirst({
        where: { id, apiKeyId },
        select: { subject: true, htmlBody: true, textBody: true },
      });
      if (!template) throw Errors.notFound('Template not found.');

      // Replace {{ variable }} placeholders with supplied values (or a placeholder)
      const render = (str: string) => str.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_: string, key: string) => String(variables[key] ?? `[${key}]`));

      const renderedSubject = render(template.subject);
      const renderedHtml    = render(template.htmlBody);
      const renderedText    = template.textBody ? render(template.textBody) : undefined;

      const from = `${fromName} <${fromEmail}>`;

      try {
        await sendViaSes({ to, from, subject: `[TEST] ${renderedSubject}`, htmlBody: renderedHtml, ...(renderedText !== undefined && { textBody: renderedText }) });
      } catch (err: unknown) {
        const msg = (err instanceof Error) ? err.message : 'Send failed';
        throw Errors.internalError(msg);
      }

      return reply.status(200).send({ sent: true, to, subject: `[TEST] ${renderedSubject}` });
    },
  );

  // DELETE /v1/templates/:id
  fastify.delete(
    '/templates/:id',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const apiKeyId = request.apiKey.id;

      const existing = await prisma.emailTemplate.findFirst({ where: { id, apiKeyId } });
      if (!existing) throw Errors.notFound('Template not found.');

      await prisma.emailTemplate.delete({ where: { id } });
      return reply.status(200).send({ deleted: true, id });
    },
  );
}
