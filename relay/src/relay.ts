import dgram from 'dgram';
import crypto from 'crypto';
import {
  HEADER_SIZE,
  HelloStatus,
  PacketType,
  buildPacket,
  parseHeader,
  signRelayToken,
} from './protocol';

interface Peer {
  address: string;
  port: number;
  lastSeen: number;
  expiresAt: number;
  // simple token bucket for rate limiting
  tokens: number;
  lastRefill: number;
}

export interface RelayOptions {
  secret: string;
  /** Peers silent for longer than this are dropped */
  peerTimeoutMs?: number;
  /** Max packets/second accepted per sender (audio is ~375/s) */
  maxPacketsPerSecond?: number;
  log?: (msg: string) => void;
}

/** Packet types forwarded to the other members of the session. */
const FORWARDED = new Set([PacketType.Audio, PacketType.Ping, PacketType.Pong]);

/**
 * Stateless-ish UDP relay. A sender must first register with a HELLO carrying a
 * server-signed token; afterwards only packets from that exact address:port are
 * forwarded, so other hosts can't inject audio into a session.
 */
export class UdpRelay {
  private socket: dgram.Socket;
  private sessions = new Map<string, Map<string, Peer>>();
  private sweepTimer?: NodeJS.Timeout;
  private readonly peerTimeoutMs: number;
  private readonly maxPps: number;
  private readonly log: (msg: string) => void;
  readonly stats = { packetsIn: 0, packetsForwarded: 0, bytesForwarded: 0, rejected: 0 };

  constructor(private opts: RelayOptions) {
    this.peerTimeoutMs = opts.peerTimeoutMs ?? 30_000;
    this.maxPps = opts.maxPacketsPerSecond ?? 1500;
    this.log = opts.log ?? (() => undefined);
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (msg, rinfo) => this.onPacket(msg, rinfo));
    this.socket.on('error', (err) => this.log(`[Relay] socket error: ${err.message}`));
  }

  listen(port: number, host = '0.0.0.0'): Promise<number> {
    return new Promise((resolve) => {
      this.socket.bind(port, host, () => {
        this.sweepTimer = setInterval(() => this.sweep(), 5_000);
        this.sweepTimer.unref();
        resolve(this.socket.address().port);
      });
    });
  }

  close(): Promise<void> {
    clearInterval(this.sweepTimer);
    return new Promise((resolve) => this.socket.close(() => resolve()));
  }

  peerCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.size ?? 0;
  }

  private onPacket(msg: Buffer, rinfo: dgram.RemoteInfo) {
    this.stats.packetsIn++;
    const header = parseHeader(msg);
    if (!header) return;

    if (header.type === PacketType.Hello) return this.onHello(msg, header.sessionId, header.senderId, rinfo);

    const peers = this.sessions.get(header.sessionId);
    const peer = peers?.get(header.senderId);

    // Only registered senders, from the address they registered from.
    if (!peers || !peer || peer.address !== rinfo.address || peer.port !== rinfo.port) {
      this.stats.rejected++;
      return;
    }

    const now = Date.now();
    peer.lastSeen = now;

    if (header.type === PacketType.Bye) {
      peers.delete(header.senderId);
      if (peers.size === 0) this.sessions.delete(header.sessionId);
      return;
    }
    if (header.type === PacketType.Keepalive) return;
    if (!FORWARDED.has(header.type)) return;

    // rate limit
    peer.tokens = Math.min(this.maxPps, peer.tokens + ((now - peer.lastRefill) / 1000) * this.maxPps);
    peer.lastRefill = now;
    if (peer.tokens < 1) {
      this.stats.rejected++;
      return;
    }
    peer.tokens -= 1;

    for (const [id, other] of peers) {
      if (id === header.senderId) continue;
      this.socket.send(msg, other.port, other.address);
      this.stats.packetsForwarded++;
      this.stats.bytesForwarded += msg.length;
    }
  }

  private onHello(msg: Buffer, sessionId: string, senderId: string, rinfo: dgram.RemoteInfo) {
    const reply = (status: HelloStatus) =>
      this.socket.send(buildPacket(PacketType.HelloAck, sessionId, senderId, Buffer.from([status])), rinfo.port, rinfo.address);

    if (msg.length < HEADER_SIZE + 24) return;
    const expiresAt = Number(msg.readBigUInt64BE(HEADER_SIZE));
    const token = msg.subarray(HEADER_SIZE + 8, HEADER_SIZE + 24);
    const expected = Buffer.from(signRelayToken(this.opts.secret, sessionId, senderId, expiresAt), 'hex');

    if (!crypto.timingSafeEqual(token, expected)) {
      this.stats.rejected++;
      return reply(HelloStatus.BadToken);
    }
    if (Date.now() > expiresAt) return reply(HelloStatus.Expired);

    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, new Map());
    const now = Date.now();
    this.sessions.get(sessionId)!.set(senderId, {
      address: rinfo.address,
      port: rinfo.port,
      lastSeen: now,
      expiresAt,
      tokens: this.maxPps,
      lastRefill: now,
    });
    reply(HelloStatus.Ok);
  }

  private sweep() {
    const now = Date.now();
    for (const [sessionId, peers] of this.sessions) {
      for (const [id, p] of peers) {
        if (now - p.lastSeen > this.peerTimeoutMs || now > p.expiresAt) peers.delete(id);
      }
      if (peers.size === 0) this.sessions.delete(sessionId);
    }
  }
}
