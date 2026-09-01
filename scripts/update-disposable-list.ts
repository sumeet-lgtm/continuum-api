/**
 * CLI: Refresh the disposable email domain blocklist from upstream.
 *
 * Source: https://github.com/disposable-email-domains/disposable-email-domains
 *
 * Usage:
 *   npx tsx scripts/update-disposable-list.ts
 *
 * Fetches the latest list, merges with local additions, writes to
 * data/disposable-domains.txt. The same fetch/write logic also runs on a
 * weekly schedule in production via src/workers/disposableListWorker.ts —
 * this script is for on-demand manual refreshes.
 */

import { refreshDisposableList } from '../src/lib/disposableListRefresh.js';

async function main(): Promise<void> {
  console.log('Fetching blocklist from upstream…');

  try {
    const { domains } = await refreshDisposableList();
    console.log(`\n✅ Blocklist updated`);
    console.log(`   Domains: ${domains}`);
  } catch (err) {
    console.error('Failed to refresh blocklist:', err);
    process.exit(1);
  }
}

void main();
