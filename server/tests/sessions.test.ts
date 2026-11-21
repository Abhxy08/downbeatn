// Firestore is unavailable in these tests (the in-memory session cache is used),
// and Firebase ID tokens are faked. Plain functions are used instead of jest.fn
// because jest.config has resetMocks: true.
jest.mock('../src/services/firebase', () => ({
  initFirebase: () => undefined,
  isFirebaseAdminConfigured: () => false,
  getAuth: () => ({
    verifyIdToken: async (token: string) => {
      if (token === 'firebase-token-sam') return { uid: 'web-sam', email: 'sam@example.com', name: 'Sam' };
      throw new Error('Invalid Firebase ID token');
    },
  }),
  getFirestore: () => {
    throw new Error('Firestore not configured in tests');
  },
}));

import request from 'supertest';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
import { AddressInfo } from 'net';
import { app, server, signaling } from '../src/index';
import { config } from '../src/config';
import { normalizeInviteCode } from '../src/routes/sessions';
import { signRelayToken } from '../src/services/relayToken';

const pluginToken = (uid: string, name: string) =>
  jwt.sign({ uid, name, email: `${uid}@example.com`, type: 'session' }, config.jwtSecret, { expiresIn: '1h' });

const alexToken = pluginToken('plugin-alex', 'Alex');
const samToken = 'firebase-token-sam'; // web dashboard user
const eveToken = pluginToken('plugin-eve', 'Eve'); // never joins

let wsUrl = '';

beforeAll((done) => {
  server.listen(0, () => {
    wsUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
    done();
  });
});

afterAll((done) => {
  signaling.close();
  server.close(() => done());
});

/** Opens a socket and collects messages; resolves helpers to await specific ones. */
function connect() {
  const ws = new WebSocket(wsUrl);
  const messages: any[] = [];
  const waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    messages.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) {
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
      }
    }
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const waitFor = (pred: (m: any) => boolean, timeoutMs = 3000) =>
    new Promise<any>((resolve, reject) => {
      const hit = messages.find(pred);
      if (hit) return resolve(hit);
      const t = setTimeout(() => reject(new Error('Timed out waiting for message')), timeoutMs);
      waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
  return { ws, opened, waitFor, send, closed, messages };
}

describe('Sessions REST API', () => {
  let sessionId = '';
  let inviteCode = '';

  test('rejects unauthenticated and refresh-token requests', async () => {
    await request(app).get('/sessions').expect(401);
    const refresh = jwt.sign({ uid: 'x', type: 'plugin_refresh' }, config.jwtSecret);
    await request(app).get('/sessions').set('Authorization', `Bearer ${refresh}`).expect(401);
  });

  test('plugin user creates a session with an invite code', async () => {
    const res = await request(app)
      .post('/sessions')
      .set('Authorization', `Bearer ${alexToken}`)
      .send({ name: 'Night Drive', bpm: 124, keySignature: 'F min' })
      .expect(201);

    expect(res.body.session.inviteCode).toMatch(/^DB-[2-9A-Z]{4}$/);
    expect(res.body.session.members).toEqual(['plugin-alex']);
    expect(res.body.session.memberNames['plugin-alex']).toBe('Alex');
    sessionId = res.body.session.id;
    inviteCode = res.body.session.inviteCode;
  });

  test('rejects an invalid bpm', async () => {
    await request(app).post('/sessions').set('Authorization', `Bearer ${alexToken}`).send({ bpm: 5 }).expect(400);
  });

  test('non-member cannot read the session', async () => {
    await request(app).get(`/sessions/${sessionId}`).set('Authorization', `Bearer ${samToken}`).expect(403);
  });

  test('web user joins by invite code (case/format-insensitive)', async () => {
    const sloppy = inviteCode.toLowerCase().replace('-', ' ');
    const res = await request(app)
      .post('/sessions/join')
      .set('Authorization', `Bearer ${samToken}`)
      .send({ inviteCode: sloppy })
      .expect(200);
    expect(res.body.session.members).toEqual(['plugin-alex', 'web-sam']);

    await request(app).get(`/sessions/${sessionId}`).set('Authorization', `Bearer ${samToken}`).expect(200);
  });

  test('joining twice does not duplicate the member', async () => {
    const res = await request(app)
      .post('/sessions/join')
      .set('Authorization', `Bearer ${samToken}`)
      .send({ inviteCode })
      .expect(200);
    expect(res.body.session.members).toEqual(['plugin-alex', 'web-sam']);
  });

  test('unknown invite code returns 404', async () => {
    await request(app).post('/sessions/join').set('Authorization', `Bearer ${samToken}`).send({ inviteCode: 'DB-ZZZZ' }).expect(404);
  });

  test('GET /sessions lists only my sessions', async () => {
    const res = await request(app).get('/sessions').set('Authorization', `Bearer ${eveToken}`).expect(200);
    expect(res.body.sessions).toEqual([]);
    const res2 = await request(app).get('/sessions').set('Authorization', `Bearer ${samToken}`).expect(200);
    expect(res2.body.sessions.map((s: any) => s.id)).toContain(sessionId);
  });

  test('normalizeInviteCode', () => {
    expect(normalizeInviteCode(' db-7k9a ')).toBe('DB-7K9A');
    expect(normalizeInviteCode('7k9a')).toBe('DB-7K9A');
    expect(normalizeInviteCode('DB 7K9A')).toBe('DB-7K9A');
  });

  describe('WebSocket signalling + presence', () => {
    test('rejects a bad token with close code 4401', async () => {
      const c = connect();
      await c.opened;
      c.send({ type: 'auth', token: 'garbage' });
      await c.waitFor((m) => m.type === 'auth_error');
      expect(await c.closed).toBe(4401);
    });

    test('must authenticate before joining', async () => {
      const c = connect();
      await c.opened;
      c.send({ type: 'join_session', sessionId });
      const err = await c.waitFor((m) => m.type === 'error');
      expect(err.code).toBe('unauthenticated');
      c.ws.close();
    });

    test('non-member is refused', async () => {
      const c = connect();
      await c.opened;
      c.send({ type: 'auth', token: eveToken, client: 'plugin', daw: 'Bitwig' });
      c.send({ type: 'join_session', sessionId });
      const err = await c.waitFor((m) => m.type === 'error');
      expect(err.code).toBe('not_a_member');
      expect(signaling.getPresence(sessionId)).toEqual([]);
      c.ws.close();
    });

    test('two members see each other online, and the leaver disappears', async () => {
      const alex = connect();
      const sam = connect();
      await Promise.all([alex.opened, sam.opened]);

      // auth + join sent back-to-back: server must process them in order
      alex.send({ type: 'auth', token: alexToken, client: 'plugin', daw: 'Ableton Live 12' });
      alex.send({ type: 'join_session', sessionId });
      const joined = await alex.waitFor((m) => m.type === 'session_joined');
      expect(joined.session.inviteCode).toBe(inviteCode);
      await alex.waitFor((m) => m.type === 'presence' && m.online.length === 1);

      sam.send({ type: 'auth', token: samToken });
      sam.send({ type: 'join_session', sessionId });

      const seenByAlex = await alex.waitFor((m) => m.type === 'presence' && m.online.length === 2);
      const names = seenByAlex.online.map((p: any) => `${p.userName}/${p.client}/${p.daw}`).sort();
      expect(names).toEqual(['Alex/plugin/Ableton Live 12', 'Sam/web/Web dashboard']);
      await sam.waitFor((m) => m.type === 'presence' && m.online.length === 2);

      // ping/pong echo used for RTT measurement
      sam.send({ type: 'ping', t: 42 });
      expect((await sam.waitFor((m) => m.type === 'pong')).t).toBe(42);

      // relay a signal to a specific peer
      alex.send({ type: 'signal', targetUserId: 'web-sam', signal: { hello: 1 } });
      const sig = await sam.waitFor((m) => m.type === 'signal');
      expect(sig).toMatchObject({ fromUserId: 'plugin-alex', signal: { hello: 1 } });

      // relay admission token is bound to this session + connection
      expect(joined.relay.port).toBe(config.relay.port);
      expect(joined.relay.token).toBe(
        signRelayToken(config.relay.secret, sessionId, joined.connectionId, joined.relay.expiresAt)
      );
      expect(joined.relay.token).toHaveLength(32);

      // tempo change is broadcast to everyone (sender included) and persisted
      alex.send({ type: 'tempo_sync', bpm: 98.5 });
      const t1 = await sam.waitFor((m) => m.type === 'session_tempo');
      const t2 = await alex.waitFor((m) => m.type === 'session_tempo');
      expect(t1).toMatchObject({ bpm: 98.5, byUserId: 'plugin-alex', byName: 'Alex' });
      expect(t2.bpm).toBe(98.5);
      const after = await request(app).get(`/sessions/${sessionId}`).set('Authorization', `Bearer ${samToken}`);
      expect(after.body.session.bpm).toBe(98.5);

      // invalid tempo is rejected
      sam.send({ type: 'tempo_sync', bpm: 5000 });
      expect((await sam.waitFor((m) => m.type === 'error' && m.code === 'bad_bpm')).code).toBe('bad_bpm');

      alex.messages.length = 0; // only consider presence updates after Sam leaves
      sam.ws.close();
      const left = await alex.waitFor((m) => m.type === 'presence' && m.online.length === 1 && m.online[0].userId === 'plugin-alex');
      expect(left.online[0].userName).toBe('Alex');

      alex.send({ type: 'leave_session' });
      await alex.waitFor((m) => m.type === 'session_left');
      expect(signaling.getPresence(sessionId)).toEqual([]);
      alex.ws.close();
    });

    test('event log: validated, acked, de-duplicated, broadcast, and readable over REST', async () => {
      const alex = connect();
      const sam = connect();
      await Promise.all([alex.opened, sam.opened]);
      alex.send({ type: 'auth', token: alexToken, client: 'plugin', daw: 'Ableton Live 12' });
      alex.send({ type: 'join_session', sessionId });
      await alex.waitFor((m) => m.type === 'session_joined');
      sam.send({ type: 'auth', token: samToken });
      sam.send({ type: 'join_session', sessionId });
      await sam.waitFor((m) => m.type === 'session_joined');

      // Alex sees Sam's server-generated join event
      const joinEvt = await alex.waitFor((m) => m.type === 'crdt_event' && m.event.type === 'session_join' && m.event.userId === 'web-sam');
      expect(joinEvt.event).toMatchObject({ source: 'server', payload: { client: 'web' } });

      // client event -> ack to sender, broadcast to others with server-stamped identity
      const evt = { type: 'crdt_event', id: 'note-000001', eventType: 'contribution_note', payload: { text: 'wrote the hook' }, clientTimestamp: 123 };
      alex.send(evt);
      expect(await alex.waitFor((m) => m.type === 'event_ack' && m.id === 'note-000001')).toMatchObject({ duplicate: false });
      const got = await sam.waitFor((m) => m.type === 'crdt_event' && m.event.id === 'note-000001');
      expect(got.event).toMatchObject({ userId: 'plugin-alex', userName: 'Alex', source: 'plugin', clientTimestamp: 123, payload: { text: 'wrote the hook' } });

      // retry of the same id is acked as duplicate and not re-broadcast
      sam.messages.length = 0;
      alex.send(evt);
      expect(await alex.waitFor((m) => m.type === 'event_ack' && m.duplicate === true)).toBeTruthy();

      // invalid events are rejected; clients can't forge server-only types or identity
      alex.send({ type: 'crdt_event', id: 'bad-0000001', eventType: 'audio_activity', payload: { activeSeconds: -5 } });
      expect((await alex.waitFor((m) => m.type === 'event_rejected' && m.id === 'bad-0000001')).error).toMatch(/Invalid payload/);
      alex.send({ type: 'crdt_event', id: 'forge-00001', eventType: 'session_join', payload: {}, userId: 'web-sam' });
      expect((await alex.waitFor((m) => m.type === 'event_rejected' && m.id === 'forge-00001')).error).toMatch(/server-only/);

      // tempo changes are logged as server events
      alex.send({ type: 'tempo_sync', bpm: 133 });
      await sam.waitFor((m) => m.type === 'crdt_event' && m.event.type === 'tempo_change');

      // REST: event history + contribution rollup
      const ev = await request(app).get(`/sessions/${sessionId}/events`).set('Authorization', `Bearer ${samToken}`).expect(200);
      const types = ev.body.events.map((e: any) => e.type);
      expect(types).toEqual(expect.arrayContaining(['session_join', 'contribution_note', 'tempo_change']));
      expect(ev.body.events.filter((e: any) => e.id === 'note-000001')).toHaveLength(1);
      const tempo = ev.body.events.find((e: any) => e.type === 'tempo_change' && e.payload.bpm === 133);
      expect(tempo.payload.previousBpm).toBe(98.5);

      const contrib = await request(app).get(`/sessions/${sessionId}/contributions`).set('Authorization', `Bearer ${samToken}`).expect(200);
      const alexC = contrib.body.contributions.find((c: any) => c.userId === 'plugin-alex');
      expect(alexC.notes).toEqual(['wrote the hook']);
      expect(alexC.tempoChanges).toBeGreaterThanOrEqual(1);

      await request(app).get(`/sessions/${sessionId}/events`).set('Authorization', `Bearer ${eveToken}`).expect(403);

      // last connection leaving logs session_leave
      sam.ws.close();
      await alex.waitFor((m) => m.type === 'crdt_event' && m.event.type === 'session_leave' && m.event.userId === 'web-sam');
      alex.ws.close();
    });

    test('shared MIDI clip: state on join, edits fan out, invalid edits resync, logged for credits', async () => {
      const alex = connect();
      const sam = connect();
      await Promise.all([alex.opened, sam.opened]);
      alex.send({ type: 'auth', token: alexToken, client: 'plugin', daw: 'REAPER' });
      alex.send({ type: 'join_session', sessionId });
      sam.send({ type: 'auth', token: samToken });
      sam.send({ type: 'join_session', sessionId });
      const initial = await alex.waitFor((m) => m.type === 'clip_state');
      expect(initial).toMatchObject({ steps: 64, stepsPerBeat: 4 });
      await sam.waitFor((m) => m.type === 'clip_state');

      // add -> broadcast to Sam with author stamped by the server
      alex.send({ type: 'clip_op', op: 'add', note: { id: 'n1-abcd', step: 0, length: 4, pitch: 60, velocity: 100, by: 'forged' } });
      const added = await sam.waitFor((m) => m.type === 'clip_op' && m.op === 'add');
      expect(added.note).toMatchObject({ id: 'n1-abcd', pitch: 60, by: 'plugin-alex', byName: 'Alex' });

      // update keeps original author even when Sam edits
      sam.send({ type: 'clip_op', op: 'update', note: { id: 'n1-abcd', step: 8, length: 2, pitch: 62, velocity: 90 } });
      const upd = await alex.waitFor((m) => m.type === 'clip_op' && m.op === 'update');
      expect(upd.note).toMatchObject({ step: 8, pitch: 62, by: 'plugin-alex', byName: 'Alex' });
      expect(upd.byName).toBe('Sam');

      // invalid: runs past the clip end -> sender gets a resync, nobody else hears about it
      alex.messages.length = 0;
      sam.messages.length = 0;
      alex.send({ type: 'clip_op', op: 'add', note: { id: 'n2-abcd', step: 62, length: 4, pitch: 60, velocity: 100 } });
      const resync = await alex.waitFor((m) => m.type === 'clip_state');
      expect(resync.reason).toMatch(/past the end/);
      expect(resync.notes).toHaveLength(1);

      // removing a note that another user already deleted -> resync, not an error
      sam.send({ type: 'clip_op', op: 'remove', id: 'n1-abcd' });
      await alex.waitFor((m) => m.type === 'clip_op' && m.op === 'remove' && m.id === 'n1-abcd');
      alex.send({ type: 'clip_op', op: 'remove', id: 'n1-abcd' });
      expect((await alex.waitFor((m) => m.type === 'clip_state' && /no longer exists/.test(m.reason))).notes).toHaveLength(0);

      // late joiner gets the current clip
      alex.send({ type: 'clip_op', op: 'add', note: { id: 'n3-abcd', step: 4, length: 1, pitch: 67, velocity: 110 } });
      await sam.waitFor((m) => m.type === 'clip_op' && m.note?.id === 'n3-abcd');
      const late = connect();
      await late.opened;
      late.send({ type: 'auth', token: samToken });
      late.send({ type: 'join_session', sessionId });
      const st = await late.waitFor((m) => m.type === 'clip_state');
      expect(st.notes.map((n: any) => n.id)).toEqual(['n3-abcd']);

      // edits are in the event log and in the contribution rollup
      const contrib = await request(app).get(`/sessions/${sessionId}/contributions`).set('Authorization', `Bearer ${samToken}`);
      expect(contrib.body.contributions.find((c: any) => c.userId === 'plugin-alex').clipNotesAdded).toBe(2);

      [alex, sam, late].forEach((c) => c.ws.close());
    });

    test('event rate limit', async () => {
      const c = connect();
      await c.opened;
      c.send({ type: 'auth', token: alexToken, client: 'plugin' });
      c.send({ type: 'join_session', sessionId });
      await c.waitFor((m) => m.type === 'session_joined');
      for (let i = 0; i < 100; i++) {
        c.send({ type: 'crdt_event', id: `flood-${String(i).padStart(6, '0')}`, eventType: 'send_mute', payload: { muted: i % 2 === 0 } });
      }
      const limited = await c.waitFor((m) => m.type === 'event_rejected' && m.error === 'Rate limited');
      expect(limited.retry).toBe(true);
      c.ws.close();
    });
  });
});
