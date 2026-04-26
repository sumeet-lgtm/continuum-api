import { PrismaClient } from '@prisma/client';
import { isDev } from '../config.js';
import { logger } from './logger.js';

declare global {
  // Prevent multiple instances during hot-reload in development
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

function createPrismaClient(): PrismaClient {
  const client = new PrismaClient({
    log: isDev
      ? [
          { level: 'query', emit: 'event' },
          { level: 'warn', emit: 'event' },
          { level: 'error', emit: 'event' },
        ]
      : [
          { level: 'warn', emit: 'event' },
          { level: 'error', emit: 'event' },
        ],
  });

  if (isDev) {
    // Log slow queries in development
    client.$on('query', (e: { query: string; duration: number }) => {
      if (e.duration > 200) {
        logger.warn({ query: e.query, duration: e.duration }, 'Slow Prisma query');
      }
    });
  }

  client.$on('warn', (e: { message: string }) => {
    logger.warn({ message: e.message }, 'Prisma warning');
  });

  client.$on('error', (e: { message: string }) => {
    logger.error({ message: e.message }, 'Prisma error');
  });

  return client;
}

export const prisma: PrismaClient =
  global.__prisma ?? (global.__prisma = createPrismaClient());

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
