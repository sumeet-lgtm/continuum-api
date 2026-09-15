import { prisma } from './prisma.js';
import type { Prisma } from '@prisma/client';

export type PrismaTx = Prisma.TransactionClient;

/**
 * Runs `fn` with a Prisma client scoped to one tenant's Row-Level Security
 * context. SET LOCAL (not SET) is required here: it's transaction-scoped
 * and reverts automatically at COMMIT/ROLLBACK, which is what makes this
 * safe under Prisma's pooled connections — a connection this transaction
 * used can be reused by a completely different tenant's request afterward
 * with zero leftover state. SET (session-scoped) would leak across that
 * reuse and must never be used here.
 *
 * The RLS policies themselves (prisma/migrations/20260914_row_level_security)
 * deny by default when this is never called — so the actual safety
 * property doesn't depend on every call site remembering to use this; it
 * depends on the *absence* of a call being the safe state, and an explicit
 * opt-in only ever widening access to exactly one tenant's own rows.
 */
export async function withTenant<T>(
  apiKeyId: string,
  fn: (tx: PrismaTx) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // $executeRawUnsafe because SET LOCAL doesn't accept a bound
    // parameter in Postgres — apiKeyId is a cuid from our own database
    // (never raw user input), and is additionally validated as
    // alphanumeric below as defense in depth against SQL injection via
    // this string interpolation.
    if (!/^[a-zA-Z0-9_-]+$/.test(apiKeyId)) {
      throw new Error(`withTenant: refusing malformed apiKeyId: ${JSON.stringify(apiKeyId)}`);
    }
    await tx.$executeRawUnsafe(`SET LOCAL app.current_api_key_id = '${apiKeyId}'`);
    return fn(tx);
  });
}

/**
 * The explicit, auditable escape hatch for a background worker's
 * legitimate "scan every tenant's due work" queries (sequenceWorker's
 * dueEnrollments, bulkWorker's stalled-job sweep, scheduledChecks' A/B
 * test sweep, and similar). Only a worker's own top-level sweep query
 * should ever run inside this — every subsequent per-row operation on
 * that row's data should instead call withTenant(row.apiKeyId, ...) to
 * re-scope down to that one tenant, not stay inside the bypass.
 */
export async function withRlsBypass<T>(fn: (tx: PrismaTx) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.rls_bypass = 'true'`);
    return fn(tx);
  });
}
