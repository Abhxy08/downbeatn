import crypto from 'crypto';

/**
 * DownBeat UDP wire format (shared by plugin P2P traffic and the relay).
 * Mirror of plugin/Source/AudioPacket.h — keep them in sync.
 *
 *  offset size field
 *  0      4    magic "DWBT" (0x44574254, big-endian)
 *  4      1    version (1)
 *  5      1    type (PacketType)
 *  6      2    reserved
 *  8      16   sessionId (UUID bytes)
 *  24     16   senderId (WebSocket connectionId UUID bytes)
 *  40     ...  payload
 */
export const MAGIC = 0x44574254;
export const VERSION = 1;
export const HEADER_SIZE = 40;

export enum PacketType {
  Hello = 1, // to relay: u64 expiresAt (BE) + 16-byte token
  HelloAck = 2, // from relay: u8 status
  Audio = 3, // u32 seq, u16 frames, u8 channels, u8 bits, u32 sampleRate, PCM
  Ping = 4, // u64 sender clock (µs)
  Pong = 5, // echoes the ping payload
  Bye = 6,
  Probe = 7, // P2P hole punching (never relayed)
  ProbeAck = 8,
  Keepalive = 9, // to relay: keeps the NAT mapping + registration alive
}

export enum HelloStatus {
  Ok = 0,
  BadToken = 1,
  Expired = 2,
}

export interface Header {
  type: PacketType;
  sessionId: string; // canonical lowercase UUID string
  senderId: string;
}

export function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`Not a UUID: ${uuid}`);
  return Buffer.from(hex, 'hex');
}

export function bytesToUuid(buf: Buffer): string {
  const h = buf.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function parseHeader(msg: Buffer): Header | null {
  if (msg.length < HEADER_SIZE) return null;
  if (msg.readUInt32BE(0) !== MAGIC || msg.readUInt8(4) !== VERSION) return null;
  return {
    type: msg.readUInt8(5) as PacketType,
    sessionId: bytesToUuid(msg.subarray(8, 24)),
    senderId: bytesToUuid(msg.subarray(24, 40)),
  };
}

export function buildPacket(type: PacketType, sessionId: string, senderId: string, payload: Buffer = Buffer.alloc(0)): Buffer {
  const buf = Buffer.alloc(HEADER_SIZE + payload.length);
  buf.writeUInt32BE(MAGIC, 0);
  buf.writeUInt8(VERSION, 4);
  buf.writeUInt8(type, 5);
  uuidToBytes(sessionId).copy(buf, 8);
  uuidToBytes(senderId).copy(buf, 24);
  payload.copy(buf, HEADER_SIZE);
  return buf;
}

/** Same algorithm as server/src/services/relayToken.ts */
export function signRelayToken(secret: string, sessionId: string, connectionId: string, expiresAt: number): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${sessionId.toLowerCase()}:${connectionId.toLowerCase()}:${expiresAt}`)
    .digest('hex')
    .slice(0, 32);
}

export function helloPayload(expiresAt: number, tokenHex: string): Buffer {
  const p = Buffer.alloc(24);
  p.writeBigUInt64BE(BigInt(expiresAt), 0);
  Buffer.from(tokenHex, 'hex').copy(p, 8);
  return p;
}
