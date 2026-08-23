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

export interface SendViaSesInput {
  to: string;
  from: string;
  replyTo?: string;
  subject: string;
  htmlBody?: string;
  textBody?: string;
}

export interface SendViaSesResult {
  sesMessageId: string;
}

export async function sendViaSes(input: SendViaSesInput): Promise<SendViaSesResult> {
  const ses = getClient();

  const command = new SendEmailCommand({
    FromEmailAddress: input.from,
    Destination: { ToAddresses: [input.to] },
    ReplyToAddresses: input.replyTo ? [input.replyTo] : undefined,
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
