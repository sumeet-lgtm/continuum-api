import { createHmac } from 'node:crypto';

const SECRET = process.env['OPTIN_SECRET'] ?? 'dev-optin-secret-change-in-prod';

function sign(payload: string): string {
  return createHmac('sha256', SECRET).update(payload).digest('base64url');
}

export function generateOptinToken(contactId: string, listId: string): string {
  const expiry = Date.now() + 7 * 24 * 3600 * 1000; // 7 days
  const payload = `${contactId}.${listId}.${expiry}`;
  const sig = sign(payload);
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

export function verifyOptinToken(token: string): { contactId: string; listId: string } | null {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const parts = decoded.split('.');
    if (parts.length !== 4) return null;

    const contactId = parts[0];
    const listId = parts[1];
    const expiryStr = parts[2];
    const sig = parts[3];

    if (!contactId || !listId || !expiryStr || !sig) return null;

    const payload = `${contactId}.${listId}.${expiryStr}`;

    if (sign(payload) !== sig) return null;
    if (Date.now() > parseInt(expiryStr, 10)) return null;

    return { contactId, listId };
  } catch {
    return null;
  }
}
