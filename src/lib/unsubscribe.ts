import { hmacSign, hmacVerify } from './crypto.js';
import { config } from '../config.js';

const SEP = '.';

export function generateUnsubToken(email: string, apiKeyId: string): string {
  const payload = Buffer.from(JSON.stringify({ e: email, k: apiKeyId, t: Date.now() })).toString('base64url');
  const secret = config.UNSUBSCRIBE_SECRET ?? config.API_KEY_SALT;
  const sig = hmacSign(secret, payload);
  return `${payload}${SEP}${sig}`;
}

export function verifyUnsubToken(token: string): { email: string; apiKeyId: string } | null {
  const parts = token.split(SEP);
  if (parts.length !== 2) return null;
  const [payload, sig] = parts as [string, string];
  const secret = config.UNSUBSCRIBE_SECRET ?? config.API_KEY_SALT;
  if (!hmacVerify(secret, payload, sig)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { e: string; k: string; t: number };
    return { email: data.e, apiKeyId: data.k };
  } catch {
    return null;
  }
}

export function generateUnsubHtml(token: string): string {
  const url = `https://api.continuumapi.com/v1/unsubscribe?token=${encodeURIComponent(token)}`;
  return `<div style="text-align:center;margin-top:40px;font-family:sans-serif;font-size:12px;color:#888">
<a href="${url}" style="color:#888">Unsubscribe</a>
</div>`;
}
