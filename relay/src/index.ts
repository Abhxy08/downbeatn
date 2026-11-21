import dotenv from 'dotenv';
import path from 'path';
import { UdpRelay } from './relay';

// relay/.env (if any), then the monorepo root .env
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const PORT = parseInt(process.env.RELAY_PORT || '48000', 10);
const BIND_HOST = process.env.RELAY_BIND_HOST || '0.0.0.0';
const SECRET = process.env.RELAY_SECRET || 'downbeat-relay-shared-secret';

if (SECRET === 'downbeat-relay-shared-secret' && process.env.NODE_ENV === 'production') {
  console.error('[Relay] Refusing to start in production with the default RELAY_SECRET');
  process.exit(1);
}

const relay = new UdpRelay({ secret: SECRET, log: console.log });

relay.listen(PORT, BIND_HOST).then((port) => {
  console.log(`[Relay] DownBeat UDP audio relay listening on ${BIND_HOST}:${port}`);
});

setInterval(() => {
  const s = relay.stats;
  if (s.packetsIn > 0) {
    console.log(`[Relay] in=${s.packetsIn} forwarded=${s.packetsForwarded} (${(s.bytesForwarded / 1e6).toFixed(1)} MB) rejected=${s.rejected}`);
  }
}, 30_000).unref();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => relay.close().then(() => process.exit(0)));
}
