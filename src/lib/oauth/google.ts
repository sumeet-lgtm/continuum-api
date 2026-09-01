/**
 * Google OAuth2 for one-click Gmail mailbox connect (SMTP + IMAP via
 * XOAUTH2 — no app password required from the user).
 *
 * Requires GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI from a Google Cloud
 * Console OAuth client (external, verified for the gmail.googleapis.com /
 * mail.google.com scope) — that registration is the one piece only the
 * account owner can create; this module is inert (isGoogleOAuthConfigured
 * returns false) until those three env vars are set.
 */
import { config } from '../../config.js';
import { logger } from '../logger.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

// Full mail scope is required for IMAP/SMTP XOAUTH2 (gmail.send /
// gmail.readonly alone only cover the Gmail API, not raw IMAP/SMTP access).
const SCOPES = ['https://mail.google.com/', 'openid', 'email'];

export function isGoogleOAuthConfigured(): boolean {
  return Boolean(config.GOOGLE_OAUTH_CLIENT_ID && config.GOOGLE_OAUTH_CLIENT_SECRET && config.GOOGLE_OAUTH_REDIRECT_URI);
}

export function getGoogleAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.GOOGLE_OAUTH_CLIENT_ID!,
    redirect_uri: config.GOOGLE_OAUTH_REDIRECT_URI!,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent', // force a refresh_token on every connect, not just the first
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export async function exchangeGoogleCode(code: string): Promise<{ refreshToken: string; email: string }> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: config.GOOGLE_OAUTH_CLIENT_SECRET!,
      redirect_uri: config.GOOGLE_OAUTH_REDIRECT_URI!,
      grant_type: 'authorization_code',
      code,
    }),
  });
  const data = (await res.json()) as GoogleTokenResponse;
  if (!res.ok || !data.access_token || !data.refresh_token) {
    logger.warn({ status: res.status, error: data.error, desc: data.error_description }, 'Google OAuth code exchange failed');
    throw new Error(data.error_description ?? 'Google did not return a refresh token — try disconnecting the app at myaccount.google.com/permissions and reconnecting');
  }

  const email = await fetchGoogleEmail(data.access_token);
  return { refreshToken: data.refresh_token, email };
}

async function fetchGoogleEmail(accessToken: string): Promise<string> {
  const res = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = (await res.json()) as { email?: string };
  if (!res.ok || !data.email) throw new Error('Failed to fetch Google account email');
  return data.email;
}

/**
 * Mint a fresh access token from the stored refresh token. Google access
 * tokens expire in ~1 hour, so this runs on every send/IMAP connect rather
 * than being cached — refresh tokens themselves don't expire under normal use.
 */
export async function getGoogleAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: config.GOOGLE_OAUTH_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = (await res.json()) as GoogleTokenResponse;
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description ?? 'Failed to refresh Google access token — the mailbox may need to be reconnected');
  }
  return data.access_token;
}
