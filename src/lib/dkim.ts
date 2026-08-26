import { generateKeyPairSync, randomBytes } from 'crypto';
import { encryptValue, decryptValue } from './crypto.js';

export interface DkimKeyPair {
  selector: string;
  publicKey: string;        // PEM, put in DNS TXT record
  privateKeyEnc: string;    // AES-256-GCM encrypted PEM
}

export function generateDkimKeyPair(secret: string): DkimKeyPair {
  const selector = `ctm${randomBytes(4).toString('hex')}`;

  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  return {
    selector,
    publicKey,
    privateKeyEnc: encryptValue(privateKey, secret),
  };
}

export function decryptPrivateKey(enc: string, secret: string): string {
  return decryptValue(enc, secret);
}

// Format public key for DNS TXT record value
export function dnsPublicKeyValue(pemPublicKey: string): string {
  const b64 = pemPublicKey
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s/g, '');
  return `v=DKIM1; k=rsa; p=${b64}`;
}
