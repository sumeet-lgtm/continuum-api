/**
 * SMTP2GO transport — fallback for /v1/send, pending AWS SES production
 * access (declined once, reconsideration pending as of Sep 2026). Same
 * "off when unset" shape and same SendVia*Input/Result contract as ses.ts
 * so a later routing decision can pick between them per-domain or as a
 * platform-wide default without touching call sites.
 *
 * API reference: https://developers.smtp2go.com/reference/send-standard-email
 * Auth: X-Smtp2go-Api-Key header (confirmed against live docs, not assumed).
 */

import { config } from '../config.js';

export class Smtp2goNotConfiguredError extends Error {
  constructor() {
    super('SMTP2GO is not configured — set SMTP2GO_API_KEY.');
    this.name = 'Smtp2goNotConfiguredError';
  }
}

const API_BASE = 'https://api.smtp2go.com/v3';

function getApiKey(): string {
  if (!config.SMTP2GO_API_KEY) throw new Smtp2goNotConfiguredError();
  return config.SMTP2GO_API_KEY;
}

async function smtp2goFetch<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Smtp2go-Api-Key': getApiKey(),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  const data = await res.json() as { data?: T; request_id?: string; errors?: string[] };
  if (!res.ok || data.errors?.length) {
    throw new Error(`SMTP2GO ${path} failed (${res.status}): ${data.errors?.join('; ') ?? res.statusText}`);
  }
  return data.data as T;
}

export interface AttachmentInput {
  filename: string;
  content: string; // base64
  content_type: string;
}

export interface SendViaSmtp2goInput {
  to: string;
  cc?: string[];
  bcc?: string[];
  from: string;
  replyTo?: string | string[];
  subject: string;
  htmlBody?: string;
  textBody?: string;
  attachments?: AttachmentInput[];
  headers?: Record<string, string>;
  listUnsubscribeHeader?: string;
}

export interface SendViaSmtp2goResult {
  smtp2goMessageId: string;
}

interface Smtp2goSendResponse {
  succeeded: number;
  failed: number;
  failures: string[];
  email_id: string;
}

export async function sendViaSmtp2go(input: SendViaSmtp2goInput): Promise<SendViaSmtp2goResult> {
  const replyToAddresses = input.replyTo
    ? (Array.isArray(input.replyTo) ? input.replyTo : [input.replyTo])
    : undefined;

  // custom_headers is an array of {header, value} pairs per the live API
  // reference — not a plain object the way ses.ts's raw-MIME path builds it.
  const customHeaders: Array<{ header: string; value: string }> = [];
  if (input.listUnsubscribeHeader) {
    customHeaders.push({ header: 'List-Unsubscribe', value: input.listUnsubscribeHeader });
    customHeaders.push({ header: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' });
  }
  if (input.headers) {
    for (const [k, v] of Object.entries(input.headers)) {
      customHeaders.push({ header: k, value: v });
    }
  }
  if (replyToAddresses?.length) {
    customHeaders.push({ header: 'Reply-To', value: replyToAddresses.join(', ') });
  }

  const result = await smtp2goFetch<Smtp2goSendResponse>('/email/send', {
    sender: input.from,
    to: [input.to],
    ...(input.cc?.length ? { cc: input.cc } : {}),
    ...(input.bcc?.length ? { bcc: input.bcc } : {}),
    subject: input.subject,
    ...(input.htmlBody ? { html_body: input.htmlBody } : {}),
    ...(input.textBody ? { text_body: input.textBody } : {}),
    ...(customHeaders.length ? { custom_headers: customHeaders } : {}),
    ...(input.attachments?.length ? {
      attachments: input.attachments.map((a) => ({
        filename: a.filename,
        fileblob: a.content,
        mimetype: a.content_type,
      })),
    } : {}),
  });

  if (!result?.email_id) throw new Error('SMTP2GO accepted the send but returned no email_id.');
  return { smtp2goMessageId: result.email_id };
}

/** Whether SMTP2GO is configured — used by the route to fail fast with a clear 503. */
export function isSmtp2goConfigured(): boolean {
  return Boolean(config.SMTP2GO_API_KEY);
}

// ─── Sub-accounts — per-customer reputation isolation ─────────────────────────
//
// SMTP2GO's sub-account model is the actual architectural upgrade over the
// current single shared SES identity: each sub-account gets its own
// reputation, so one customer's bad list can't hurt another's deliverability
// (unlike today, where wyberai.com and continuumapi.com share one AWS
// account's sender reputation). Rate-limited to 50 calls/hour per SMTP2GO's
// own docs — fine for onboarding volume, would need queuing at high signup
// velocity.

export interface CreateSubaccountInput {
  fullname: string;
  subaccountEmail?: string;
  monthlyLimit?: number;
}

export interface CreateSubaccountResult {
  subaccountId: string;
}

export async function createSmtp2goSubaccount(input: CreateSubaccountInput): Promise<CreateSubaccountResult> {
  const result = await smtp2goFetch<{ subaccount_id: string }>('/subaccount/add', {
    fullname: input.fullname,
    ...(input.subaccountEmail ? { subaccount_email: input.subaccountEmail } : {}),
    limit: input.monthlyLimit ?? 10_000,
  });
  if (!result?.subaccount_id) throw new Error('SMTP2GO accepted the subaccount request but returned no subaccount_id.');
  return { subaccountId: result.subaccount_id };
}

// ─── Sender domain + DKIM ──────────────────────────────────────────────────────

export interface AddSenderDomainResult {
  domainId: string;
  dkimRecord: { host: string; value: string; type: string } | null;
  spfRecord: { host: string; value: string; type: string } | null;
}

export async function addSmtp2goSenderDomain(domain: string): Promise<AddSenderDomainResult> {
  // Response shape confirmed against the live add-sender-domain reference;
  // exact key names re-verified once real credentials exist to test against —
  // flagged in the PR/commit rather than guessed silently.
  const result = await smtp2goFetch<{
    domain_id: string;
    dkim_token?: { hostname: string; value: string; type: string };
    spf_token?: { hostname: string; value: string; type: string };
  }>('/sender/domain/add', { domain });

  return {
    domainId: result.domain_id,
    dkimRecord: result.dkim_token
      ? { host: result.dkim_token.hostname, value: result.dkim_token.value, type: result.dkim_token.type }
      : null,
    spfRecord: result.spf_token
      ? { host: result.spf_token.hostname, value: result.spf_token.value, type: result.spf_token.type }
      : null,
  };
}
