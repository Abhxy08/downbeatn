import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { getAuth, getFirestore } from '../services/firebase';
import { verifyAnyToken, decodeDevMockToken } from '../services/verifyToken';
import { deviceStore } from '../services/devices';

export const authRouter = Router();

export interface PairingRecord {
  pairingId: string;
  code: string;
  status: 'pending' | 'confirmed' | 'expired';
  createdAt: number;
  expiresAt: number;
  userId?: string;
  userEmail?: string;
  displayName?: string;
  refreshToken?: string;
  /** set once the plugin has collected its credential (it's handed out only once) */
  delivered?: boolean;
  deviceLabel?: string;
}

// In-memory pairings cache with fallback for fast polling
export const pairingsCache = new Map<string, PairingRecord>();

// Helper to generate 6-character code
export function generatePairingCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No ambiguous 0/O, 1/I
  let code = '';
  const randomBytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    code += chars[randomBytes[i] % chars.length];
  }
  return code;
}

/**
 * 1. Plugin requests device pairing code
 * POST /auth/pair/start
 */
authRouter.post('/pair/start', async (req: Request, res: Response) => {
  try {
    const pairingId = crypto.randomUUID();
    const code = generatePairingCode();
    const now = Date.now();
    const expiresAt = now + config.pairingCodeTtlMinutes * 60 * 1000;

    const label = typeof req.body?.deviceLabel === 'string' ? req.body.deviceLabel.slice(0, 80) : 'DAW plugin';
    const record: PairingRecord = {
      pairingId,
      code,
      status: 'pending',
      createdAt: now,
      expiresAt,
      deviceLabel: label,
    };

    pairingsCache.set(pairingId, record);

    // Persist to Firestore if available
    try {
      const db = getFirestore();
      await db.collection('pairings').doc(pairingId).set(record);
    } catch (e) {
      // Non-fatal in local dev mode without Firebase connection
      console.warn('[Auth] Firestore pairing persist skipped (using memory cache)');
    }

    res.json({
      success: true,
      pairingId,
      code,
      pairUrl: `${config.webUrl}/link?code=${code}`,
      expiresInSeconds: config.pairingCodeTtlMinutes * 60,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 2. Web app confirms pairing after Firebase sign-in
 * POST /auth/pair/confirm
 */
authRouter.post('/pair/confirm', async (req: Request, res: Response) => {
  try {
    const { code, idToken } = req.body;

    if (!code || !idToken) {
      return res.status(400).json({ success: false, error: 'Both "code" and "idToken" are required.' });
    }

    // Verify Firebase ID Token
    let decodedToken: { uid: string; email?: string; name?: string };
    try {
      const auth = getAuth();
      decodedToken = await auth.verifyIdToken(idToken);
    } catch (authError: any) {
      // In dev or test mode, support fallback simulated dev token
      const dev = decodeDevMockToken(idToken);
      if (dev) {
        decodedToken = { uid: dev.uid, email: dev.email, name: dev.name };
      } else {
        return res.status(401).json({ success: false, error: 'Invalid Firebase ID token', details: authError.message });
      }
    }

    // Find pairing by 6-char code
    const normalizedCode = code.trim().toUpperCase();
    let foundPairing: PairingRecord | undefined;

    for (const record of pairingsCache.values()) {
      if (record.code === normalizedCode) {
        foundPairing = record;
        break;
      }
    }

    // Fallback search in Firestore
    if (!foundPairing) {
      try {
        const db = getFirestore();
        const snapshot = await db.collection('pairings').where('code', '==', normalizedCode).limit(1).get();
        if (!snapshot.empty) {
          foundPairing = snapshot.docs[0].data() as PairingRecord;
        }
      } catch (e) {
        // Firestore not available
      }
    }

    if (!foundPairing) {
      return res.status(404).json({ success: false, error: 'Pairing code not found or expired.' });
    }

    if (foundPairing.status !== 'pending') {
      return res.status(409).json({ success: false, error: 'This pairing code was already used. Start again from the plugin.' });
    }

    if (Date.now() > foundPairing.expiresAt) {
      foundPairing.status = 'expired';
      return res.status(410).json({ success: false, error: 'Pairing code has expired. Request a new one in the plugin.' });
    }

    // Generate long-lived plugin refresh credential
    const refreshToken = jwt.sign(
      {
        uid: decodedToken.uid,
        email: decodedToken.email || '',
        name: decodedToken.name || 'Producer',
        type: 'plugin_refresh',
        did: foundPairing.pairingId,
      },
      config.jwtSecret,
      { expiresIn: '90d' }
    );

    foundPairing.status = 'confirmed';
    foundPairing.userId = decodedToken.uid;
    foundPairing.userEmail = decodedToken.email;
    foundPairing.displayName = decodedToken.name || decodedToken.email || 'Producer';
    foundPairing.refreshToken = refreshToken;

    pairingsCache.set(foundPairing.pairingId, foundPairing);

    // Update in Firestore
    try {
      const db = getFirestore();
      await db.collection('pairings').doc(foundPairing.pairingId).update({
        status: 'confirmed',
        userId: decodedToken.uid,
        userEmail: decodedToken.email || '',
        displayName: foundPairing.displayName,
        updatedAt: Date.now(),
      });

    } catch (e) {
      // Ignored for local testing
    }

    // Only a hash of the credential is stored; the device can be revoked from the dashboard.
    await deviceStore.register(decodedToken.uid, foundPairing.pairingId, refreshToken, foundPairing.deviceLabel || 'DAW plugin');

    res.json({
      success: true,
      message: 'Plugin successfully paired!',
      user: {
        uid: decodedToken.uid,
        email: decodedToken.email,
        displayName: foundPairing.displayName,
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 3. Plugin polls pairing status
 * GET /auth/pair/status?pairingId=...
 */
authRouter.get('/pair/status', async (req: Request, res: Response) => {
  const pairingId = req.query.pairingId as string;

  if (!pairingId) {
    return res.status(400).json({ success: false, error: 'Query parameter "pairingId" is required.' });
  }

  let record = pairingsCache.get(pairingId);

  if (!record) {
    try {
      const db = getFirestore();
      const doc = await db.collection('pairings').doc(pairingId).get();
      if (doc.exists) {
        record = doc.data() as PairingRecord;
      }
    } catch (e) {
      // Ignored
    }
  }

  if (!record) {
    return res.status(404).json({ success: false, error: 'Pairing record not found.' });
  }

  if (Date.now() > record.expiresAt && record.status === 'pending') {
    record.status = 'expired';
    return res.json({ status: 'expired' });
  }

  if (record.status === 'confirmed' && (record.delivered || !record.refreshToken)) {
    // The credential is handed out exactly once (to the plugin that is polling).
    return res.json({ status: 'confirmed', alreadyDelivered: true });
  }

  if (record.status === 'confirmed') {
    // Generate initial short-lived session token as well
    const sessionToken = jwt.sign(
      {
        uid: record.userId,
        email: record.userEmail,
        name: record.displayName,
        type: 'session',
        did: record.pairingId,
      },
      config.jwtSecret,
      { expiresIn: '1h' }
    );

    const refreshToken = record.refreshToken;
    record.delivered = true;
    record.refreshToken = undefined;

    return res.json({
      status: 'confirmed',
      refreshToken,
      sessionToken,
      user: {
        uid: record.userId,
        email: record.userEmail,
        displayName: record.displayName,
      },
    });
  }

  res.json({ status: 'pending' });
});

/**
 * 4. Plugin refreshes short-lived session token
 * POST /auth/token/refresh
 */
authRouter.post('/token/refresh', async (req: Request, res: Response) => {
  const { refreshToken } = req.body || {};

  if (!refreshToken) {
    return res.status(400).json({ success: false, error: 'refreshToken is required.' });
  }

  try {
    const payload = jwt.verify(refreshToken, config.jwtSecret) as any;
    if (payload.type !== 'plugin_refresh') {
      return res.status(401).json({ success: false, error: 'Invalid token type.' });
    }
    if (!(await deviceStore.isActive(payload.uid, payload.did, refreshToken))) {
      return res.status(401).json({ success: false, error: 'This plugin was signed out. Pair it again.' });
    }
    if (payload.did) deviceStore.touch(payload.uid, payload.did);

    const sessionToken = jwt.sign(
      {
        uid: payload.uid,
        email: payload.email,
        name: payload.name,
        type: 'session',
        did: payload.did,
      },
      config.jwtSecret,
      { expiresIn: '1h' }
    );

    res.json({
      success: true,
      sessionToken,
      expiresIn: 3600,
    });
  } catch (err: any) {
    res.status(401).json({ success: false, error: 'Invalid or expired refresh token.' });
  }
});

/**
 * Paired plugins for the signed-in user.
 * GET /auth/devices, DELETE /auth/devices/:id
 */
authRouter.get('/devices', requireAuth, async (req: Request, res: Response) => {
  const user = (req as any).user;
  const devices = (await deviceStore.list(user.uid)).map(({ tokenHash, ...d }) => ({ ...d, current: d.deviceId === user.deviceId }));
  res.json({ success: true, devices });
});

authRouter.delete('/devices/:id', requireAuth, async (req: Request, res: Response) => {
  const user = (req as any).user;
  const ok = await deviceStore.revoke(user.uid, String(req.params.id));
  if (!ok) return res.status(404).json({ success: false, error: 'Device not found.' });
  res.json({ success: true });
});

/**
 * Auth verification middleware for protected routes.
 * Accepts a plugin session JWT or a Firebase ID token (web dashboard).
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header.' });
  }

  try {
    (req as any).user = await verifyAnyToken(authHeader.substring(7));
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session token.' });
  }
}
