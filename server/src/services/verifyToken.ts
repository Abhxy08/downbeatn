import jwt from 'jsonwebtoken';
import { config } from '../config';
import { getAuth } from './firebase';
import { deviceStore } from './devices';

export interface VerifiedUser {
  uid: string;
  name: string;
  email: string;
  /** 'plugin' = short-lived DownBeat session JWT, 'web' = Firebase ID token */
  source: 'plugin' | 'web';
  /** Paired plugin instance the session token belongs to */
  deviceId?: string;
}

export class AuthError extends Error {}

const DEV_MOCK_PREFIX = 'dev-mock-token-';

export function devMockTokensAllowed(): boolean {
  return config.env === 'test' || config.allowDevTokens;
}

/** Dev-only fake identity: "dev-mock-token-sam" -> uid "dev-user-sam". */
export function decodeDevMockToken(token: string): VerifiedUser | null {
  if (!devMockTokensAllowed() || !token.startsWith(DEV_MOCK_PREFIX)) return null;
  const suffix = token.slice(DEV_MOCK_PREFIX.length).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'alex';
  const name = suffix === 'alex' ? 'Alex Beatmaker' : `Dev ${suffix.charAt(0).toUpperCase()}${suffix.slice(1)}`;
  return { uid: `dev-user-${suffix}`, name, email: `${suffix}@downbeat.dev`, source: 'web' };
}

/**
 * Verifies either a DownBeat plugin session JWT (type "session") or a Firebase ID token.
 * Refresh tokens are deliberately rejected here: they may only be used at /auth/token/refresh.
 */
export async function verifyAnyToken(token: string | undefined | null): Promise<VerifiedUser> {
  if (!token) throw new AuthError('Missing token');

  // 1. DownBeat session JWT (HS256, signed by this server)
  let payload: any = null;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    // not one of ours — fall through
  }
  if (payload) {
    if (payload.type !== 'session') throw new AuthError('Wrong token type');
    if (!(await deviceStore.isActive(payload.uid, payload.did))) throw new AuthError('This plugin was signed out (device revoked)');
    return {
      uid: payload.uid,
      name: payload.name || payload.email || 'Producer',
      email: payload.email || '',
      source: 'plugin',
      deviceId: payload.did,
    };
  }

  // 2. Dev-only mock tokens (never in production)
  const dev = decodeDevMockToken(token);
  if (dev) return dev;

  // 3. Firebase ID token from the web app
  try {
    const decoded = await getAuth().verifyIdToken(token);
    return {
      uid: decoded.uid,
      name: (decoded.name as string) || decoded.email || 'Producer',
      email: decoded.email || '',
      source: 'web',
    };
  } catch {
    throw new AuthError('Invalid or expired token');
  }
}
