import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';

interface DataSubjectQuery { email?: string; }
interface DataSubjectBody { email?: string; }

export async function privacyRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /v1/privacy/data-subject?email= — summarise all data held for a given address
  fastify.get(
    '/privacy/data-subject',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { email } = request.query as DataSubjectQuery;
      if (!email || !email.includes('@')) {
        return reply.status(400).send({ error: 'email query parameter is required' });
      }
      const apiKeyId = request.apiKey.id;
      const lc = email.toLowerCase();

      const [contact, verifications, messages, suppression, leads, seqEnrollments, autoEnrollments, campaignRecipients] =
        await Promise.all([
          prisma.contact.findFirst({
            where: { email: { equals: lc, mode: 'insensitive' }, apiKeyId },
            select: { id: true, email: true, firstName: true, lastName: true, createdAt: true },
          }),
          prisma.verification.count({
            where: { email: { equals: lc, mode: 'insensitive' }, apiKeyId },
          }),
          prisma.sendMessage.count({
            where: { apiKeyId, to: { equals: lc, mode: 'insensitive' } },
          }),
          prisma.suppression.findFirst({
            where: { email: { equals: lc, mode: 'insensitive' } },
            select: { reason: true, createdAt: true },
          }),
          prisma.lead.count({
            where: { email: { equals: lc, mode: 'insensitive' }, apiKeyId },
          }),
          prisma.sequenceEnrollment.count({
            where: {
              email: { equals: lc, mode: 'insensitive' },
              sequence: { apiKeyId },
            },
          }),
          prisma.automationEnrollment.count({
            where: {
              email: { equals: lc, mode: 'insensitive' },
              automation: { apiKeyId },
            },
          }),
          prisma.campaignRecipient.count({
            where: {
              email: { equals: lc, mode: 'insensitive' },
              campaign: { apiKeyId },
            },
          }),
        ]);

      return reply.status(200).send({
        email: lc,
        data_held: {
          contact: contact
            ? { id: contact.id, firstName: contact.firstName, lastName: contact.lastName, createdAt: contact.createdAt }
            : null,
          verifications,
          messages_sent: messages,
          suppression: suppression ? { reason: suppression.reason, since: suppression.createdAt } : null,
          leads,
          sequence_enrollments: seqEnrollments,
          automation_enrollments: autoEnrollments,
          campaign_recipients: campaignRecipients,
        },
        generated_at: new Date().toISOString(),
      });
    },
  );

  // DELETE /v1/privacy/data-subject — GDPR Art. 17 right to erasure
  fastify.delete(
    '/privacy/data-subject',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as DataSubjectBody;
      const email = body?.email?.trim()?.toLowerCase();
      if (!email || !email.includes('@')) {
        return reply.status(400).send({ error: 'email is required in request body' });
      }
      const apiKeyId = request.apiKey.id;

      // Delete in dependency order (children before parents)
      // 1. Mailing list memberships (FK: contactId → Contact)
      await prisma.contactListMembership.deleteMany({
        where: { contact: { email: { equals: email, mode: 'insensitive' }, apiKeyId } },
      });

      // 2. Parallel erasure of direct-apiKeyId records
      await Promise.all([
        prisma.contact.deleteMany({
          where: { email: { equals: email, mode: 'insensitive' }, apiKeyId },
        }),
        prisma.verification.deleteMany({
          where: { email: { equals: email, mode: 'insensitive' }, apiKeyId },
        }),
        prisma.lead.deleteMany({
          where: { email: { equals: email, mode: 'insensitive' }, apiKeyId },
        }),
      ]);

      // 3. Erase enrollment records (joined through parent)
      await Promise.all([
        prisma.sequenceEnrollment.deleteMany({
          where: { email: { equals: email, mode: 'insensitive' }, sequence: { apiKeyId } },
        }),
        prisma.automationEnrollment.deleteMany({
          where: { email: { equals: email, mode: 'insensitive' }, automation: { apiKeyId } },
        }),
        prisma.campaignRecipient.deleteMany({
          where: { email: { equals: email, mode: 'insensitive' }, campaign: { apiKeyId } },
        }),
      ]);

      // 4. Add to suppression list (prevent future sends — use 'manual' as the closest reason)
      const existing = await prisma.suppression.findFirst({ where: { email } });
      if (!existing) {
        await prisma.suppression.create({
          data: { email, reason: 'manual' },
        });
      }

      return reply.status(200).send({
        email,
        erased: true,
        suppressed: true,
        erasure_timestamp: new Date().toISOString(),
        note: 'Contact records, verification history, leads, and enrollment data for this address have been permanently deleted. The address has been added to your suppression list.',
      });
    },
  );
}
