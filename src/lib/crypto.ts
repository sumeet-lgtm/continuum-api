import { createHash, createHmac, randomBytes, createCipheriv, createDecipheriv } from 'crypto';

export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

export function generateApiKey(): string {
  return 'cnt_' + randomBytes(24).toString('hex');
}

export function getKeyPrefix(rawKey: string): string {
  return rawKey.slice(0, 12);
}

export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

export function hmacSign(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function hmacVerify(secret: string, data: string, sig: string): boolean {
  const expected = hmacSign(secret, data);
  if (expected.length !== sig.length) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export function generateSecret(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

// Webhook signature helpers (Svix-compatible sha256=<hex> format)
export function signWebhookPayload(secret: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

export function verifyWebhookSignature(secret: string, body: string, sig: string): boolean {
  if (!sig) return false;
  const expected = signWebhookPayload(secret, body);
  if (expected.length !== sig.length) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

// AES-256-GCM encryption for sensitive values (DKIM keys, SMTP passwords)
const AES_KEY_LEN = 32;
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;

function getEncKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest().subarray(0, AES_KEY_LEN);
}

export function encryptValue(plaintext: string, secret: string): string {
  const key = getEncKey(secret);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptValue(ciphertext: string, secret: string): string {
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + AUTH_TAG_LEN);
  const enc = buf.subarray(IV_LEN + AUTH_TAG_LEN);
  const key = getEncKey(secret);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc).toString('utf8') + decipher.final('utf8');
}
