/**
 * SMTP Relay Server (port from config.SMTP_RELAY_PORT, default 587)
 *
 * Bridges plain SMTP to the same sending pipeline /v1/send uses — for
 * customers migrating off another provider who want to point an existing
 * mail-capable app at Continuum without touching code.
 *
 * Auth: API key as password (any username works), same key hash as the
 * REST API.
 * Supports: STARTTLS (requires SMTP_RELAY_TLS_CERT/_KEY — see config.ts),
 * AUTH PLAIN/LOGIN, up to 50MB messages, attachments.
 *
 * Start via: npm run smtp-relay
 */

import SMTPServer from 'smtp-server';
import { simpleParser } from 'mailparser';
import { prisma } from './lib/prisma.js';
import { logger } from './lib/logger.js';
import { hashApiKey } from './lib/crypto.js';
import { sendViaSes, isSesConfigured, type AttachmentInput } from './lib/ses.js';
import { getSendLimit, incrementSendUsageBy } from './plugins/usageMeter.js';
import { config } from './config.js';

interface RelayUser {
  apiKeyId: string;
  plan: string;
  currentMonthSendUsage: number;
  monthlySendLimit: number | null;
}

async function resolveApiKey(password: string): Promise<RelayUser | null> {
  const keyHash = hashApiKey(password);
  const apiKey = await prisma.apiKey.findUnique({
    where: { keyHash },
    select: { id: true, isActive: true, plan: true, currentMonthSendUsage: true, monthlySendLimit: true },
  }).catch(() => null);

  if (!apiKey || !apiKey.isActive) return null;
  return {
    apiKeyId: apiKey.id,
    plan: apiKey.plan,
    currentMonthSendUsage: apiKey.currentMonthSendUsage,
    monthlySendLimit: apiKey.monthlySendLimit,
  };
}

function loadTlsOptions(): { key: Buffer; cert: Buffer } | null {
  if (!config.SMTP_RELAY_TLS_KEY || !config.SMTP_RELAY_TLS_CERT) {
    logger.warn(
      'SMTP_RELAY_TLS_KEY/SMTP_RELAY_TLS_CERT not set — STARTTLS is unavailable, so no client ' +
      'will be able to authenticate (allowInsecureAuth is off by design). The relay will still ' +
      'accept TCP connections and answer EHLO, which is enough to smoke-test connectivity, but ' +
      'real use requires a certificate for the hostname clients will actually connect to.',
    );
    return null;
  }
  return {
    key: Buffer.from(config.SMTP_RELAY_TLS_KEY.replace(/\\n/g, '\n')),
    cert: Buffer.from(config.SMTP_RELAY_TLS_CERT.replace(/\\n/g, '\n')),
  };
}

const tls = loadTlsOptions();

const server = new SMTPServer.SMTPServer({
  secure: false, // upgrade via STARTTLS, not implicit TLS on connect
  authOptional: false,
  allowInsecureAuth: false,
  size: 52428800, // 50 MB
  banner: 'Continuum SMTP Relay',
  ...(tls ? { key: tls.key, cert: tls.cert } : {}),

  onAuth(auth, _session, callback) {
    const password = (auth as { credentials?: { password?: string }; password?: string }).credentials?.password ?? (auth as { password?: string }).password ?? '';
    resolveApiKey(password)
      .then((user) => {
        if (!user) {
          return callback(new Error('Invalid API key'));
        }
        callback(null, { user });
      })
      .catch((err) => callback(err as Error));
  },

  onData(stream, session, callback) {
    const chunks: Buffer[] = [];

    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      const raw = Buffer.concat(chunks);
      const user = session.user as RelayUser | undefined;

      if (!user) {
        return callback(new Error('Unauthenticated'));
      }

      simpleParser(raw)
        .then(async (parsed) => {
          const to = [
            ...(parsed.to ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to]) : []),
          ].flatMap((addr) => ('value' in addr ? addr.value : [addr]))
            .map((a) => a.address)
            .filter((a): a is string => Boolean(a));

          const from = parsed.from?.value?.[0]?.address ?? `relay@continuumapi.com`;
          const fromName = parsed.from?.value?.[0]?.name ?? '';
          const subject = parsed.subject ?? '(no subject)';
          const html = typeof parsed.html === 'string' ? parsed.html : parsed.textAsHtml ?? '';
          const text = parsed.text ?? '';
          const attachments: AttachmentInput[] = (parsed.attachments ?? []).map((a) => ({
            filename: a.filename ?? 'attachment',
            content: a.content.toString('base64'),
            content_type: a.contentType,
          }));

          if (to.length === 0) {
            return callback(new Error('No recipients'));
          }

          if (!isSesConfigured()) {
            logger.error('SMTP relay: SES not configured — rejecting message');
            return callback(new Error('450 Sending is temporarily unavailable'));
          }

          // Same quota every other send surface enforces — without this, a
          // valid API key could push unlimited volume through the relay
          // regardless of plan, and none of it would count toward usage.
          const limit = getSendLimit(user.plan, user.monthlySendLimit);
          if (user.currentMonthSendUsage >= limit) {
            logger.warn({ apiKeyId: user.apiKeyId }, 'SMTP relay: monthly send quota exceeded');
            return callback(new Error('452 Monthly send quota exceeded'));
          }

          let sentCount = 0;

          for (const recipient of to) {
            const suppressed = await prisma.suppression.findUnique({ where: { email: recipient } });
            if (suppressed) {
              logger.info({ email: recipient }, 'SMTP relay: skipping suppressed recipient');
              continue;
            }

            let sesMessageId: string;
            try {
              const result = await sendViaSes({
                to: recipient,
                from: fromName ? `${fromName} <${from}>` : from,
                subject,
                ...(html ? { htmlBody: html } : {}),
                ...(text ? { textBody: text } : {}),
                ...(attachments.length ? { attachments } : {}),
              });
              sesMessageId = result.sesMessageId;
            } catch (err) {
              logger.error({ err, from, to: recipient }, 'SMTP relay: SES send failed');
              continue;
            }

            // Register the send so the SES bounce/complaint webhook can
            // find it — same reason campaigns and sequences needed this:
            // no SendMessage row means no automatic suppression and no
            // closed-loop verification correction for anything sent here.
            await prisma.sendMessage.create({
              data: {
                apiKeyId: user.apiKeyId, from, to: recipient, subject,
                sesMessageId, status: 'sent', sentAt: new Date(),
              },
            }).catch((err) => {
              logger.warn({ err, email: recipient }, 'SMTP relay: failed to register send for bounce tracking (non-fatal)');
            });

            sentCount++;
            logger.info({ from, to: recipient, sesMessageId }, 'SMTP relay: sent');
          }

          if (sentCount > 0) {
            void incrementSendUsageBy(user.apiKeyId, sentCount);
          }

          callback();
        })
        .catch((err: Error) => {
          logger.error({ err }, 'SMTP relay: parse/send error');
          callback(err);
        });
    });
  },
});

server.on('error', (err: Error) => {
  logger.error({ err }, 'SMTP relay server error');
});

server.listen(config.SMTP_RELAY_PORT, '0.0.0.0', () => {
  logger.info({ port: config.SMTP_RELAY_PORT, tlsConfigured: !!tls }, 'Continuum SMTP relay listening');
});

const shutdown = () => {
  server.close(() => {
    logger.info('SMTP relay closed');
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
