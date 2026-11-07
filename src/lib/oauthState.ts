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

export type OAuthResponseMode = 'token' | 'code';

export function signOAuthState(redirectUri: string, mode: OAuthResponseMode = 'token'): string {
  const body = Buffer.from(JSON.stringify({ r: redirectUri, t: Date.now(), m: mode })).toString('base64url');
  return `${body}.${mac(body).toString('base64url')}`;
}

/** Returns redirect + response mode if state is authentic, fresh and allow-listed; otherwise null. */
export function verifyOAuthStateFull(
  state: string | undefined,
): { redirect: string; mode: OAuthResponseMode } | null {
  if (!state) return null;
  const [body, sig, extra] = state.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const expected = mac(body);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (typeof parsed.t !== 'number' || Date.now() - parsed.t > STATE_TTL_MS) return null;
    if (!isAllowedRedirect(parsed.r)) return null;
    return { redirect: parsed.r, mode: parsed.m === 'code' ? 'code' : 'token' };
  } catch {
    return null;
  }
}

export function verifyOAuthState(state: string | undefined): string | null {
  return verifyOAuthStateFull(state)?.redirect ?? null;
}
