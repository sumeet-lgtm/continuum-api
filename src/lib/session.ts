import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { config } from '../config.js';

export interface SessionPayload extends JWTPayload {
  userId: string;
  email: string;
  primaryKeyId?: string;
  workspaceRole?: string;   // 'owner' | 'admin' | 'member' — set when user is in a shared workspace
  orgId?: string;
  orgRole?: string;
}

function secret(): Uint8Array {
  return new TextEncoder().encode(config.SESSION_SECRET);
}

export async function signSession(payload: Omit<SessionPayload, 'iat' | 'exp'>): Promise<string> {
  return new SignJWT(payload as JWTPayload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(secret());
}

export async function verifySession(token: string): Promise<SessionPayload> {
  const { payload } = await jwtVerify(token, secret());
  return payload as SessionPayload;
}
