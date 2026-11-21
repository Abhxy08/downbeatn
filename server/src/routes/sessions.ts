import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { requireAuth } from './auth';
import { getFirestore } from '../services/firebase';
import { crdtManager } from '../services/crdt';
import type { VerifiedUser } from '../services/verifyToken';

export const sessionsRouter = Router();

export interface SessionData {
  id: string;
  name: string;
  inviteCode: string;
  ownerId: string;
  ownerName: string;
  bpm: number;
  keySignature: string;
  members: string[];
  /** uid -> display name, so clients can label people who are offline */
  memberNames: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

// In-memory cache; Firestore is the source of truth when configured
export const sessionsStore = new Map<string, SessionData>();

const INVITE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function generateInviteCode(): string {
  const bytes = crypto.randomBytes(4);
  let code = '';
  for (let i = 0; i < 4; i++) code += INVITE_ALPHABET[bytes[i] % INVITE_ALPHABET.length];
  return `DB-${code}`;
}

export function normalizeInviteCode(raw: string): string {
  const cleaned = String(raw).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = cleaned.startsWith('DB') ? cleaned.slice(2) : cleaned;
  return `DB-${body}`;
}

function withDefaults(s: SessionData): SessionData {
  return { ...s, memberNames: s.memberNames || {} };
}

/** Load a session by id from cache, falling back to Firestore. */
export async function loadSession(id: string): Promise<SessionData | undefined> {
  const cached = sessionsStore.get(id);
  if (cached) return cached;
  try {
    const doc = await getFirestore().collection('sessions').doc(id).get();
    if (doc.exists) {
      const s = withDefaults(doc.data() as SessionData);
      sessionsStore.set(s.id, s);
      return s;
    }
  } catch {
    /* Firestore unavailable in local dev */
  }
  return undefined;
}

async function findByInviteCode(code: string): Promise<SessionData | undefined> {
  for (const s of sessionsStore.values()) if (s.inviteCode === code) return s;
  try {
    const snap = await getFirestore().collection('sessions').where('inviteCode', '==', code).limit(1).get();
    if (!snap.empty) {
      const s = withDefaults(snap.docs[0].data() as SessionData);
      sessionsStore.set(s.id, s);
      return s;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

export function isMember(session: SessionData, uid: string): boolean {
  return session.members.includes(uid) || session.ownerId === uid;
}

/**
 * List sessions the caller is a member of
 * GET /sessions
 */
sessionsRouter.get('/', requireAuth, async (req: Request, res: Response) => {
  const user = (req as any).user as VerifiedUser;
  const byId = new Map<string, SessionData>();

  for (const s of sessionsStore.values()) if (isMember(s, user.uid)) byId.set(s.id, s);

  try {
    const snap = await getFirestore()
      .collection('sessions')
      .where('members', 'array-contains', user.uid)
      .limit(50)
      .get();
    for (const doc of snap.docs) {
      const s = withDefaults(doc.data() as SessionData);
      if (isMember(s, user.uid)) {
        byId.set(s.id, s);
        sessionsStore.set(s.id, s);
      }
    }
  } catch {
    /* ignore */
  }

  const sessions = Array.from(byId.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  res.json({ success: true, sessions });
});

/**
 * Create new session
 * POST /sessions
 */
sessionsRouter.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user as VerifiedUser;
    const { name, bpm = 120, keySignature = 'C min' } = req.body || {};

    const parsedBpm = Number(bpm);
    if (!Number.isFinite(parsedBpm) || parsedBpm < 20 || parsedBpm > 999) {
      return res.status(400).json({ success: false, error: 'bpm must be between 20 and 999.' });
    }

    // Avoid (unlikely) invite code collisions
    let inviteCode = generateInviteCode();
    for (let i = 0; i < 5 && (await findByInviteCode(inviteCode)); i++) inviteCode = generateInviteCode();

    const now = Date.now();
    const session: SessionData = {
      id: crypto.randomUUID(),
      name: String(name || '').trim().slice(0, 80) || `Jam Session ${new Date(now).toISOString().slice(0, 10)}`,
      inviteCode,
      ownerId: user.uid,
      ownerName: user.name,
      bpm: parsedBpm,
      keySignature: String(keySignature).slice(0, 16),
      members: [user.uid],
      memberNames: { [user.uid]: user.name },
      createdAt: now,
      updatedAt: now,
    };

    sessionsStore.set(session.id, session);
    crdtManager.getOrCreateDoc(session.id);

    try {
      await getFirestore().collection('sessions').doc(session.id).set(session);
    } catch {
      /* ignore in dev */
    }

    res.status(201).json({ success: true, session });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Join session by invite code
 * POST /sessions/join  { inviteCode }
 */
sessionsRouter.post('/join', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user as VerifiedUser;
    const { inviteCode } = req.body || {};

    if (!inviteCode || typeof inviteCode !== 'string') {
      return res.status(400).json({ success: false, error: '"inviteCode" is required.' });
    }

    const session = await findByInviteCode(normalizeInviteCode(inviteCode));
    if (!session) {
      return res.status(404).json({ success: false, error: 'No session with that invite code.' });
    }

    const nameChanged = session.memberNames[user.uid] !== user.name;
    if (!session.members.includes(user.uid) || nameChanged) {
      if (!session.members.includes(user.uid)) session.members.push(user.uid);
      session.memberNames[user.uid] = user.name;
      session.updatedAt = Date.now();

      try {
        await getFirestore().collection('sessions').doc(session.id).update({
          members: session.members,
          memberNames: session.memberNames,
          updatedAt: session.updatedAt,
        });
      } catch {
        /* ignore */
      }
    }

    res.json({ success: true, session });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get session details (members only)
 * GET /sessions/:id
 */
sessionsRouter.get('/:id', requireAuth, async (req: Request, res: Response) => {
  const user = (req as any).user as VerifiedUser;
  const session = await loadSession(String(req.params.id));

  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found.' });
  }
  if (!isMember(session, user.uid)) {
    return res.status(403).json({ success: false, error: 'You are not a member of this session.' });
  }

  res.json({ success: true, session });
});

/**
 * Session event log (members only), oldest first.
 * GET /sessions/:id/events?limit=200&since=<ms>
 */
sessionsRouter.get('/:id/events', requireAuth, async (req: Request, res: Response) => {
  const user = (req as any).user as VerifiedUser;
  const session = await loadSession(String(req.params.id));
  if (!session) return res.status(404).json({ success: false, error: 'Session not found.' });
  if (!isMember(session, user.uid)) return res.status(403).json({ success: false, error: 'You are not a member of this session.' });

  await crdtManager.ensureLoaded(session.id);
  const limit = Math.min(1000, Math.max(1, parseInt(String(req.query.limit ?? '200'), 10) || 200));
  const since = Number(req.query.since) || 0;
  const all = crdtManager.getEvents(session.id).filter((e) => e.timestamp > since);
  res.json({ success: true, total: all.length, events: all.slice(-limit) });
});

/**
 * Per-collaborator contribution rollup (members only)
 * GET /sessions/:id/contributions
 */
sessionsRouter.get('/:id/contributions', requireAuth, async (req: Request, res: Response) => {
  const user = (req as any).user as VerifiedUser;
  const session = await loadSession(String(req.params.id));
  if (!session) return res.status(404).json({ success: false, error: 'Session not found.' });
  if (!isMember(session, user.uid)) return res.status(403).json({ success: false, error: 'You are not a member of this session.' });

  await crdtManager.ensureLoaded(session.id);
  res.json({ success: true, contributions: Object.values(crdtManager.getContributionSummary(session.id)) });
});
