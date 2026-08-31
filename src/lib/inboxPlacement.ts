/**
 * Real inbox-placement checking against seed mailboxes via IMAP.
 *
 * Replaces a prior implementation that unconditionally set
 * results['gmail'] = 'inbox' whenever SEED_GMAIL_USER happened to be
 * configured — regardless of whether the probe email had actually arrived
 * anywhere. That was fabricated data returned from a customer-facing
 * endpoint. This connects to each configured seed mailbox and searches for
 * the probe by its unique X-Continuum-Test-Id header, first in the inbox,
 * then in spam/junk.
 */

import { logger } from './logger.js';
import { config } from '../config.js';

export type PlacementResult = 'inbox' | 'spam' | 'not_found' | 'unavailable' | 'error';

interface SeedProvider {
  provider: string;
  host: string;
  spamFolder: string;
  user: string | undefined;
  password: string | undefined;
}

// Fixed hosts for our own seed mailboxes — unlike a customer-supplied
// mailbox (see imapHost.ts), these providers and hostnames are known ahead
// of time, so there's no need to derive anything.
function seedProviders(): SeedProvider[] {
  return [
    {
      provider: 'gmail',
      host: 'imap.gmail.com',
      spamFolder: '[Gmail]/Spam',
      user: config.SEED_GMAIL_USER,
      password: config.SEED_GMAIL_PASSWORD,
    },
    {
      provider: 'outlook',
      host: 'outlook.office365.com',
      spamFolder: 'Junk Email',
      user: config.SEED_OUTLOOK_USER,
      password: config.SEED_OUTLOOK_PASSWORD,
    },
  ];
}

interface ImapSimpleConnection {
  openBox(name: string): Promise<unknown>;
  search(criteria: unknown[], options: { bodies: string[]; markSeen: boolean }): Promise<unknown[]>;
  end(): void;
}

async function folderHasTestId(connection: ImapSimpleConnection, folder: string, testId: string): Promise<boolean> {
  await connection.openBox(folder);
  const messages = await connection.search(
    [['HEADER', 'X-Continuum-Test-Id', testId]],
    { bodies: ['HEADER.FIELDS (SUBJECT)'], markSeen: false },
  );
  return messages.length > 0;
}

async function checkProvider(seed: SeedProvider, testId: string): Promise<PlacementResult> {
  if (!seed.user || !seed.password) return 'unavailable';

  let connection: ImapSimpleConnection | undefined;
  try {
    const imap = await import('imap-simple');
    connection = await imap.connect({
      imap: {
        user: seed.user,
        password: seed.password,
        host: seed.host,
        port: 993,
        tls: true,
        tlsOptions: { rejectUnauthorized: false },
        authTimeout: 10000,
      },
    }) as unknown as ImapSimpleConnection;

    if (await folderHasTestId(connection, 'INBOX', testId)) return 'inbox';
    if (await folderHasTestId(connection, seed.spamFolder, testId)) return 'spam';
    return 'not_found';
  } catch (err) {
    logger.error({ err, provider: seed.provider }, 'Inbox placement IMAP check failed');
    return 'error';
  } finally {
    try { connection?.end(); } catch { /* already closed */ }
  }
}

export async function checkInboxPlacement(testId: string): Promise<Record<string, PlacementResult>> {
  const providers = seedProviders();
  const entries = await Promise.all(
    providers.map(async (seed) => [seed.provider, await checkProvider(seed, testId)] as const),
  );
  return Object.fromEntries(entries);
}
