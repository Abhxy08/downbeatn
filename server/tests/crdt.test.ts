// Firestore isn't used here (tests inject an in-memory persistence); stub the module so firebase-admin isn't loaded.
jest.mock('../src/services/firebase', () => ({ getFirestore: () => { throw new Error('not in tests'); } }));

import * as Y from 'yjs';
import {
  SessionCrdtManager,
  SessionEvent,
  EventPersistence,
  validateClientEvent,
} from '../src/services/crdt';

const ev = (over: Partial<SessionEvent>): SessionEvent => ({
  id: `evt_${Math.random().toString(36).slice(2, 12)}`,
  type: 'contribution_note',
  userId: 'alice',
  userName: 'Alice',
  timestamp: Date.now(),
  source: 'plugin',
  payload: { text: 'hi' },
  ...over,
});

/** In-memory stand-in for Firestore. */
function memoryPersistence() {
  const events = new Map<string, SessionEvent[]>();
  const snapshots = new Map<string, Uint8Array>();
  const p: EventPersistence & { events: typeof events; snapshots: typeof snapshots } = {
    events,
    snapshots,
    async saveEvent(sid, e) {
      events.set(sid, [...(events.get(sid) ?? []), e]);
    },
    async saveSnapshot(sid, u) {
      snapshots.set(sid, u);
    },
    async loadSnapshot(sid) {
      return snapshots.get(sid) ?? null;
    },
    async loadEvents(sid) {
      return [...(events.get(sid) ?? [])].sort((a, b) => a.timestamp - b.timestamp);
    },
  };
  return p;
}

describe('validateClientEvent', () => {
  test('accepts each client event type with a valid payload', () => {
    const ok = [
      { eventType: 'audio_activity', payload: { activeSeconds: 8.5, windowSeconds: 10, peakDb: -6 } },
      { eventType: 'midi_activity', payload: { notes: 42, lowest: 36, highest: 72, windowSeconds: 10 } },
      { eventType: 'param_change', payload: { param: 'collaboratorVolume', value: -3, previous: 0 } },
      { eventType: 'send_mute', payload: { muted: true } },
      { eventType: 'contribution_note', payload: { text: '  wrote the chorus hook ' } },
    ];
    for (const e of ok) {
      const r = validateClientEvent({ id: 'abcdefgh12', ...e });
      expect(r.ok).toBe(true);
    }
    const note = validateClientEvent({ id: 'abcdefgh12', eventType: 'contribution_note', payload: { text: '  x  ' } });
    expect(note.ok && note.payload.text).toBe('x'); // trimmed
  });

  test('rejects server-only types, bad ids and bad payloads', () => {
    expect(validateClientEvent({ id: 'abcdefgh12', eventType: 'session_join', payload: {} }).ok).toBe(false);
    expect(validateClientEvent({ id: 'abcdefgh12', eventType: 'tempo_change', payload: { bpm: 1 } }).ok).toBe(false);
    expect(validateClientEvent({ id: 'short', eventType: 'send_mute', payload: { muted: true } }).ok).toBe(false);
    expect(validateClientEvent({ id: 'abcdefgh12', eventType: 'send_mute', payload: { muted: 'yes' } }).ok).toBe(false);
    expect(validateClientEvent({ id: 'abcdefgh12', eventType: 'contribution_note', payload: { text: 'x'.repeat(281) } }).ok).toBe(false);
    expect(validateClientEvent({ id: 'abcdefgh12', eventType: 'midi_activity', payload: { notes: 1, lowest: 0, highest: 200, windowSeconds: 10 } }).ok).toBe(false);
  });
});

describe('SessionCrdtManager', () => {
  test('appends events and returns them in server-time order', () => {
    const crdt = new SessionCrdtManager();
    crdt.appendEvent('s', ev({ id: 'event-b-0001', timestamp: 2000 }));
    crdt.appendEvent('s', ev({ id: 'event-a-0001', timestamp: 1000 }));
    expect(crdt.getEvents('s').map((e) => e.id)).toEqual(['event-a-0001', 'event-b-0001']);
  });

  test('de-duplicates by event id (client retries after reconnect)', () => {
    const crdt = new SessionCrdtManager();
    const e = ev({ id: 'retry-me-123' });
    expect(crdt.appendEvent('s', e)).toBe(true);
    expect(crdt.appendEvent('s', e)).toBe(false);
    expect(crdt.getEvents('s')).toHaveLength(1);
  });

  test('persists events + snapshot and restores after a "restart"', async () => {
    const store = memoryPersistence();
    const a = new SessionCrdtManager(store, 10);
    a.appendEvent('s1', ev({ id: 'persist-0001', timestamp: 1 }));
    a.appendEvent('s1', ev({ id: 'persist-0002', timestamp: 2 }));
    await new Promise((r) => setTimeout(r, 30));
    expect(store.events.get('s1')).toHaveLength(2);
    expect(store.snapshots.has('s1')).toBe(true);

    const b = new SessionCrdtManager(store); // new process
    await b.ensureLoaded('s1');
    expect(b.getEvents('s1').map((e) => e.id)).toEqual(['persist-0001', 'persist-0002']);
    expect(b.appendEvent('s1', ev({ id: 'persist-0001' }))).toBe(false); // dedupe survives restart
  });

  test('falls back to the events collection when there is no snapshot', async () => {
    const store = memoryPersistence();
    store.events.set('s2', [ev({ id: 'from-events-1', timestamp: 5 }), ev({ id: 'from-events-2', timestamp: 6 })]);
    const crdt = new SessionCrdtManager(store);
    await Promise.all([crdt.ensureLoaded('s2'), crdt.ensureLoaded('s2')]); // concurrent callers load once
    expect(crdt.getEvents('s2')).toHaveLength(2);
  });

  test('flush() writes pending snapshots immediately', async () => {
    const store = memoryPersistence();
    const crdt = new SessionCrdtManager(store, 60_000);
    crdt.appendEvent('s3', ev({ id: 'flush-me-001' }));
    expect(store.snapshots.has('s3')).toBe(false);
    await crdt.flush();
    expect(store.snapshots.has('s3')).toBe(true);
  });

  test('contribution summary per collaborator', () => {
    const crdt = new SessionCrdtManager();
    crdt.appendEvent('s', ev({ type: 'audio_activity', payload: { activeSeconds: 8, windowSeconds: 10, peakDb: -3 } }));
    crdt.appendEvent('s', ev({ type: 'audio_activity', payload: { activeSeconds: 4.5, windowSeconds: 10, peakDb: -3 } }));
    crdt.appendEvent('s', ev({ type: 'contribution_note', payload: { text: 'wrote the bassline' } }));
    crdt.appendEvent('s', ev({ userId: 'bob', userName: 'Bob', type: 'midi_activity', payload: { notes: 30, lowest: 40, highest: 60, windowSeconds: 10 } }));
    crdt.appendEvent('s', ev({ userId: 'bob', userName: 'Bob', type: 'tempo_change', source: 'server', payload: { bpm: 124 } }));

    const s = crdt.getContributionSummary('s');
    expect(s.alice.audioActiveSeconds).toBe(12.5);
    expect(s.alice.notes).toEqual(['wrote the bassline']);
    expect(s.alice.types).toEqual({ audio_activity: 2, contribution_note: 1 });
    expect(s.bob.midiNotes).toBe(30);
    expect(s.bob.tempoChanges).toBe(1);
    expect(s.bob.count).toBe(2);
  });

  test('two replicas merge concurrent edits without conflicts (CRDT)', () => {
    const a = new SessionCrdtManager();
    const b = new SessionCrdtManager();
    a.appendEvent('sync', ev({ id: 'from-replica-a', timestamp: 500 }));
    b.appendEvent('sync', ev({ id: 'from-replica-b', userId: 'bob', timestamp: 510 }));

    Y.applyUpdate(b.getOrCreateDoc('sync'), Y.encodeStateAsUpdate(a.getOrCreateDoc('sync')));
    Y.applyUpdate(a.getOrCreateDoc('sync'), Y.encodeStateAsUpdate(b.getOrCreateDoc('sync')));

    expect(a.getEvents('sync').map((e) => e.id)).toEqual(['from-replica-a', 'from-replica-b']);
    expect(b.getEvents('sync').map((e) => e.id)).toEqual(['from-replica-a', 'from-replica-b']);
  });
});
