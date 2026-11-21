import express from 'express';
import http from 'http';
import cors from 'cors';
import { config } from './config';
import { authRouter } from './routes/auth';
import { sessionsRouter } from './routes/sessions';
import { agentsRouter } from './routes/agents';
import { SignalingServer } from './websocket/signaling';
import { crdtManager } from './services/crdt';

const app = express();
const server = http.createServer(app);

// Enable Cross-Origin Resource Sharing
// Browsers may only call the API from our own web app origins (the plugin isn't a browser).
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || config.corsOrigin.includes(origin)),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Body parser
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Health Check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'downbeat-backend',
    env: config.env,
  });
});

// Mount API routes
app.use('/auth', authRouter);
app.use('/sessions', sessionsRouter);
app.use('/agents', agentsRouter);

// Initialize WebSocket Signaling Server
const signaling = new SignalingServer(server);

// Start HTTP + WS listener
if (process.env.NODE_ENV !== 'test') {
  server.listen(config.port, '0.0.0.0', () => {
    console.log(`=========================================`);
    console.log(`🎵 DownBeat Cloud Run Service Started 🎵`);
    console.log(`HTTP Server: http://localhost:${config.port}`);
    console.log(`WebSocket:   ws://localhost:${config.port}/ws`);
    console.log(`Environment: ${config.env}`);
    console.log(`=========================================`);
  });
}

// Cloud Run sends SIGTERM before stopping an instance: persist pending event-log snapshots.
if (process.env.NODE_ENV !== 'test') {
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, async () => {
      signaling.beatJam.stopAll();
      await crdtManager.flush().catch(() => undefined);
      process.exit(0);
    });
  }
}

export { app, server, signaling };
