import dotenv from 'dotenv';
import path from 'path';

// Load server/.env (if any), then the monorepo root .env. Existing vars are never overridden.
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '8088', 10),
  jwtSecret: process.env.JWT_SECRET || 'downbeat-dev-jwt-secret-min-32-chars-long',
  corsOrigin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean) : ['http://localhost:3000'],
  webUrl: process.env.WEB_URL || 'http://localhost:3000',
  /** Fake "dev-mock-token-*" logins for local testing. Opt-in, and never in production. */
  allowDevTokens: process.env.ALLOW_DEV_TOKENS === 'true' && process.env.NODE_ENV !== 'production',
  pairingCodeTtlMinutes: parseInt(process.env.PAIRING_CODE_TTL_MINUTES || '10', 10),
  
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID || 'downbeat-919f8',
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'downbeat-919f8.firebasestorage.app',
    serviceAccountPath: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  },

  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    // Latest model Google labels "Stable" (gemini-2.5-flash is deprecated as of Dec 2026).
    model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
    /** Per-request timeout and overall budget for one agent call (all retries + fallbacks). */
    requestTimeoutMs: parseInt(process.env.GEMINI_TIMEOUT_MS || '60000', 10),
    totalBudgetMs: parseInt(process.env.GEMINI_BUDGET_MS || '110000', 10),
    // Tried in order when the main model is overloaded (503/429) after retries.
    fallbackModels: (process.env.GEMINI_FALLBACK_MODELS ?? 'gemini-3.6-flash').split(',').map((m) => m.trim()).filter(Boolean),
    // Streaming music model for Beat Jam (the only real-time Lyria model; experimental).
    lyriaRealtimeModel: process.env.LYRIA_REALTIME_MODEL || 'models/lyria-realtime-exp',
  },

  storage: {
    maxUploadBytes: 20 * 1024 * 1024, // Gemini inline audio limit (whole request)
  },

  relay: {
    host: process.env.RELAY_HOST || '127.0.0.1',
    port: parseInt(process.env.RELAY_PORT || '48000', 10),
    secret: process.env.RELAY_SECRET || 'downbeat-relay-shared-secret',
    publicIp: process.env.PUBLIC_RELAY_IP || '127.0.0.1',
  },

  audio: {
    defaultJitterBufferMs: parseInt(process.env.DEFAULT_JITTER_BUFFER_MS || '40', 10),
    sampleRate: 48000,
    bitDepth: 24,
    channels: 2,
    stunServer: process.env.STUN_SERVER || 'stun:stun.l.google.com:19302',
  }
};
