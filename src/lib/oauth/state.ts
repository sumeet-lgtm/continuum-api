import { hmacSign, hmacVerify } from '../crypto.js';
import { config } from '../../config.js';

/**
 * The OAuth callback is hit directly by Google/Microsoft with no Bearer
 * token attached, so the caller's identity has to survive the round trip
 * some other way — signed into `state` itself rather than a server-side
 * session, since this API is otherwise fully stateless per-request.
 */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function getOAuthStateSecret(): string {
  return config.MAILBOX_CREDS_SECRET ?? config.API_KEY_SALT;
}

export function signOAuthState(apiKeyId: string): string {
  const payload = `${apiKeyId}.${Date.now() + OAUTH_STATE_TTL_MS}`;
  const sig = hmacSign(getOAuthStateSecret(), payload);
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

export function verifyOAuthState(state: string): { apiKeyId: string } | null {
  try {
    const decoded = Buffer.from(state, 'base64url').toString('utf8');
    const lastDot = decoded.lastIndexOf('.');
    const payload = decoded.slice(0, lastDot);
    const sig = decoded.slice(lastDot + 1);
    if (!hmacVerify(getOAuthStateSecret(), payload, sig)) return null;

    const [apiKeyId, expiresAtStr] = payload.split('.');
    if (!apiKeyId || !expiresAtStr) return null;
    if (Date.now() > Number(expiresAtStr)) return null;
    return { apiKeyId };
  } catch {
    return null;
  }
}
