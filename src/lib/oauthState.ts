import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

const STATE_TTL_MS = 15 * 60 * 1000;

function mac(body: string): Buffer {
  return createHmac('sha256', `oauth-state:${config.SESSION_SECRET}`).update(body).digest();
}

/** Only the dashboard origin and ALLOWED_ORIGINS may receive the session token. */
export function isAllowedRedirect(uri: unknown): uri is string {
  if (typeof uri !== 'string') return false;
  let target: URL;
  try {
    target = new URL(uri);
  } catch {
    return false;
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return false;
  if (target.username || target.password) return false;
  const allowed = [config.DASHBOARD_URL, ...(config.ALLOWED_ORIGINS?.split(',') ?? [])]
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => {
      try {
        return new URL(o).origin;
      } catch {
        return null;
      }
    });
  return allowed.includes(target.origin);
}

export function signOAuthState(redirectUri: string): string {
  const body = Buffer.from(JSON.stringify({ r: redirectUri, t: Date.now() })).toString('base64url');
  return `${body}.${mac(body).toString('base64url')}`;
}

/** Returns the redirect URI if state is authentic, fresh and allow-listed; otherwise null. */
export function verifyOAuthState(state: string | undefined): string | null {
  if (!state) return null;
  const [body, sig, extra] = state.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const expected = mac(body);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (typeof parsed.t !== 'number' || Date.now() - parsed.t > STATE_TTL_MS) return null;
    return isAllowedRedirect(parsed.r) ? parsed.r : null;
  } catch {
    return null;
  }
}
