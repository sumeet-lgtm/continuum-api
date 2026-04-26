import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { logger } from '../lib/logger.js';

export interface ApiError {
  error: string;
  code: string;
  details?: unknown;
  requestId?: string;
}

// Well-known application error codes
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  unauthorized: (msg = 'Invalid or missing API key') =>
    new AppError(401, 'UNAUTHORIZED', msg),

  forbidden: (msg = 'Access denied') => new AppError(403, 'FORBIDDEN', msg),

  notFound: (resource: string) =>
    new AppError(404, 'NOT_FOUND', `${resource} not found`),

  rateLimited: (retryAfter: number) =>
    new AppError(429, 'RATE_LIMITED', 'Too many requests', { retryAfterMs: retryAfter }),

  validationFailed: (details: unknown) =>
    new AppError(422, 'VALIDATION_FAILED', 'Request validation failed', details),

  internalError: (msg = 'An unexpected error occurred') =>
    new AppError(500, 'INTERNAL_ERROR', msg),

  serviceUnavailable: (service: string) =>
    new AppError(503, 'SERVICE_UNAVAILABLE', `${service} is temporarily unavailable`),
} as const;

async function errorHandlerPlugin(fastify: FastifyInstance): Promise<void> {
  fastify.setErrorHandler(
    (error: FastifyError | AppError | ZodError | Error, request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;

      // AppError — controlled application errors
      if (error instanceof AppError) {
        if (error.statusCode >= 500) {
          logger.error({ err: error, requestId }, error.message);
        } else {
          logger.info({ code: error.code, requestId }, error.message);
        }

        const body: ApiError = {
          error: error.message,
          code: error.code,
          requestId,
          ...(error.details !== undefined && { details: error.details }),
        };

        return reply.status(error.statusCode).send(body);
      }

      // ZodError — direct zod validation (outside Fastify schema)
      if (error instanceof ZodError) {
        logger.info({ requestId, issues: error.issues }, 'Zod validation error');
        const body: ApiError = {
          error: 'Request validation failed',
          code: 'VALIDATION_FAILED',
          requestId,
          details: error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        };
        return reply.status(422).send(body);
      }

      // Fastify built-in validation errors (JSON schema)
      if ('validation' in error && error.validation) {
        logger.info({ requestId, validation: error.validation }, 'Fastify validation error');
        const body: ApiError = {
          error: error.message,
          code: 'VALIDATION_FAILED',
          requestId,
          details: error.validation,
        };
        return reply.status(400).send(body);
      }

      // Fastify FST_ERR codes (e.g. content type issues)
      const fastifyError = error as FastifyError;
      if (fastifyError.statusCode && fastifyError.statusCode < 500) {
        const body: ApiError = {
          error: fastifyError.message,
          code: fastifyError.code ?? 'REQUEST_ERROR',
          requestId,
        };
        return reply.status(fastifyError.statusCode).send(body);
      }

      // Unexpected / unhandled errors
      logger.error({ err: error, requestId }, 'Unhandled error');

      const body: ApiError = {
        error: 'An unexpected error occurred',
        code: 'INTERNAL_ERROR',
        requestId,
      };
      return reply.status(500).send(body);
    },
  );

  // Handle 404 for unknown routes
  fastify.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const body: ApiError = {
      error: `Route ${request.method} ${request.url} not found`,
      code: 'NOT_FOUND',
      requestId: request.id,
    };
    return reply.status(404).send(body);
  });
}

export const errorHandler = fp(errorHandlerPlugin, {
  name: 'error-handler',
});
