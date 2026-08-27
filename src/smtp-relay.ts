/**
 * SMTP Relay Server (Port 587)
 *
 * Bridges SMTP to the Continuum /v1/send REST pipeline.
 * Auth: API key as password (any username works).
 * Supports: STARTTLS, AUTH PLAIN/LOGIN, up to 50MB messages.
 *
 * Start via: npm run smtp-relay
 */

import SMTPServer from 'smtp-server';
import { simpleParser } from 'mailparser';
import { prisma } from './lib/prisma.js';
import { logger } from './lib/logger.js';
import { createHash } from 'node:crypto';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { config } from './config.js';

const ses = new SESv2Client({ region: config.AWS_REGION ?? 'us-east-1' });
const SMTP_PORT = parseInt(process.env['SMTP_PORT'] ?? '587', 10);

async function resolveApiKey(password: string): Promise<{ id: string; apiKeyId: string; plan: string } | null> {
  const keyHash = createHash('sha256').update(password).digest('hex');
  const apiKey = await prisma.apiKey.findUnique({
    where: { keyHash },
    select: { id: true, isActive: true, plan: true },
  }).catch(() => null);

  if (!apiKey || !apiKey.isActive) return null;
  return { id: apiKey.id, apiKeyId: apiKey.id, plan: apiKey.plan };
}

const server = new SMTPServer.SMTPServer({
  secure: false,
  authOptional: false,
  allowInsecureAuth: false,
  size: 52428800, // 50 MB
  banner: 'Continuum SMTP Relay',

  onAuth(auth, _session, callback) {
    const password = (auth as { credentials?: { password?: string }; password?: string }).credentials?.password ?? (auth as { password?: string }).password ?? '';
    resolveApiKey(password)
      .then((key) => {
        if (!key) {
          return callback(new Error('Invalid API key'));
        }
        callback(null, { user: key });
      })
      .catch((err) => callback(err as Error));
  },

  onData(stream, session, callback) {
    const chunks: Buffer[] = [];

    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      const raw = Buffer.concat(chunks);
      const apiKey = session.user as { id: string; plan: string } | undefined;

      if (!apiKey) {
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

          if (to.length === 0) {
            return callback(new Error('No recipients'));
          }

          for (const recipient of to) {
            // Check suppression
            const suppressed = await prisma.suppression.findUnique({ where: { email: recipient } });
            if (suppressed) {
              logger.info({ email: recipient }, 'SMTP relay: skipping suppressed recipient');
              continue;
            }

            const resp = await ses.send(new SendEmailCommand({
              FromEmailAddress: fromName ? `${fromName} <${from}>` : from,
              Destination: { ToAddresses: [recipient] },
              Content: {
                Simple: {
                  Subject: { Data: subject, Charset: 'UTF-8' },
                  Body: {
                    Html: { Data: html || text, Charset: 'UTF-8' },
                    ...(text ? { Text: { Data: text, Charset: 'UTF-8' } } : {}),
                  },
                },
              },
            }));

            // Persist to SendMessage for tracking
            await prisma.sendMessage.create({
              data: {
                apiKeyId: apiKey.id,
                sesMessageId: resp.MessageId ?? '',
                from,
                to: recipient,
                subject,
                status: 'sent',
              },
            }).catch(() => {});

            logger.info({ from, to: recipient, sesMessageId: resp.MessageId }, 'SMTP relay: sent');
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

server.listen(SMTP_PORT, '0.0.0.0', () => {
  logger.info({ port: SMTP_PORT }, 'Continuum SMTP relay listening');
});

const shutdown = () => {
  server.close(() => {
    logger.info('SMTP relay closed');
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
