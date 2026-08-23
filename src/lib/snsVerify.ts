/**
 * AWS SNS message signature verification.
 *
 * SNS signs every message it POSTs (Notification, SubscriptionConfirmation,
 * UnsubscribeConfirmation) with an RSA key whose certificate it also serves
 * over HTTPS. Verifying is what stops an attacker from POSTing a forged
 * "bounce" straight at /v1/send/events to create fake suppressions or spoof
 * delivery status for someone else's send.
 *
 * This re-implements the same algorithm the `sns-validator` npm package
 * uses, without adding the dependency: build the exact newline-delimited
 * string SNS signed (field order matters and differs by message Type),
 * fetch the signing certificate (restricted to *.amazonaws.com to prevent
 * SSRF to an attacker-hosted "certificate"), and verify with Node's crypto.
 */

import crypto from 'node:crypto';
import { logger } from './logger.js';

export interface SnsMessage {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  UnsubscribeURL?: string;
  SubscribeURL?: string;
  Token?: string;
}

const CERT_URL_PATTERN = /^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com\/SimpleNotificationService-[a-zA-Z0-9]+\.pem$/;

function buildStringToSign(msg: SnsMessage): string {
  const fields: Array<[string, string | undefined]> =
    msg.Type === 'SubscriptionConfirmation' || msg.Type === 'UnsubscribeConfirmation'
      ? [
          ['Message', msg.Message], ['MessageId', msg.MessageId],
          ['SubscribeURL', msg.SubscribeURL], ['Timestamp', msg.Timestamp],
          ['Token', msg.Token], ['TopicArn', msg.TopicArn], ['Type', msg.Type],
        ]
      : [
          ['Message', msg.Message], ['MessageId', msg.MessageId],
          ...(msg.Subject !== undefined ? [['Subject', msg.Subject] as [string, string]] : []),
          ['Timestamp', msg.Timestamp], ['TopicArn', msg.TopicArn], ['Type', msg.Type],
        ];

  return fields
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}\n${v}\n`)
    .join('');
}

// Bounded, same pattern as auth.ts's keyCache: the CERT_URL_PATTERN check
// restricts the host to *.amazonaws.com, but an attacker can still hand us
// many distinct (region, filename) combinations that all match the pattern
// and are each individually valid to fetch — without a cap this cache (and
// the outbound fetches filling it) grows without bound.
const certCache = new Map<string, string>();
const CERT_CACHE_MAX_SIZE = 100; // AWS rotates this cert rarely; real usage never needs more than a handful

async function fetchCert(url: string): Promise<string> {
  const cached = certCache.get(url);
  if (cached) return cached;

  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Failed to fetch SNS signing cert: ${res.status}`);
  const pem = await res.text();

  if (certCache.size >= CERT_CACHE_MAX_SIZE) {
    const oldest = certCache.keys().next().value;
    if (oldest !== undefined) certCache.delete(oldest);
  }
  certCache.set(url, pem);
  return pem;
}

/**
 * Verifies an SNS message's signature. Returns false (never throws) on any
 * failure — a bad/unreachable cert fetch is a rejection, not a crash.
 */
export async function verifySnsMessage(msg: SnsMessage): Promise<boolean> {
  try {
    if (!CERT_URL_PATTERN.test(msg.SigningCertURL)) {
      logger.warn({ url: msg.SigningCertURL }, 'SNS SigningCertURL failed hostname check');
      return false;
    }
    if (msg.SignatureVersion !== '1' && msg.SignatureVersion !== '2') {
      logger.warn({ version: msg.SignatureVersion }, 'Unsupported SNS SignatureVersion');
      return false;
    }

    const pem = await fetchCert(msg.SigningCertURL);
    const stringToSign = buildStringToSign(msg);
    const verifier = crypto.createVerify(msg.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1');
    verifier.update(stringToSign, 'utf8');
    return verifier.verify(pem, msg.Signature, 'base64');
  } catch (err) {
    logger.error({ err }, 'SNS signature verification errored');
    return false;
  }
}
