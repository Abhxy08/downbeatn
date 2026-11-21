import dgram from 'dgram';
import crypto from 'crypto';
import { UdpRelay } from '../src/relay';
import { PacketType, HelloStatus, buildPacket, helloPayload, parseHeader, signRelayToken, HEADER_SIZE, bytesToUuid, uuidToBytes } from '../src/protocol';

const SECRET = 'test-secret';
const SESSION = crypto.randomUUID();
let relay: UdpRelay;
let port = 0;

beforeAll(async () => {
  relay = new UdpRelay({ secret: SECRET });
  port = await relay.listen(0, '127.0.0.1');
});
afterAll(() => relay.close());

function client() {
  const sock = dgram.createSocket('udp4');
  const id = crypto.randomUUID();
  const inbox: Buffer[] = [];
  const waiters: Array<(b: Buffer) => void> = [];
  sock.on('message', (m) => {
    const w = waiters.shift();
    if (w) w(m);
    else inbox.push(m);
  });
  const next = (ms = 1000) =>
    new Promise<Buffer | null>((resolve) => {
      const queued = inbox.shift();
      if (queued) return resolve(queued);
      const t = setTimeout(() => {
        const i = waiters.indexOf(fn);
        if (i >= 0) waiters.splice(i, 1);
        resolve(null);
      }, ms);
      const fn = (b: Buffer) => {
        clearTimeout(t);
        resolve(b);
      };
      waiters.push(fn);
    });
  const send = (b: Buffer) => sock.send(b, port, '127.0.0.1');
  const hello = (opts: { token?: string; expiresAt?: number } = {}) => {
    const expiresAt = opts.expiresAt ?? Date.now() + 60_000;
    const token = opts.token ?? signRelayToken(SECRET, SESSION, id, expiresAt);
    send(buildPacket(PacketType.Hello, SESSION, id, helloPayload(expiresAt, token)));
  };
  const ready = new Promise<void>((r) => sock.bind(0, '127.0.0.1', () => r()));
  return { sock, id, next, send, hello, ready, close: () => sock.close() };
}

test('uuid <-> bytes roundtrip', () => {
  const u = crypto.randomUUID();
  expect(bytesToUuid(uuidToBytes(u))).toBe(u);
});

test('rejects HELLO with a forged token', async () => {
  const c = client();
  await c.ready;
  c.hello({ token: '00'.repeat(16) });
  const ack = await c.next();
  expect(ack![HEADER_SIZE]).toBe(HelloStatus.BadToken);
  c.close();
});

test('rejects HELLO with an expired token', async () => {
  const c = client();
  await c.ready;
  c.hello({ expiresAt: Date.now() - 1000 });
  expect((await c.next())![HEADER_SIZE]).toBe(HelloStatus.Expired);
  c.close();
});

test('forwards audio between registered peers, and blocks unregistered senders', async () => {
  const a = client();
  const b = client();
  const intruder = client();
  await Promise.all([a.ready, b.ready, intruder.ready]);

  a.hello();
  b.hello();
  expect((await a.next())![HEADER_SIZE]).toBe(HelloStatus.Ok);
  expect((await b.next())![HEADER_SIZE]).toBe(HelloStatus.Ok);
  expect(relay.peerCount(SESSION)).toBe(2);

  const audio = buildPacket(PacketType.Audio, SESSION, a.id, Buffer.from([1, 2, 3, 4]));
  a.send(audio);
  const got = await b.next();
  expect(got).not.toBeNull();
  expect(parseHeader(got!)).toMatchObject({ type: PacketType.Audio, senderId: a.id });
  expect(got!.subarray(HEADER_SIZE)).toEqual(Buffer.from([1, 2, 3, 4]));
  expect(await a.next(150)).toBeNull(); // not echoed to the sender

  // Intruder spoofs a's senderId from a different port -> dropped
  intruder.send(buildPacket(PacketType.Audio, SESSION, a.id, Buffer.from([9])));
  expect(await b.next(200)).toBeNull();

  // Probes are P2P-only and never relayed
  a.send(buildPacket(PacketType.Probe, SESSION, a.id));
  expect(await b.next(150)).toBeNull();

  // BYE unregisters
  a.send(buildPacket(PacketType.Bye, SESSION, a.id));
  await new Promise((r) => setTimeout(r, 50));
  expect(relay.peerCount(SESSION)).toBe(1);

  [a, b, intruder].forEach((c) => c.close());
});

test('rate limits a flooding sender', async () => {
  const limited = new UdpRelay({ secret: SECRET, maxPacketsPerSecond: 10 });
  const lport = await limited.listen(0, '127.0.0.1');
  const sock = dgram.createSocket('udp4');
  const peerSock = dgram.createSocket('udp4');
  await Promise.all([new Promise<void>((r) => sock.bind(0, '127.0.0.1', () => r())), new Promise<void>((r) => peerSock.bind(0, '127.0.0.1', () => r()))]);
  const ida = crypto.randomUUID();
  const idb = crypto.randomUUID();
  const exp = Date.now() + 60_000;
  let received = 0;
  peerSock.on('message', (m) => parseHeader(m)?.type === PacketType.Audio && received++);

  sock.send(buildPacket(PacketType.Hello, SESSION, ida, helloPayload(exp, signRelayToken(SECRET, SESSION, ida, exp))), lport, '127.0.0.1');
  peerSock.send(buildPacket(PacketType.Hello, SESSION, idb, helloPayload(exp, signRelayToken(SECRET, SESSION, idb, exp))), lport, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 100));

  for (let i = 0; i < 100; i++) sock.send(buildPacket(PacketType.Audio, SESSION, ida, Buffer.from([i])), lport, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 300));

  expect(received).toBeGreaterThan(5);
  expect(received).toBeLessThan(20);
  sock.close();
  peerSock.close();
  await limited.close();
});
