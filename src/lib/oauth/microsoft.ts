/**
 * Microsoft OAuth2 (Azure AD v2 endpoint) for one-click Outlook/Microsoft 365
 * mailbox connect (SMTP + IMAP via XOAUTH2).
 *
 * Requires MICROSOFT_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI from an Azure AD
 * app registration (multi-tenant + personal accounts, with the IMAP/SMTP
 * delegated permissions below granted) — that registration is the one piece
 * only the account owner can create; this module is inert
 * (isMicrosoftOAuthConfigured returns false) until those three env vars are set.
 */
import { config } from '../../config.js';
import { logger } from '../logger.js';

const AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const ME_URL = 'https://graph.microsoft.com/v1.0/me';

const SCOPES = [
  'https://outlook.office.com/SMTP.Send',
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'offline_access',
  'openid',
  'email',
];

export function isMicrosoftOAuthConfigured(): boolean {
  return Boolean(config.MICROSOFT_OAUTH_CLIENT_ID && config.MICROSOFT_OAUTH_CLIENT_SECRET && config.MICROSOFT_OAUTH_REDIRECT_URI);
}

export function getMicrosoftAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.MICROSOFT_OAUTH_CLIENT_ID!,
    redirect_uri: config.MICROSOFT_OAUTH_REDIRECT_URI!,
    response_type: 'code',
    response_mode: 'query',
    scope: SCOPES.join(' '),
    prompt: 'consent',
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

interface MicrosoftTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export async function exchangeMicrosoftCode(code: string): Promise<{ refreshToken: string; email: string }> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.MICROSOFT_OAUTH_CLIENT_ID!,
      client_secret: config.MICROSOFT_OAUTH_CLIENT_SECRET!,
      redirect_uri: config.MICROSOFT_OAUTH_REDIRECT_URI!,
      grant_type: 'authorization_code',
      scope: SCOPES.join(' '),
      code,
    }),
  });
  const data = (await res.json()) as MicrosoftTokenResponse;
  if (!res.ok || !data.access_token || !data.refresh_token) {
    logger.warn({ status: res.status, error: data.error, desc: data.error_description }, 'Microsoft OAuth code exchange failed');
    throw new Error(data.error_description ?? 'Microsoft did not return a refresh token');
  }

  const email = await fetchMicrosoftEmail(data.access_token);
  return { refreshToken: data.refresh_token, email };
}

async function fetchMicrosoftEmail(accessToken: string): Promise<string> {
  const res = await fetch(ME_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = (await res.json()) as { mail?: string; userPrincipalName?: string };
  const email = data.mail ?? data.userPrincipalName;
  if (!res.ok || !email) throw new Error('Failed to fetch Microsoft account email');
  return email;
}

export async function getMicrosoftAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.MICROSOFT_OAUTH_CLIENT_ID!,
      client_secret: config.MICROSOFT_OAUTH_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: SCOPES.join(' '),
    }),
  });
  const data = (await res.json()) as MicrosoftTokenResponse;
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description ?? 'Failed to refresh Microsoft access token — the mailbox may need to be reconnected');
  }
  return data.access_token;
}
