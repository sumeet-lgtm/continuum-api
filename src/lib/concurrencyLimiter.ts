/**
 * Minimal rolling concurrency pool — no external dependency needed for
 * "run these N tasks with at most K in flight at once."
 *
 * Deliberately not a batch-then-wait-for-all-then-next-batch pattern: with
 * that shape, one slow task in a batch blocks every other slot in that
 * batch from being refilled until it finishes, even though the other slots
 * are long done. A rolling pool starts the next task the instant *any*
 * slot frees up, which matters a lot here since per-email latency varies
 * wildly (a fast own-probe hit vs. a slow paid-provider fallback).
 */
export function createLimiter(maxConcurrent: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  function next() {
    if (active >= maxConcurrent) return;
    const run = queue.shift();
    if (!run) return;
    active++;
    run();
  }

  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      queue.push(resolve);
      next();
    });
    try {
      return await fn();
    } finally {
      active--;
      next();
    }
  };
}

/**
 * Runs every task in `items` through `fn` with at most `maxConcurrent` in
 * flight, returning results in the original order. Use this instead of the
 * chunk-then-Promise.allSettled-then-next-chunk pattern.
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  maxConcurrent: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const limit = createLimiter(maxConcurrent);
  return Promise.all(
    items.map((item, index) =>
      limit(() => fn(item, index)).then(
        (value): PromiseSettledResult<R> => ({ status: 'fulfilled', value }),
        (reason): PromiseSettledResult<R> => ({ status: 'rejected', reason }),
      ),
    ),
  );
}

/**
 * Process-wide limiter around paid SMTP-verification-provider calls
 * (ZeroBounce / DeBounce / Bouncer / MillionVerifier). DeBounce specifically
 * starts returning 429s above ~4-5 concurrent requests — this budget is
 * shared across every caller (bulk jobs, real-time API checks, monitor
 * rechecks) precisely so that raising a bulk job's own-probe concurrency
 * can't blow through the same limit through a different door.
 */
export const paidProviderLimiter = createLimiter(4);
