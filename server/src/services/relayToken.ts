import crypto from 'crypto';

/**
 * Relay admission tokens. The backend signs (sessionId, connectionId, expiresAt) with
 * RELAY_SECRET; the UDP relay recomputes the HMAC before forwarding any audio for that
 * sender. Keep this in sync with relay/src/protocol.ts.
 */
export const RELAY_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

export function signRelayToken(secret: string, sessionId: string, connectionId: string, expiresAt: number): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${sessionId.toLowerCase()}:${connectionId.toLowerCase()}:${expiresAt}`)
    .digest('hex')
    .slice(0, 32); // 16 bytes on the wire
}
