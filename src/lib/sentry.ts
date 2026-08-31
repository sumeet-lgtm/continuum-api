/**
 * Error tracking, off by default. Before this, a production error lived
 * only in the raw Railway log stream — no aggregation, no alerting, no
 * grouping of the same failure across many requests. Set SENTRY_DSN to
 * turn it on; every call in this file is a safe no-op without it.
 *
 * Call initSentry() once at the very top of each process entrypoint
 * (server.ts and every deployed worker) before anything else runs, so it
 * can catch errors during startup too.
 */

import * as Sentry from '@sentry/node';
import { config } from '../config.js';
import { logger } from './logger.js';

let initialized = false;

export function initSentry(serviceName: string): void {
  if (!config.SENTRY_DSN) return;
  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.NODE_ENV,
    serverName: serviceName,
    tracesSampleRate: 0,
  });
  initialized = true;
}

export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (!initialized) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}

// Sentry sends events asynchronously — a process.exit() right after
// captureException() can win the race and drop the exact error that
// crashed the process. Call this before exiting from an
// unhandledRejection/uncaughtException handler.
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!initialized) return;
  await Sentry.flush(timeoutMs);
}

// Only 5xx (our bug, not the caller's) is worth an alert — a 4xx is
// expected traffic (bad input, wrong auth, exceeded quota) and would
// otherwise flood Sentry with noise on every production deployment.
export function captureIfServerError(statusCode: number, err: unknown, context?: Record<string, unknown>): void {
  if (statusCode < 500) return;
  captureException(err, context);
}

// Dev/test note: never sends anything without SENTRY_DSN set, so this is
// safe to call unconditionally in shared code paths regardless of NODE_ENV.
export const sentryConfigured = (): boolean => initialized;

/**
 * Log + report + exit on an unhandled rejection or uncaught exception.
 *
 * server.ts already had this; none of the four worker processes that
 * actually run in production (bulkWorker, monitorWorker, webhookWorker,
 * sendWorker — see Procfile) did. A bug in any of them that threw outside
 * a try/catch had no consistent handling at all. Call this once near the
 * top of every process entrypoint, after initSentry().
 */
export function installCrashReporting(processName: string): void {
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason, process: processName }, 'Unhandled promise rejection — exiting');
    captureException(reason, { type: 'unhandledRejection', process: processName });
    void flushSentry().finally(() => process.exit(1));
  });

  process.on('uncaughtException', (err) => {
    logger.fatal({ err, process: processName }, 'Uncaught exception — exiting');
    captureException(err, { type: 'uncaughtException', process: processName });
    void flushSentry().finally(() => process.exit(1));
  });
}
