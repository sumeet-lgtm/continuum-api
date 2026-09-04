/**
 * Salesforce OAuth2 for the two-way lead sync connector.
 *
 * One Continuum-owned Connected App (SALESFORCE_CLIENT_ID/SECRET/REDIRECT_URI)
 * is authorized per-customer against their own org — same multi-tenant
 * pattern as the Gmail/Outlook mailbox connect (lib/oauth/google.ts). That
 * Connected App registration (Setup → App Manager → New Connected App) is
 * the one piece only the account owner can create; this module is inert
 * (isSalesforceOAuthConfigured returns false) until those env vars are set.
 *
 * Unlike Google/Microsoft, the token response itself carries instanceUrl —
 * every subsequent REST API call must target that org-specific host, not a
 * fixed one, since Salesforce is multi-tenant at the DNS level.
 */
import { config } from '../../config.js';
import { logger } from '../logger.js';

// api: REST API access. refresh_token + offline_access: long-lived refresh
// token so the connection survives past the ~2hr access token lifetime
// without the customer re-authorizing.
const SCOPES = ['api', 'refresh_token', 'offline_access'];

export function isSalesforceOAuthConfigured(): boolean {
  return Boolean(config.SALESFORCE_CLIENT_ID && config.SALESFORCE_CLIENT_SECRET && config.SALESFORCE_REDIRECT_URI);
}

export function getSalesforceAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.SALESFORCE_CLIENT_ID!,
    redirect_uri: config.SALESFORCE_REDIRECT_URI!,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
  });
  return `${config.SALESFORCE_LOGIN_URL}/services/oauth2/authorize?${params.toString()}`;
}

interface SalesforceTokenResponse {
  access_token?: string;
  refresh_token?: string;
  instance_url?: string;
  id?: string;
  error?: string;
  error_description?: string;
}

interface SalesforceIdentity {
  user_id?: string;
  organization_id?: string;
  email?: string;
  display_name?: string;
}

export interface SalesforceConnectResult {
  refreshToken: string;
  instanceUrl: string;
  orgId: string | null;
  email: string | null;
}

export async function exchangeSalesforceCode(code: string): Promise<SalesforceConnectResult> {
  const res = await fetch(`${config.SALESFORCE_LOGIN_URL}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.SALESFORCE_CLIENT_ID!,
      client_secret: config.SALESFORCE_CLIENT_SECRET!,
      redirect_uri: config.SALESFORCE_REDIRECT_URI!,
      grant_type: 'authorization_code',
      code,
    }),
  });
  const data = (await res.json()) as SalesforceTokenResponse;
  if (!res.ok || !data.access_token || !data.refresh_token || !data.instance_url) {
    logger.warn({ status: res.status, error: data.error, desc: data.error_description }, 'Salesforce OAuth code exchange failed');
    throw new Error(data.error_description ?? 'Salesforce did not return the expected tokens — try reconnecting');
  }

  let identity: SalesforceIdentity = {};
  if (data.id) {
    try {
      const idRes = await fetch(data.id, { headers: { Authorization: `Bearer ${data.access_token}` } });
      if (idRes.ok) identity = (await idRes.json()) as SalesforceIdentity;
    } catch (err) {
      logger.warn({ err }, 'Salesforce identity lookup failed (non-fatal — connection still succeeds)');
    }
  }

  return {
    refreshToken: data.refresh_token,
    instanceUrl: data.instance_url,
    orgId: identity.organization_id ?? null,
    email: identity.email ?? null,
  };
}

/**
 * Mint a fresh access token from the stored refresh token. Salesforce
 * access tokens expire in ~2 hours by default — not cached here since every
 * sync run is infrequent (hourly tick) relative to that lifetime.
 */
export async function getSalesforceAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch(`${config.SALESFORCE_LOGIN_URL}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.SALESFORCE_CLIENT_ID!,
      client_secret: config.SALESFORCE_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = (await res.json()) as SalesforceTokenResponse;
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description ?? 'Failed to refresh Salesforce access token — the connection may need to be reauthorized');
  }
  return data.access_token;
}
