import { hmacSign, hmacVerify } from './crypto.js';
import { config } from '../config.js';

const SEP = '.';

function secret(): string {
  return (config as Record<string, unknown>)['TRACKING_SECRET'] as string ?? config.API_KEY_SALT;
}

export function generateOpenToken(sendMessageId: string): string {
  const payload = Buffer.from(JSON.stringify({ id: sendMessageId, t: Date.now() })).toString('base64url');
  return `${payload}${SEP}${hmacSign(secret(), payload)}`;
}

export function generateClickToken(sendMessageId: string, url: string): string {
  const payload = Buffer.from(JSON.stringify({ id: sendMessageId, u: url, t: Date.now() })).toString('base64url');
  return `${payload}${SEP}${hmacSign(secret(), payload)}`;
}

export function verifyOpenToken(token: string): { sendMessageId: string } | null {
  const parts = token.split(SEP);
  if (parts.length !== 2) return null;
  const [payload, sig] = parts as [string, string];
  if (!hmacVerify(secret(), payload, sig)) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { id: string };
    return { sendMessageId: d.id };
  } catch { return null; }
}

export function verifyClickToken(token: string): { sendMessageId: string; url: string } | null {
  const parts = token.split(SEP);
  if (parts.length !== 2) return null;
  const [payload, sig] = parts as [string, string];
  if (!hmacVerify(secret(), payload, sig)) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { id: string; u: string };
    return { sendMessageId: d.id, url: d.u };
  } catch { return null; }
}

const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

export { TRANSPARENT_GIF };

const DEFAULT_TRACKING_BASE = 'https://api.continuumapi.com';

export function injectTracking(
  html: string,
  openToken: string,
  clickTokenFn: (url: string) => string,
  trackingBase?: string | null,
): string {
  const base = (trackingBase ?? DEFAULT_TRACKING_BASE).replace(/\/$/, '');
  // Inject open pixel before </body>. Use ?t= query param — Railway proxy truncates path segments >100 chars.
  const pixel = `<img src="${base}/track/open?t=${encodeURIComponent(openToken)}" width="1" height="1" style="display:none" alt="" />`;
  let result = html.includes('</body>')
    ? html.replace('</body>', `${pixel}</body>`)
    : `${html}${pixel}`;

  // Wrap links for click tracking (skip mailto: and unsubscribe links)
  result = result.replace(/href="(https?:\/\/[^"]+)"/gi, (match, url: string) => {
    if (url.includes('unsubscribe') || url.includes('/track/click')) return match;
    const clickToken = clickTokenFn(url);
    return `href="${base}/track/click?t=${encodeURIComponent(clickToken)}"`;
  });

  return result;
}
