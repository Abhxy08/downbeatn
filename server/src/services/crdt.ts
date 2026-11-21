import * as Y from 'yjs';
import { z } from 'zod';
import { getFirestore } from './firebase';

/**
 * Session event log ("who did what"), kept as a Yjs CRDT per session.
 *
 * - Clients (plugin / web) send events as JSON over the WebSocket; the server is the
 *   Yjs authority, stamps identity + server time, de-duplicates by event id (clients
 *   retry from an outbox after reconnects), and broadcasts to the room.
 * - Persistence: each event is written to Firestore `sessions/{id}/events/{eventId}`
 *   (queryable by the dashboard / Credits Agent) and the Yjs state is snapshotted to
 *   `sessions/{id}/crdt/state` so the log survives server restarts.
 */

// ---------------------------------------------------------------------------
// Event schema
// ---------------------------------------------------------------------------
const db = z.number().min(-160).max(24);

export const clientEventSchemas = {
  /** Seconds (within a window) where the user's outgoing audio was above -50 dBFS */
  audio_activity: z.object({
    activeSeconds: z.number().min(0).max(600),
    windowSeconds: z.number().min(1).max(600),
    peakDb: db,
  }),
  /** MIDI notes that passed through the DownBeat plugin's track */
  midi_activity: z.object({
    notes: z.number().int().min(1).max(100000),
    lowest: z.number().int().min(0).max(127),
    highest: z.number().int().min(0).max(127),
    windowSeconds: z.number().min(1).max(600),
  }),
  /** A DownBeat plugin setting changed */
  param_change: z.object({
    param: z.string().min(1).max(64),
    value: z.union([z.number(), z.boolean(), z.string().max(64)]),
    previous: z.union([z.number(), z.boolean(), z.string().max(64)]).optional(),
  }),
  /** User muted / unmuted the audio they send to the session */
  send_mute: z.object({ muted: z.boolean() }),
  /** Free-text "what I did", typed by the user */
  contribution_note: z.object({ text: z.string().trim().min(1).max(280) }),
} as const;

export type ClientEventType = keyof typeof clientEventSchemas;
export type ServerEventType =
  | 'session_join'
  | 'session_leave'
  | 'tempo_change'
  // AI agents (logged so the Credits Agent can disclose AI use)
  | 'beat_jam'
  | 'mix_report'
  | 'credits_proposed'
  | 'credits_approved'
  | 'credits_changes_requested'
  | 'credits_final'
  // Shared MIDI clip edits
  | 'clip_edit';
export type EventType = ClientEventType | ServerEventType;

export interface SessionEvent {
  id: string;
  type: EventType;
  userId: string;
  userName: string;
  /** Server receive time (ms) — authoritative ordering */
  timestamp: number;
  /** Client clock when the event happened (may differ from server time) */
  clientTimestamp?: number;
  source: 'plugin' | 'web' | 'server';
  payload: Record<string, unknown>;
}

const eventIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

export type ValidationResult =
  | { ok: true; type: ClientEventType; payload: Record<string, unknown>; id: string }
  | { ok: false; error: string };

/** Validates an event coming from a client. Server-only event types are rejected. */
export function validateClientEvent(raw: { id?: unknown; eventType?: unknown; payload?: unknown }): ValidationResult {
  const id = eventIdSchema.safeParse(raw.id);
  if (!id.success) return { ok: false, error: 'id must be 8-64 chars of [A-Za-z0-9_-]' };
  const type = String(raw.eventType) as ClientEventType;
  const schema = clientEventSchemas[type];
  if (!schema) return { ok: false, error: `Unknown or server-only event type: ${raw.eventType}` };
  const parsed = schema.safeParse(raw.payload ?? {});
  if (!parsed.success) return { ok: false, error: `Invalid payload: ${parsed.error.issues[0]?.message}` };
  return { ok: true, type, payload: parsed.data as Record<string, unknown>, id: id.data };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
export interface EventPersistence {
  saveEvent(sessionId: string, event: SessionEvent): Promise<void>;
  saveSnapshot(sessionId: string, update: Uint8Array): Promise<void>;
  loadSnapshot(sessionId: string): Promise<Uint8Array | null>;
  loadEvents(sessionId: string): Promise<SessionEvent[]>;
}

const MAX_SNAPSHOT_BYTES = 900 * 1024; // Firestore documents are capped at 1 MiB

export const firestorePersistence: EventPersistence = {
  async saveEvent(sessionId, event) {
    await getFirestore().collection('sessions').doc(sessionId).collection('events').doc(event.id).set(event);
  },
  async saveSnapshot(sessionId, update) {
    if (update.byteLength > MAX_SNAPSHOT_BYTES) return; // events collection remains the source of truth
    await getFirestore()
      .collection('sessions').doc(sessionId).collection('crdt').doc('state')
      .set({ update: Buffer.from(update), savedAt: Date.now(), bytes: update.byteLength });
  },
  async loadSnapshot(sessionId) {
    const doc = await getFirestore().collection('sessions').doc(sessionId).collection('crdt').doc('state').get();
    const data = doc.exists ? (doc.data() as any) : null;
    return data?.update ? new Uint8Array(data.update) : null;
  },
  async loadEvents(sessionId) {
    const snap = await (getFirestore().collection('sessions').doc(sessionId).collection('events') as any)
      .orderBy('timestamp')
      .get();
    return snap.docs.map((d: any) => d.data() as SessionEvent);
  },
};

// ---------------------------------------------------------------------------
// CRDT manager
// ---------------------------------------------------------------------------
export interface UserContribution {
  userId: string;
  userName: string;
  count: number;
  types: Record<string, number>;
  audioActiveSeconds: number;
  midiNotes: number;
  /** Notes this person added to the shared MIDI clip */
  clipNotesAdded: number;
  tempoChanges: number;
  notes: string[];
  firstSeen: number;
  lastSeen: number;
}

export class SessionCrdtManager {
  private docs = new Map<string, Y.Doc>();
  private loading = new Map<string, Promise<void>>();
  private snapshotTimers = new Map<string, NodeJS.Timeout>();

  constructor(private persistence: EventPersistence | null = null, private snapshotDelayMs = 2000) {}

  /** Get or create the in-memory Yjs document for a session (does not load from storage). */
  getOrCreateDoc(sessionId: string): Y.Doc {
    let doc = this.docs.get(sessionId);
    if (!doc) {
      doc = new Y.Doc();
      this.docs.set(sessionId, doc);
    }
    return doc;
  }

  /** Loads a session's log from storage once (snapshot first, then the events collection). */
  ensureLoaded(sessionId: string): Promise<void> {
    if (!this.persistence) return Promise.resolve();
    let p = this.loading.get(sessionId);
    if (!p) {
      p = this.loadFromStorage(sessionId);
      this.loading.set(sessionId, p);
    }
    return p;
  }

  private async loadFromStorage(sessionId: string) {
    const doc = this.getOrCreateDoc(sessionId);
    try {
      const snapshot = await this.persistence!.loadSnapshot(sessionId);
      if (snapshot) {
        Y.applyUpdate(doc, snapshot);
        return;
      }
    } catch (e: any) {
      console.warn(`[EventLog] snapshot load failed for ${sessionId}: ${e.message}`);
    }
    try {
      const events = await this.persistence!.loadEvents(sessionId);
      const seen = this.seenIds(doc);
      const fresh = events.filter((e) => !seen.has(e.id));
      if (fresh.length) {
        doc.transact(() => {
          for (const e of fresh) seen.set(e.id, true);
          doc.getArray<SessionEvent>('events').push(fresh);
        });
      }
    } catch {
      /* no events stored (or Firestore unavailable in local dev) */
    }
  }

  private seenIds(doc: Y.Doc) {
    return doc.getMap<boolean>('ids');
  }

  /**
   * Appends an event. Returns false (and does nothing) if an event with this id
   * is already in the log — clients may resend after a reconnect.
   */
  appendEvent(sessionId: string, event: SessionEvent): boolean {
    const doc = this.getOrCreateDoc(sessionId);
    const seen = this.seenIds(doc);
    if (seen.has(event.id)) return false;

    doc.transact(() => {
      seen.set(event.id, true);
      doc.getArray<SessionEvent>('events').push([event]);
    });

    if (this.persistence) {
      this.persistence.saveEvent(sessionId, event).catch((e) => console.warn(`[EventLog] saveEvent failed: ${e.message}`));
      this.scheduleSnapshot(sessionId);
    }
    return true;
  }

  /** Marks the session's document as changed so it gets persisted (used by the shared clip). */
  touch(sessionId: string) {
    if (this.persistence) this.scheduleSnapshot(sessionId);
  }

  private scheduleSnapshot(sessionId: string) {
    if (this.snapshotTimers.has(sessionId)) return;
    const t = setTimeout(() => {
      this.snapshotTimers.delete(sessionId);
      this.saveSnapshot(sessionId);
    }, this.snapshotDelayMs);
    t.unref();
    this.snapshotTimers.set(sessionId, t);
  }

  private async saveSnapshot(sessionId: string) {
    try {
      await this.persistence?.saveSnapshot(sessionId, this.encodeState(sessionId));
    } catch (e: any) {
      console.warn(`[EventLog] snapshot save failed: ${e.message}`);
    }
  }

  /** Writes all pending snapshots now (call on shutdown). */
  async flush(): Promise<void> {
    const pending = Array.from(this.snapshotTimers.keys());
    for (const id of pending) {
      clearTimeout(this.snapshotTimers.get(id)!);
      this.snapshotTimers.delete(id);
    }
    await Promise.all(pending.map((id) => this.saveSnapshot(id)));
  }

  /** Events in server-timestamp order. */
  getEvents(sessionId: string): SessionEvent[] {
    return this.getOrCreateDoc(sessionId)
      .getArray<SessionEvent>('events')
      .toArray()
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  applyUpdate(sessionId: string, update: Uint8Array): void {
    Y.applyUpdate(this.getOrCreateDoc(sessionId), update);
  }

  encodeState(sessionId: string): Uint8Array {
    return Y.encodeStateAsUpdate(this.getOrCreateDoc(sessionId));
  }

  /** Per-collaborator rollup used by the dashboard and the Credits Agent. */
  getContributionSummary(sessionId: string): Record<string, UserContribution> {
    const summary: Record<string, UserContribution> = {};
    for (const evt of this.getEvents(sessionId)) {
      const s = (summary[evt.userId] ??= {
        userId: evt.userId,
        userName: evt.userName || 'Producer',
        count: 0,
        types: {},
        audioActiveSeconds: 0,
        midiNotes: 0,
        clipNotesAdded: 0,
        tempoChanges: 0,
        notes: [],
        firstSeen: evt.timestamp,
        lastSeen: evt.timestamp,
      });
      s.userName = evt.userName || s.userName;
      s.count++;
      s.types[evt.type] = (s.types[evt.type] || 0) + 1;
      s.lastSeen = Math.max(s.lastSeen, evt.timestamp);
      const p = evt.payload as any;
      if (evt.type === 'audio_activity') s.audioActiveSeconds += Number(p.activeSeconds) || 0;
      if (evt.type === 'midi_activity') s.midiNotes += Number(p.notes) || 0;
      if (evt.type === 'tempo_change') s.tempoChanges++;
      if (evt.type === 'clip_edit' && p.action === 'add') s.clipNotesAdded++;
      if (evt.type === 'contribution_note') s.notes.push(String(p.text));
    }
    for (const s of Object.values(summary)) s.audioActiveSeconds = Math.round(s.audioActiveSeconds * 10) / 10;
    return summary;
  }
}

export const crdtManager = new SessionCrdtManager(firestorePersistence);
