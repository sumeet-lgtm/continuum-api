/**
 * IP Intelligence Routes
 * 
 * POST /v1/verify/ip
 * Body: { ip: string }
 * Returns: IpIntelligenceResult
 */

import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { requireMonthlyQuota, incrementUsage } from '../../plugins/usageMeter.js';
import { checkIpIntelligence } from '../../engine/ipIntelligence.js';
import { logger } from '../../lib/logger.js';

export async function ipRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/verify/ip', {
    preHandler: [requireAuth, requireRateLimit, requireMonthlyQuota],
    schema: {
      body: {
        type: 'object',
        required: ['ip'],
        properties: {
          ip: { type: 'string', minLength: 1, maxLength: 45 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            ip:          { type: 'string' },
            valid:       { type: 'boolean' },
            country:     { type: ['string', 'null'] },
            countryCode: { type: ['string', 'null'] },
            region:      { type: ['string', 'null'] },
            regionName:  { type: ['string', 'null'] },
            city:        { type: ['string', 'null'] },
            zip:         { type: ['string', 'null'] },
            lat:         { type: ['number', 'null'] },
            lon:         { type: ['number', 'null'] },
            timezone:    { type: ['string', 'null'] },
            isp:         { type: ['string', 'null'] },
            org:         { type: ['string', 'null'] },
            as:          { type: ['string', 'null'] },
            isProxy:     { type: 'boolean' },
            isVpn:       { type: 'boolean' },
            isTor:       { type: 'boolean' },
            isMobile:    { type: 'boolean' },
            isHosting:   { type: 'boolean' },
            riskScore:   { type: 'number' },
            riskLevel:   { type: 'string' },
            checkedAt:   { type: 'string' },
            durationMs:  { type: 'number' },
          },
        },
      },
    },
    handler: async (request, reply) => {
      const { ip } = request.body as { ip: string };
      const requestId = (request as any).id as string;

      logger.info({ ip, requestId, apiKeyId: request.apiKey.id }, 'IP intelligence request');

      const result = await checkIpIntelligence(ip.trim());

      void incrementUsage(request.apiKey.id);

      return reply.status(200).send(result);
    },
  });
}
