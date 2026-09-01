import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

const OUTPUT_PATH = path.resolve(process.cwd(), 'data/disposable-domains.txt');

const UPSTREAM_URL =
  'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/master/disposable_email_blocklist.conf';

// Local additions that are not in the upstream list
const LOCAL_ADDITIONS: string[] = [
  'mailsac.com',
  'mailsac.org',
  'maildrop.cc',
  'tempmail.com',
  'tempmail.net',
  'temp-mail.io',
];

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const location = res.headers.location;
          if (!location) return reject(new Error('Redirect with no Location header'));
          resolve(fetchText(location));
          return;
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode ?? 'unknown'} from ${url}`));
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

/**
 * Fetch the upstream disposable-domain blocklist and overwrite the local
 * data file. Shared by the manual CLI script (scripts/update-disposable-list.ts)
 * and the scheduled refresh worker so both write the exact same format.
 */
export async function refreshDisposableList(): Promise<{ domains: number }> {
  const upstream = await fetchText(UPSTREAM_URL);

  const upstreamDomains = upstream
    .split('\n')
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  const merged = new Set([...upstreamDomains, ...LOCAL_ADDITIONS]);
  const sorted = [...merged].sort();

  const header = [
    '# Continuum — disposable email domain blocklist',
    '# Format: one domain per line, lowercase',
    `# Updated: ${new Date().toISOString()}`,
    '# Source: https://github.com/disposable-email-domains/disposable-email-domains',
    '',
  ].join('\n');

  const content = header + sorted.join('\n') + '\n';

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, content, 'utf-8');

  return { domains: sorted.length };
}
