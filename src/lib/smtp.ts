/**
 * SMTP client for sending emails through user-connected mailboxes.
 * Used by warmup and sequence workers — NOT for transactional sends (those use SES).
 */

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { decryptValue } from './crypto.js';
import { config } from '../config.js';
import { logger } from './logger.js';

export interface MailboxCredentials {
  host: string;
  port: number;
  username: string;
  passwordEnc: string;
}

export interface SmtpSendInput {
  from: string;
  to: string;
  subject: string;
  htmlBody?: string;
  textBody?: string;
  replyTo?: string;
  headers?: Record<string, string>;
  listUnsubscribeHeader?: string;
}

export interface SmtpSendResult {
  messageId: string;
}

function getMailboxSecret(): string {
  return (config as Record<string, unknown>)['MAILBOX_CREDS_SECRET'] as string ?? config.API_KEY_SALT;
}

function buildTransporter(creds: MailboxCredentials): Transporter {
  const password = decryptValue(creds.passwordEnc, getMailboxSecret());
  return nodemailer.createTransport({
    host: creds.host,
    port: creds.port,
    secure: creds.port === 465,
    auth: { user: creds.username, pass: password },
    tls: { rejectUnauthorized: false },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
  });
}

export async function sendViaSmtp(creds: MailboxCredentials, input: SmtpSendInput): Promise<SmtpSendResult> {
  const transporter = buildTransporter(creds);

  const extraHeaders: Record<string, string> = { ...(input.headers ?? {}) };
  if (input.listUnsubscribeHeader) {
    extraHeaders['List-Unsubscribe'] = input.listUnsubscribeHeader;
    extraHeaders['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }

  const result = await transporter.sendMail({
    from: input.from,
    to: input.to,
    subject: input.subject,
    ...(input.htmlBody ? { html: input.htmlBody } : {}),
    ...(input.textBody ? { text: input.textBody } : {}),
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    ...(Object.keys(extraHeaders).length ? { headers: extraHeaders } : {}),
  });

  transporter.close();

  const messageId = (result.messageId ?? '').replace(/^<|>$/g, '');
  logger.debug({ from: input.from, to: input.to, messageId }, 'SMTP send complete');
  return { messageId };
}

export async function testSmtpConnection(creds: MailboxCredentials): Promise<{ ok: boolean; error?: string }> {
  try {
    const transporter = buildTransporter(creds);
    await transporter.verify();
    transporter.close();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'SMTP connection failed' };
  }
}
