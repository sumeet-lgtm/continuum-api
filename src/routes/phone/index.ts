/**
 * Phone Intelligence Routes
 * 
 * POST /v1/verify/phone
 * Body: { phone: string, country?: string }
 * Returns: PhoneIntelligenceResult
 */

import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../plugins/auth.js';
import { requireRateLimit } from '../../plugins/rateLimit.js';
import { requireMonthlyQuota, incrementUsage } from '../../plugins/usageMeter.js';
import { checkPhoneIntelligence } from '../../engine/phoneIntelligence.js';
import { logger } from '../../lib/logger.js';

export async function phoneRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/verify/phone', {
    preHandler: [requireAuth, requireRateLimit, requireMonthlyQuota],
    schema: {
      body: {
        type: 'object',
        required: ['phone'],
        properties: {
          phone:   { type: 'string', minLength: 1, maxLength: 30 },
          country: { type: 'string', minLength: 2, maxLength: 2 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            phone:         { type: 'string' },
            valid:         { type: 'boolean' },
            possible:      { type: 'boolean' },
            e164:          { type: ['string', 'null'] },
            national:      { type: ['string', 'null'] },
            international: { type: ['string', 'null'] },
            country:       { type: ['string', 'null'] },
            countryCode:   { type: ['string', 'null'] },
            lineType:      { type: 'string' },
            isMobile:      { type: 'boolean' },
            isLandline:    { type: 'boolean' },
            isVoip:        { type: 'boolean' },
            isTollFree:    { type: 'boolean' },
            isPremiumRate: { type: 'boolean' },
            carrierHint:   { type: ['string', 'null'] },
            riskLevel:     { type: 'string' },
            checkedAt:     { type: 'string' },
            durationMs:    { type: 'number' },
          },
        },
      },
    },
    handler: async (request, reply) => {
      const { phone, country } = request.body as { phone: string; country?: string };
      const requestId = (request as any).id as string;

      logger.info({ phone, country, requestId, apiKeyId: request.apiKey.id }, 'Phone intelligence request');

      const result = await checkPhoneIntelligence(phone.trim(), country);

      void incrementUsage(request.apiKey.id);

      return reply.status(200).send(result);
    },
  });
}
