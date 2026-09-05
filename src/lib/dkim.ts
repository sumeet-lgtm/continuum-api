import { generateKeyPairSync, randomBytes } from 'crypto';
import { encryptValue, decryptValue } from './crypto.js';

export interface DkimKeyPair {
  selector: string;
  publicKey: string;        // PEM, put in DNS TXT record
  privateKeyEnc: string;    // AES-256-GCM encrypted PEM
  rawPrivateKey: string;    // plain PEM (use immediately for SES registration, then discard)
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
    rawPrivateKey: privateKey,
  };
}

export function decryptPrivateKey(enc: string, secret: string): string {
  return decryptValue(enc, secret);
}

// SES's BYODKIM CreateEmailIdentity/DkimSigningAttributes.DomainSigningPrivateKey
// requires the raw base64 key body ONLY — no PEM header/footer, no newlines
// (SES validates against ^[a-zA-Z0-9+\/]+={0,2}$). Passing the full PEM string
// straight through fails that regex on every single call, which the call
// sites' own try/catch silently swallowed — meaning no domain ever actually
// registered with SES, regardless of how correct its DNS records were.
export function pemToRawBase64(pem: string): string {
  return pem
    .replace(/-----BEGIN [A-Z ]+-----/, '')
    .replace(/-----END [A-Z ]+-----/, '')
    .replace(/\s/g, '');
}

// Format public key for DNS TXT record value
export function dnsPublicKeyValue(pemPublicKey: string): string {
  const b64 = pemPublicKey
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s/g, '');
  return `v=DKIM1; k=rsa; p=${b64}`;
}
