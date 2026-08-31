/**
 * Amazon SES transport for /v1/send.
 *
 * Gated on AWS credentials being set — sendViaSes() throws a clear,
 * caught-by-the-route error when they're missing, so the rest of Phase 6
 * (schema, quota, suppression, webhooks) works and is testable before an
 * AWS account exists. Same "off when unset" shape as RESEND_API_KEY in
 * src/lib/email.ts, just surfaced as a thrown error instead of a boolean
 * return — a send response needs to say WHY it didn't go out.
 */

import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { config } from '../config.js';

export class SesNotConfiguredError extends Error {
  constructor() {
    super('SES is not configured — set AWS_REGION, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY.');
    this.name = 'SesNotConfiguredError';
  }
}

// Raw MIME headers below are built by string interpolation, so any value
// that reaches them must first be stripped of CR/LF — an embedded newline
// would otherwise let a caller inject an extra header (e.g. a forged Bcc)
// or break out into a new MIME part. Folding to a space rather than
// stripping outright keeps legitimate multi-line input (a subject a client
// wrapped) readable instead of silently concatenating words together.
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

// A header NAME containing a newline (or anything outside a normal token)
// is not plausible accidental input — reject the send instead of trying to
// sanitize it, since silently dropping/rewriting it could mask what the
// caller actually intended.
const HEADER_NAME_RE = /^[A-Za-z0-9-]+$/;
function assertValidHeaderName(name: string): void {
  if (!HEADER_NAME_RE.test(name)) {
    throw new Error(`Invalid header name: ${JSON.stringify(name)}`);
  }
}

// Attachment filename/content-type are embedded inside a quoted MIME
// attribute (name="...", filename="..."); besides CR/LF, a bare quote would
// let a value escape the attribute and inject further attributes/headers.
function sanitizeMimeAttribute(value: string): string {
  return value.replace(/[\r\n"]/g, '').trim();
}

let client: SESv2Client | null = null;

function getClient(): SESv2Client {
  if (!config.AWS_REGION || !config.AWS_ACCESS_KEY_ID || !config.AWS_SECRET_ACCESS_KEY) {
    throw new SesNotConfiguredError();
  }
  if (!client) {
    client = new SESv2Client({
      region: config.AWS_REGION,
      credentials: {
        accessKeyId: config.AWS_ACCESS_KEY_ID,
        secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return client;
}

export interface AttachmentInput {
  filename: string;
  content: string; // base64
  content_type: string;
}

export interface SendViaSesInput {
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

export interface SendViaSesResult {
  sesMessageId: string;
}

export async function sendViaSes(input: SendViaSesInput): Promise<SendViaSesResult> {
  const ses = getClient();

  const replyToAddresses = input.replyTo
    ? (Array.isArray(input.replyTo) ? input.replyTo : [input.replyTo])
    : undefined;

  const hasAttachments = input.attachments && input.attachments.length > 0;
  const hasExtraHeaders = (input.headers && Object.keys(input.headers).length > 0) || input.listUnsubscribeHeader;

  if (hasAttachments || hasExtraHeaders) {
    // Use Raw message for attachments or custom headers
    const boundary = `=_continuum_${Date.now()}`;
    const lines: string[] = [];

    lines.push(`From: ${sanitizeHeaderValue(input.from)}`);
    lines.push(`To: ${sanitizeHeaderValue(input.to)}`);
    if (input.cc?.length) lines.push(`Cc: ${input.cc.map(sanitizeHeaderValue).join(', ')}`);
    if (replyToAddresses?.length) lines.push(`Reply-To: ${replyToAddresses.map(sanitizeHeaderValue).join(', ')}`);
    lines.push(`Subject: ${sanitizeHeaderValue(input.subject)}`);
    lines.push(`MIME-Version: 1.0`);

    if (input.listUnsubscribeHeader) {
      lines.push(`List-Unsubscribe: ${sanitizeHeaderValue(input.listUnsubscribeHeader)}`);
      lines.push(`List-Unsubscribe-Post: List-Unsubscribe=One-Click`);
    }
    if (input.headers) {
      for (const [k, v] of Object.entries(input.headers)) {
        assertValidHeaderName(k);
        lines.push(`${k}: ${sanitizeHeaderValue(v)}`);
      }
    }

    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    lines.push('');

    // Body part
    const bodyBoundary = `=_body_${Date.now()}`;
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: multipart/alternative; boundary="${bodyBoundary}"`);
    lines.push('');

    if (input.textBody) {
      lines.push(`--${bodyBoundary}`);
      lines.push(`Content-Type: text/plain; charset=UTF-8`);
      lines.push(`Content-Transfer-Encoding: quoted-printable`);
      lines.push('');
      lines.push(input.textBody);
    }
    if (input.htmlBody) {
      lines.push(`--${bodyBoundary}`);
      lines.push(`Content-Type: text/html; charset=UTF-8`);
      lines.push(`Content-Transfer-Encoding: base64`);
      lines.push('');
      lines.push(Buffer.from(input.htmlBody, 'utf-8').toString('base64'));
    }
    lines.push(`--${bodyBoundary}--`);

    // Attachments
    for (const att of (input.attachments ?? [])) {
      const safeContentType = sanitizeMimeAttribute(att.content_type);
      const safeFilename = sanitizeMimeAttribute(att.filename);
      lines.push(`--${boundary}`);
      lines.push(`Content-Type: ${safeContentType}; name="${safeFilename}"`);
      lines.push(`Content-Disposition: attachment; filename="${safeFilename}"`);
      lines.push(`Content-Transfer-Encoding: base64`);
      lines.push('');
      lines.push(att.content);
    }
    lines.push(`--${boundary}--`);

    const rawMessage = lines.join('\r\n');
    const toAddresses = [input.to, ...(input.cc ?? []), ...(input.bcc ?? [])];

    const command = new SendEmailCommand({
      FromEmailAddress: input.from,
      Destination: { ToAddresses: toAddresses },
      ConfigurationSetName: config.SES_CONFIGURATION_SET,
      Content: {
        Raw: { Data: Buffer.from(rawMessage) },
      },
    });

    const result = await ses.send(command);
    if (!result.MessageId) throw new Error('SES returned no MessageId.');
    return { sesMessageId: result.MessageId };
  }

  // Simple path (no attachments, no extra headers)
  const command = new SendEmailCommand({
    FromEmailAddress: input.from,
    Destination: {
      ToAddresses: [input.to],
      CcAddresses: input.cc?.length ? input.cc : undefined,
      BccAddresses: input.bcc?.length ? input.bcc : undefined,
    },
    ReplyToAddresses: replyToAddresses,
    ConfigurationSetName: config.SES_CONFIGURATION_SET,
    Content: {
      Simple: {
        Subject: { Data: input.subject, Charset: 'UTF-8' },
        Body: {
          ...(input.htmlBody ? { Html: { Data: input.htmlBody, Charset: 'UTF-8' } } : {}),
          ...(input.textBody ? { Text: { Data: input.textBody, Charset: 'UTF-8' } } : {}),
        },
      },
    },
  });

  const result = await ses.send(command);
  if (!result.MessageId) {
    throw new Error('SES accepted the send but returned no MessageId.');
  }
  return { sesMessageId: result.MessageId };
}

/** Whether SES is configured — used by the route to fail fast with a clear 503. */
export function isSesConfigured(): boolean {
  return Boolean(config.AWS_REGION && config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY);
}
