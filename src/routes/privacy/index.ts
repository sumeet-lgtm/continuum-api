import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { withTenant, withRlsBypass } from '../../lib/tenantContext.js';

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

      const [[contact, messages, leads, seqEnrollments, campaignRecipients], verifications, suppression, autoEnrollments] =
        await Promise.all([
          withTenant(apiKeyId, (tx) => Promise.all([
            tx.contact.findFirst({
              where: { email: { equals: lc, mode: 'insensitive' }, apiKeyId },
              select: { id: true, email: true, firstName: true, lastName: true, createdAt: true },
            }),
            tx.sendMessage.count({
              where: { apiKeyId, to: { equals: lc, mode: 'insensitive' } },
            }),
            tx.lead.count({
              where: { email: { equals: lc, mode: 'insensitive' }, apiKeyId },
            }),
            tx.sequenceEnrollment.count({
              where: {
                email: { equals: lc, mode: 'insensitive' },
                sequence: { apiKeyId },
              },
            }),
            tx.campaignRecipient.count({
              where: {
                email: { equals: lc, mode: 'insensitive' },
                campaign: { apiKeyId },
              },
            }),
          ])),
          withTenant(apiKeyId, (tx) => tx.verification.count({
            where: { email: { equals: lc, mode: 'insensitive' }, apiKeyId },
          })),
          // tenant-sweep: Suppression is deliberately global (see schema.prisma) — not scoped by apiKeyId.
          // withRlsBypass (not withTenant): a GDPR data-subject lookup must report
          // whether this address is suppressed platform-wide, regardless of which
          // tenant's send caused the suppression.
          withRlsBypass((tx) => tx.suppression.findFirst({
            where: { email: { equals: lc, mode: 'insensitive' } },
            select: { reason: true, createdAt: true },
          })),
          withTenant(apiKeyId, (tx) => tx.automationEnrollment.count({
            where: {
              email: { equals: lc, mode: 'insensitive' },
              automation: { apiKeyId },
            },
          })),
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
      await withTenant(apiKeyId, (tx) => tx.contactListMembership.deleteMany({
        where: { contact: { email: { equals: email, mode: 'insensitive' }, apiKeyId } },
      }));

      // 2. Parallel erasure of direct-apiKeyId records
      await withTenant(apiKeyId, (tx) => Promise.all([
        tx.contact.deleteMany({
          where: { email: { equals: email, mode: 'insensitive' }, apiKeyId },
        }),
        tx.verification.deleteMany({
          where: { email: { equals: email, mode: 'insensitive' }, apiKeyId },
        }),
        tx.lead.deleteMany({
          where: { email: { equals: email, mode: 'insensitive' }, apiKeyId },
        }),
      ]));

      // 3. Erase enrollment records (joined through parent)
      await withTenant(apiKeyId, (tx) => Promise.all([
        tx.sequenceEnrollment.deleteMany({
          where: { email: { equals: email, mode: 'insensitive' }, sequence: { apiKeyId } },
        }),
        tx.automationEnrollment.deleteMany({
          where: { email: { equals: email, mode: 'insensitive' }, automation: { apiKeyId } },
        }),
        tx.campaignRecipient.deleteMany({
          where: { email: { equals: email, mode: 'insensitive' }, campaign: { apiKeyId } },
        }),
      ]));

      // 4. Add to suppression list (prevent future sends — use 'manual' as the closest reason)
      // tenant-sweep: Suppression is deliberately global (see schema.prisma) — not scoped by apiKeyId.
      // withRlsBypass: the existence check and the unattributed (apiKeyId-less) create
      // both need to see/affect the platform-wide list, not just this tenant's rows.
      const existing = await withRlsBypass((tx) => tx.suppression.findFirst({ where: { email } }));
      if (!existing) {
        await withRlsBypass((tx) => tx.suppression.create({
          data: { email, reason: 'manual' },
        }));
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
