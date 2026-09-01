import { encryptValue, decryptValue } from '../crypto.js';
import { config } from '../../config.js';
import { getGoogleAccessToken } from './google.js';
import { getMicrosoftAccessToken } from './microsoft.js';

export interface StoredOAuthToken {
  provider: 'google' | 'microsoft';
  refreshToken: string;
}

function getMailboxSecret(): string {
  return config.MAILBOX_CREDS_SECRET ?? config.API_KEY_SALT;
}

/**
 * Mailbox.oauthTokenEnc stores one JSON blob (provider + refresh token)
 * encrypted the same way passwordEnc stores a plain SMTP password — reusing
 * the existing AES-256-GCM helper rather than a second encryption scheme.
 */
export function encryptOAuthToken(token: StoredOAuthToken): string {
  return encryptValue(JSON.stringify(token), getMailboxSecret());
}

export function decryptOAuthToken(oauthTokenEnc: string): StoredOAuthToken {
  return JSON.parse(decryptValue(oauthTokenEnc, getMailboxSecret())) as StoredOAuthToken;
}

/**
 * Mint a fresh short-lived access token for whichever provider a mailbox's
 * stored refresh token belongs to. Called on every SMTP send / IMAP connect
 * — access tokens expire in ~1 hour so there's nothing worth caching here.
 */
export async function getOAuthAccessToken(oauthTokenEnc: string): Promise<{ accessToken: string; provider: 'google' | 'microsoft' }> {
  const stored = decryptOAuthToken(oauthTokenEnc);
  const accessToken = stored.provider === 'google'
    ? await getGoogleAccessToken(stored.refreshToken)
    : await getMicrosoftAccessToken(stored.refreshToken);
  return { accessToken, provider: stored.provider };
}

/** Builds the base64 XOAUTH2 SASL string IMAP/SMTP servers expect. */
export function buildXoauth2Token(email: string, accessToken: string): string {
  return Buffer.from(`user=${email}\x01auth=Bearer ${accessToken}\x01\x01`).toString('base64');
}
