import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { getPlanLimit, getSendLimit, getMonitorLimit } from '../../plugins/usageMeter.js';
import { prisma } from '../../lib/prisma.js';

export async function usageRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/usage',
    { preHandler: [requireAuth, requireRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const key = request.apiKey;
      const apiKeyId = key.id;

      const monitorCount = await prisma.monitor.count({ where: { apiKeyId, isActive: true } });

      return reply.status(200).send({
        plan: key.plan,
        verifications: {
          used: key.currentMonthUsage,
          limit: getPlanLimit(key.plan),
          resets_at: key.usageResetAt,
        },
        sends: {
          used: key.currentMonthSendUsage,
          limit: getSendLimit(key.plan),
          resets_at: key.sendUsageResetAt,
        },
        monitors: {
          active: monitorCount,
          limit: getMonitorLimit(key.plan),
        },
      });
    },
  );
}
