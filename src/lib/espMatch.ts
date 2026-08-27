import { promises as dns } from 'node:dns';

export type ESPType = 'google' | 'microsoft' | 'yahoo' | 'other';

const MX_PATTERNS: Array<{ pattern: RegExp; esp: ESPType }> = [
  { pattern: /google\.com|googlemail\.com|gmail\.com/i, esp: 'google' },
  { pattern: /outlook\.com|hotmail\.com|live\.com|microsoft\.com/i, esp: 'microsoft' },
  { pattern: /yahoo\.com|yahoodns\.net|ymail\.com/i, esp: 'yahoo' },
];

const cache = new Map<string, { esp: ESPType; ts: number }>();
const CACHE_TTL_MS = 3600 * 1000; // 1 hour

export async function detectESP(email: string): Promise<ESPType> {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return 'other';

  const cached = cache.get(domain);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.esp;

  try {
    const mxRecords = await dns.resolveMx(domain);
    const mxHosts = mxRecords.map((r) => r.exchange.toLowerCase()).join(' ');

    let esp: ESPType = 'other';
    for (const { pattern, esp: match } of MX_PATTERNS) {
      if (pattern.test(mxHosts)) { esp = match; break; }
    }

    cache.set(domain, { esp, ts: Date.now() });
    return esp;
  } catch {
    return 'other';
  }
}

/** Pick the best mailbox from a pool by matching the recipient's ESP. */
export function rankMailboxesByESP(
  mailboxes: Array<{ id: string; type: string; username: string }>,
  recipientESP: ESPType,
): Array<{ id: string; type: string; username: string }> {
  const espToMailboxHint: Record<ESPType, string[]> = {
    google: ['gmail', 'google'],
    microsoft: ['outlook', 'microsoft', 'hotmail', 'live'],
    yahoo: ['yahoo', 'ymail'],
    other: [],
  };

  const hints = espToMailboxHint[recipientESP];
  if (hints.length === 0) return mailboxes;

  const matched = mailboxes.filter((m) =>
    hints.some((h) => m.username.toLowerCase().includes(h) || m.type.toLowerCase().includes(h)),
  );
  const rest = mailboxes.filter((m) => !matched.includes(m));

  return [...matched, ...rest];
}
