import { randomBytes } from 'node:crypto';
import { redis } from './redis.js';

const CODE_TTL_SECONDS = 60;
const key = (code: string) => `sso:otc:${code}`;

/** Stores a session JWT behind a single-use, 60 s code. Throws if Redis is unavailable. */
export async function createSsoCode(sessionJwt: string): Promise<string> {
  const code = randomBytes(32).toString('base64url');
  await redis.set(key(code), sessionJwt, { px: CODE_TTL_SECONDS * 1000 });
  return code;
}

/** Atomically consumes the code (read + delete). Returns null if unknown, used or expired. */
export async function consumeSsoCode(code: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) return null;
  return redis.getdel(key(code));
}
