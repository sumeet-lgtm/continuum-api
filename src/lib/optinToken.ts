import { hmacSign, hmacVerify } from './crypto.js';
import { config } from '../config.js';

// Was reading process.env['OPTIN_SECRET'] directly (bypassing config.ts's
// Zod validation) with a hardcoded fallback literal baked into source —
// OPTIN_SECRET was never actually set in production, so every double
// opt-in confirmation token was signed with a constant, publicly-readable
// string. Combined with the plain !== signature comparison this replaces,
// anyone could forge a valid confirmation link for any contact/list pair,
// which defeats the entire point of double opt-in as a consent record.
function secret(): string {
  return (config as Record<string, unknown>)['OPTIN_SECRET'] as string ?? config.API_KEY_SALT;
}

export function generateOptinToken(contactId: string, listId: string): string {
  const expiry = Date.now() + 7 * 24 * 3600 * 1000; // 7 days
  const payload = `${contactId}.${listId}.${expiry}`;
  const sig = hmacSign(secret(), payload);
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

export function verifyOptinToken(token: string): { contactId: string; listId: string } | null {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const parts = decoded.split('.');
    if (parts.length !== 4) return null;

    const contactId = parts[0];
    const listId = parts[1];
    const expiryStr = parts[2];
    const sig = parts[3];

    if (!contactId || !listId || !expiryStr || !sig) return null;

    const payload = `${contactId}.${listId}.${expiryStr}`;

    // Constant-time comparison — hmacVerify, not a plain string !==, so a
    // forged signature can't be brute-forced byte-by-byte via response-time
    // differences.
    if (!hmacVerify(secret(), payload, sig)) return null;
    if (Date.now() > parseInt(expiryStr, 10)) return null;

    return { contactId, listId };
  } catch {
    return null;
  }
}
