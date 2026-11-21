import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import crypto from 'crypto';
import { crdtManager, SessionEvent, EventType, validateClientEvent } from '../services/crdt';
import { verifyAnyToken, VerifiedUser } from '../services/verifyToken';
import { loadSession, isMember } from '../routes/sessions';
import { getFirestore } from '../services/firebase';
import { config } from '../config';
import { signRelayToken, RELAY_TOKEN_TTL_MS } from '../services/relayToken';
import { setEventPublisher } from '../services/sessionBus';
import { deviceStore } from '../services/devices';
import { BeatJamManager, BeatJamState, MusicConnector, lyriaConnector } from '../services/beatJam';
import { AgentError } from '../services/gemini';
import { applyClipOp, getClip } from '../services/sharedClip';

/** First byte of binary frames sent to plugins. */
export const BINARY_BEATJAM_PCM = 0x01;

/** How long a socket may stay open without authenticating. */
const AUTH_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 30_000;

export type ClientKind = 'plugin' | 'web';

export interface PresenceEntry {
  connectionId: string;
  userId: string;
  userName: string;
  client: ClientKind;
  daw: string;
  joinedAt: number;
}

interface ClientSocket extends WebSocket {
  connectionId: string;
  user?: VerifiedUser;
  client: ClientKind;
  daw: string;
  sessionId?: string;
  joinedAt: number;
  isAlive: boolean;
  /** Messages are processed strictly in order, even though auth is async. */
  queue: Promise<void>;
  /** token bucket for crdt_event rate limiting */
  eventTokens: number;
  eventRefillAt: number;
}

const EVENT_RATE_PER_SEC = 20;
const EVENT_BURST = 60;

/**
 * Close codes (4000–4999 are application-defined):
 *  4401 not authenticated / bad token, 4403 not a member.
 */
export class SignalingServer {
  private wss: WebSocketServer;
  private rooms: Map<string, Set<ClientSocket>> = new Map();
  private heartbeat: NodeJS.Timeout;

  readonly beatJam: BeatJamManager;

  constructor(server: http.Server, musicConnector: MusicConnector = lyriaConnector) {
    this.wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1 << 20 });
    this.wss.on('connection', (ws, req) => this.onConnection(ws as ClientSocket, req));
    this.heartbeat = setInterval(() => this.sweep(), HEARTBEAT_MS);
    this.heartbeat.unref();

    // A revoked plugin is disconnected immediately (its tokens are already rejected).
    deviceStore.onRevoked((uid, deviceId) => {
      for (const raw of this.wss.clients) {
        const c = raw as ClientSocket;
        if (c.user?.uid === uid && c.user.deviceId === deviceId) c.close(4401, 'Device revoked');
      }
    });

    // HTTP routes (Mix Doctor, Credits) log events through this, so they're broadcast live too
    setEventPublisher((sessionId, event) => {
      if (crdtManager.appendEvent(sessionId, event)) this.broadcast(sessionId, { type: 'crdt_event', event });
    });

    this.beatJam = new BeatJamManager(musicConnector, {
      sendAudio: (sessionId, pcm) => this.sendBeatJamAudio(sessionId, pcm),
      sendState: (sessionId, state) => this.broadcast(sessionId, { type: 'beatjam_state', state }),
      logEvent: (sessionId, actor, payload) => {
        const event: SessionEvent = {
          id: `srv_${crypto.randomUUID()}`, type: 'beat_jam', userId: actor.uid, userName: actor.name,
          timestamp: Date.now(), source: 'server', payload,
        };
        if (crdtManager.appendEvent(sessionId, event)) this.broadcast(sessionId, { type: 'crdt_event', event });
      },
      hasListeners: (sessionId) => Array.from(this.rooms.get(sessionId) ?? []).some((c) => c.client === 'plugin'),
    });
  }

  /** Binary frame [0x01][int16 LE stereo 48 kHz PCM] to every plugin in the room (skips congested sockets). */
  private sendBeatJamAudio(sessionId: string, pcm: Buffer) {
    const room = this.rooms.get(sessionId);
    if (!room) return;
    const frame = Buffer.concat([Buffer.from([BINARY_BEATJAM_PCM]), pcm]);
    for (const c of room) {
      if (c.client === 'plugin' && c.readyState === WebSocket.OPEN && c.bufferedAmount < 2 * 1024 * 1024) {
        c.send(frame, { binary: true });
      }
    }
  }

  close() {
    setEventPublisher(null);
    this.beatJam.stopAll();
    clearInterval(this.heartbeat);
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
  }

  /** Current presence for a session (used by tests and REST). */
  getPresence(sessionId: string): PresenceEntry[] {
    const room = this.rooms.get(sessionId);
    if (!room) return [];
    return Array.from(room)
      .filter((c) => c.user)
      .map((c) => ({
        connectionId: c.connectionId,
        userId: c.user!.uid,
        userName: c.user!.name,
        client: c.client,
        daw: c.daw,
        joinedAt: c.joinedAt,
      }));
  }

  private onConnection(ws: ClientSocket, req: http.IncomingMessage) {
    ws.connectionId = crypto.randomUUID();
    ws.isAlive = true;
    ws.client = 'web';
    ws.daw = '';
    ws.joinedAt = 0;
    ws.queue = Promise.resolve();
    ws.eventTokens = EVENT_BURST;
    ws.eventRefillAt = Date.now();

    const authTimer = setTimeout(() => {
      if (!ws.user) ws.close(4401, 'Authentication timeout');
    }, AUTH_TIMEOUT_MS);

    // Token may also be given in the query string (?token=...), but the
    // preferred way is an {type:"auth"} message so tokens don't land in logs.
    const url = new URL(req.url || '', 'http://localhost');
    const queryToken = url.searchParams.get('token');
    if (queryToken) {
      ws.queue = ws.queue.then(() => this.authenticate(ws, { token: queryToken, client: url.searchParams.get('client'), daw: url.searchParams.get('daw') }).then(() => undefined));
    }

    ws.on('pong', () => (ws.isAlive = true));

    ws.on('message', (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return this.send(ws, { type: 'error', code: 'bad_json', message: 'Message is not valid JSON' });
      }
      ws.queue = ws.queue
        .then(() => this.handleMessage(ws, msg))
        .catch((err) => console.error('[Signaling] handler error:', err));
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      this.leaveRoom(ws);
    });

    ws.on('error', (err) => console.error('[Signaling] socket error:', err.message));
  }

  private async authenticate(ws: ClientSocket, msg: any): Promise<boolean> {
    try {
      ws.user = await verifyAnyToken(msg.token);
      ws.client = msg.client === 'plugin' || (!msg.client && ws.user.source === 'plugin') ? 'plugin' : 'web';
      ws.daw = String(msg.daw || (ws.client === 'web' ? 'Web dashboard' : 'Unknown DAW')).slice(0, 64);
      this.send(ws, { type: 'auth_ok', userId: ws.user.uid, userName: ws.user.name });
      return true;
    } catch {
      this.send(ws, { type: 'auth_error', error: 'Invalid or expired token' });
      ws.close(4401, 'Invalid token');
      return false;
    }
  }

  private async handleMessage(ws: ClientSocket, msg: any) {
    if (ws.readyState !== WebSocket.OPEN) return;

    if (msg.type === 'auth') {
      await this.authenticate(ws, msg);
      return;
    }

    if (msg.type === 'ping') {
      return this.send(ws, { type: 'pong', t: msg.t, serverTime: Date.now() });
    }

    if (!ws.user) {
      return this.send(ws, { type: 'error', code: 'unauthenticated', message: 'Send {type:"auth"} first' });
    }

    switch (msg.type) {
      case 'join_session':
        return this.joinRoom(ws, String(msg.sessionId || ''), msg.daw);

      case 'leave_session':
        this.leaveRoom(ws);
        return this.send(ws, { type: 'session_left' });

      case 'signal': {
        // Forward NAT traversal / connection-setup info to one peer (used in Phase 4)
        const room = ws.sessionId ? this.rooms.get(ws.sessionId) : undefined;
        if (!room) return;
        for (const peer of room) {
          if (peer !== ws && (peer.connectionId === msg.targetConnectionId || peer.user?.uid === msg.targetUserId)) {
            this.send(peer, { type: 'signal', fromUserId: ws.user.uid, fromConnectionId: ws.connectionId, signal: msg.signal });
            break;
          }
        }
        return;
      }

      case 'crdt_event': {
        if (!ws.sessionId) {
          return this.send(ws, { type: 'event_rejected', id: msg.id, error: 'Join a session first' });
        }
        // rate limit (token bucket)
        const now = Date.now();
        ws.eventTokens = Math.min(EVENT_BURST, ws.eventTokens + ((now - ws.eventRefillAt) / 1000) * EVENT_RATE_PER_SEC);
        ws.eventRefillAt = now;
        if (ws.eventTokens < 1) {
          return this.send(ws, { type: 'event_rejected', id: msg.id, error: 'Rate limited', retry: true });
        }
        ws.eventTokens -= 1;

        const v = validateClientEvent(msg);
        if (!v.ok) return this.send(ws, { type: 'event_rejected', id: msg.id, error: v.error });

        await crdtManager.ensureLoaded(ws.sessionId);
        const clientTs = Number(msg.clientTimestamp);
        const event: SessionEvent = {
          id: v.id,
          type: v.type,
          userId: ws.user.uid,
          userName: ws.user.name,
          timestamp: now,
          ...(Number.isFinite(clientTs) && clientTs > 0 ? { clientTimestamp: clientTs } : {}),
          source: ws.client,
          payload: v.payload,
        };
        const added = crdtManager.appendEvent(ws.sessionId, event);
        this.send(ws, { type: 'event_ack', id: v.id, duplicate: !added });
        if (added) this.broadcast(ws.sessionId, { type: 'crdt_event', event }, ws);
        return;
      }

      case 'tempo_sync': {
        // A member changed the session tempo (via Ableton Link or "use my DAW tempo").
        if (!ws.sessionId) return;
        const bpm = Math.round(Number(msg.bpm) * 100) / 100;
        if (!Number.isFinite(bpm) || bpm < 20 || bpm > 999) {
          return this.send(ws, { type: 'error', code: 'bad_bpm', message: 'bpm must be between 20 and 999' });
        }
        const session = await loadSession(ws.sessionId);
        if (!session) return;
        if (Math.abs(session.bpm - bpm) < 0.005) return; // no change -> no echo storms
        const previousBpm = session.bpm;
        session.bpm = bpm;
        session.updatedAt = Date.now();
        try {
          await getFirestore().collection('sessions').doc(session.id).update({ bpm, updatedAt: session.updatedAt });
        } catch {
          /* ignore in dev */
        }
        this.logServerEvent(ws.sessionId, ws, 'tempo_change', { bpm, previousBpm });
        this.beatJam.setTempo(ws.sessionId, bpm).catch(() => undefined);

        // Everyone (including the sender) adopts the new tempo
        return this.broadcast(ws.sessionId, {
          type: 'session_tempo',
          bpm,
          byUserId: ws.user.uid,
          byName: ws.user.name,
        });
      }

      case 'clip_op': {
        // Shared MIDI clip edit: validate, apply to the session CRDT, fan out to everyone else.
        if (!ws.sessionId) return;
        const now = Date.now();
        ws.eventTokens = Math.min(EVENT_BURST, ws.eventTokens + ((now - ws.eventRefillAt) / 1000) * EVENT_RATE_PER_SEC);
        ws.eventRefillAt = now;
        if (ws.eventTokens < 1) return this.send(ws, { type: 'clip_state', ...getClip(ws.sessionId), reason: 'rate_limited' });
        ws.eventTokens -= 1;

        await crdtManager.ensureLoaded(ws.sessionId);
        const result = applyClipOp(ws.sessionId, msg, { uid: ws.user.uid, name: ws.user.name });
        if (!result.ok) {
          // The sender's optimistic view is wrong (e.g. someone deleted that note): resync it.
          return this.send(ws, { type: 'clip_state', ...getClip(ws.sessionId), reason: result.error });
        }
        const out: Record<string, unknown> = { type: 'clip_op', op: result.op.op, byUserId: ws.user.uid, byName: ws.user.name };
        if (result.note) out.note = result.note;
        if (result.op.op === 'remove') out.id = result.op.id;
        this.broadcast(ws.sessionId, out, ws);

        if (result.op.op !== 'update') {
          const n = result.note ?? result.removed;
          this.logServerEvent(ws.sessionId, ws, 'clip_edit', {
            action: result.op.op,
            ...(n ? { pitch: n.pitch, step: n.step, length: n.length } : {}),
            ...(result.cleared !== undefined ? { cleared: result.cleared } : {}),
          });
        }
        return;
      }

      case 'clip_sync': {
        if (!ws.sessionId) return;
        await crdtManager.ensureLoaded(ws.sessionId);
        return this.send(ws, { type: 'clip_state', ...getClip(ws.sessionId) });
      }

      case 'beatjam_start':
      case 'beatjam_steer': {
        if (!ws.sessionId) return this.send(ws, { type: 'error', code: 'not_in_session', message: 'Join a session first' });
        const prompt = typeof msg.prompt === 'string' ? msg.prompt.trim().slice(0, 200) : '';
        if (!prompt) return this.send(ws, { type: 'error', code: 'bad_prompt', message: 'Describe what Beat Jam should play' });
        const session = await loadSession(ws.sessionId);
        if (!session) return;
        try {
          if (msg.type === 'beatjam_start') {
            await this.beatJam.start(ws.sessionId, { uid: ws.user.uid, name: ws.user.name }, prompt, session.bpm, session.keySignature);
            this.beatJam.listenersChanged(ws.sessionId);
          } else {
            await this.beatJam.steer(ws.sessionId, { uid: ws.user.uid, name: ws.user.name }, prompt);
          }
        } catch (e: any) {
          this.send(ws, { type: 'error', code: 'beatjam', message: e instanceof AgentError ? e.message : 'Beat Jam failed' });
        }
        return;
      }

      case 'beatjam_stop': {
        if (!ws.sessionId) return;
        this.beatJam.stop(ws.sessionId, { uid: ws.user.uid, name: ws.user.name });
        return;
      }

      default:
        return this.send(ws, { type: 'error', code: 'unknown_type', message: `Unknown message type: ${msg.type}` });
    }
  }

  private async joinRoom(ws: ClientSocket, sessionId: string, daw?: string) {
    const session = sessionId ? await loadSession(sessionId) : undefined;
    if (!session) {
      return this.send(ws, { type: 'error', code: 'session_not_found', message: 'Session not found' });
    }
    if (!isMember(session, ws.user!.uid)) {
      return this.send(ws, { type: 'error', code: 'not_a_member', message: 'Join the session with its invite code first' });
    }

    if (ws.sessionId && ws.sessionId !== sessionId) this.leaveRoom(ws);
    if (daw) ws.daw = String(daw).slice(0, 64);

    await crdtManager.ensureLoaded(sessionId);
    const alreadyPresent = this.userConnections(sessionId, ws.user!.uid) > 0;

    ws.sessionId = sessionId;
    ws.joinedAt = Date.now();
    if (!this.rooms.has(sessionId)) this.rooms.set(sessionId, new Set());
    this.rooms.get(sessionId)!.add(ws);

    // Only the user's first connection counts as "joined" (reconnects / extra tabs don't)
    if (!alreadyPresent) this.logServerEvent(sessionId, ws, 'session_join', { client: ws.client, daw: ws.daw });
    this.beatJam.listenersChanged(sessionId);

    const relayExpiresAt = Date.now() + RELAY_TOKEN_TTL_MS;
    queueMicrotask(() => {
      this.send(ws, { type: 'beatjam_state', state: this.beatJam.getState(sessionId) });
      this.send(ws, { type: 'clip_state', ...getClip(sessionId) });
    });
    this.send(ws, {
      type: 'session_joined',
      connectionId: ws.connectionId,
      // UDP relay fallback for audio (used when a direct P2P path can't be opened)
      relay: {
        host: config.relay.publicIp,
        port: config.relay.port,
        expiresAt: relayExpiresAt,
        token: signRelayToken(config.relay.secret, session.id, ws.connectionId, relayExpiresAt),
      },
      stunServer: config.audio.stunServer,
      session: {
        id: session.id,
        name: session.name,
        inviteCode: session.inviteCode,
        bpm: session.bpm,
        keySignature: session.keySignature,
        members: session.members,
        memberNames: session.memberNames,
      },
    });
    this.broadcastPresence(sessionId);
  }

  private leaveRoom(ws: ClientSocket) {
    const sessionId = ws.sessionId;
    if (!sessionId) return;
    ws.sessionId = undefined;
    const room = this.rooms.get(sessionId);
    if (!room) return;
    room.delete(ws);
    if (ws.user && this.userConnections(sessionId, ws.user.uid) === 0) {
      this.logServerEvent(sessionId, ws, 'session_leave', { client: ws.client });
    }
    if (room.size === 0) this.rooms.delete(sessionId);
    else this.broadcastPresence(sessionId);
    this.beatJam.listenersChanged(sessionId);
  }

  private userConnections(sessionId: string, uid: string): number {
    let n = 0;
    for (const c of this.rooms.get(sessionId) ?? []) if (c.user?.uid === uid) n++;
    return n;
  }

  /** Records an event the server observed (join / leave / tempo) and broadcasts it. */
  private logServerEvent(sessionId: string, ws: ClientSocket, type: EventType, payload: Record<string, unknown>) {
    if (!ws.user) return;
    const event: SessionEvent = {
      id: `srv_${crypto.randomUUID()}`,
      type,
      userId: ws.user.uid,
      userName: ws.user.name,
      timestamp: Date.now(),
      source: 'server',
      payload,
    };
    if (crdtManager.appendEvent(sessionId, event)) this.broadcast(sessionId, { type: 'crdt_event', event });
  }

  private broadcastPresence(sessionId: string) {
    this.broadcast(sessionId, { type: 'presence', sessionId, online: this.getPresence(sessionId) });
  }

  private broadcast(sessionId: string, message: unknown, exclude?: ClientSocket) {
    const room = this.rooms.get(sessionId);
    if (!room) return;
    const data = JSON.stringify(message);
    for (const client of room) {
      if (client !== exclude && client.readyState === WebSocket.OPEN) client.send(data);
    }
  }

  private send(ws: ClientSocket, message: unknown) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  private sweep() {
    for (const raw of this.wss.clients) {
      const ws = raw as ClientSocket;
      if (!ws.isAlive) {
        ws.terminate(); // 'close' handler removes it from its room
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }
}
