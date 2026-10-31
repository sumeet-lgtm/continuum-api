import type { FastifyInstance } from 'fastify';

const DOCS_URL = 'https://continuumapi.com/docs';

/**
 * Friendly landing responses for the API host itself. A developer's first
 * instinct is to open api.continuumapi.com, /docs or /v1 in a browser; without
 * these they hit a bare 404 with no pointer to where the documentation lives.
 */
export async function rootRoutes(fastify: FastifyInstance): Promise<void> {
  const index = {
    name: 'Continuum API',
    status: 'ok',
    version: 'v1',
    docs: DOCS_URL,
    dashboard: 'https://app.continuumapi.com',
    quickstart: 'curl -X POST https://api.continuumapi.com/v1/verify -H "Authorization: Bearer YOUR_API_KEY" -H "Content-Type: application/json" -d \'{"email":"someone@company.com"}\'',
    health: 'https://api.continuumapi.com/health',
  };

  // `GET /` already exists in server.ts (root info); only /v1 and /docs were missing.
  fastify.get('/v1', async (_request, reply) => reply.status(200).send(index));
  fastify.get('/docs', async (_request, reply) => reply.redirect(DOCS_URL, 302));
}
