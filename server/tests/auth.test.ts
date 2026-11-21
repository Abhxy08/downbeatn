// Mock Firebase Admin before importing app to avoid network / ESM external dependencies in unit tests
jest.mock('../src/services/firebase', () => ({
  initFirebase: jest.fn(),
  getAuth: jest.fn(() => ({
    verifyIdToken: jest.fn(async (token: string) => {
      if (token === 'dev-mock-token-test-user' || token === 'valid-id-token') {
        return {
          uid: 'user-abc',
          email: 'test@downbeat.audio',
          name: 'Alex Beatmaker',
        };
      }
      throw new Error('Invalid Firebase ID token');
    }),
  })),
  getFirestore: jest.fn(() => ({
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        set: jest.fn().mockResolvedValue({}),
        get: jest.fn().mockResolvedValue({ exists: false }),
        update: jest.fn().mockResolvedValue({}),
        collection: jest.fn(() => ({
          doc: jest.fn(() => ({
            set: jest.fn().mockResolvedValue({}),
          })),
        })),
      })),
      where: jest.fn(() => ({
        limit: jest.fn(() => ({
          get: jest.fn().mockResolvedValue({ empty: true, docs: [] }),
        })),
      })),
    })),
  })),
  getStorage: jest.fn(),
  isFirebaseAdminConfigured: () => false,
}));

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/index';
import { config } from '../src/config';
import { pairingsCache } from '../src/routes/auth';
import { deviceStore } from '../src/services/devices';

describe('Auth Token Verification & Pairing Flow', () => {
  let pairingId: string;
  let pairingCode: string;
  let refreshToken: string;
  let sessionToken: string;

  beforeEach(() => {
    pairingsCache.clear();
  });

  test('POST /auth/pair/start - generates a valid 6-char pairing code and ID', async () => {
    const res = await request(app).post('/auth/pair/start');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.code).toBeDefined();
    expect(res.body.code.length).toBe(6);
    expect(res.body.pairingId).toBeDefined();
    expect(res.body.pairUrl).toContain('/link?code=');

    pairingId = res.body.pairingId;
    pairingCode = res.body.code;
  });

  test('GET /auth/pair/status - returns pending status initially', async () => {
    const startRes = await request(app).post('/auth/pair/start');
    const pid = startRes.body.pairingId;

    const statusRes = await request(app).get(`/auth/pair/status?pairingId=${pid}`);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.status).toBe('pending');
  });

  test('POST /auth/pair/confirm - pairs device with verified ID token', async () => {
    const startRes = await request(app).post('/auth/pair/start');
    const code = startRes.body.code;
    const pid = startRes.body.pairingId;

    // Confirm with mock verified token
    const confirmRes = await request(app).post('/auth/pair/confirm').send({
      code,
      idToken: 'dev-mock-token-test-user',
    });

    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.success).toBe(true);
    expect(confirmRes.body.user).toBeDefined();

    // Check status now returns confirmed with tokens
    const statusRes = await request(app).get(`/auth/pair/status?pairingId=${pid}`);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.status).toBe('confirmed');
    expect(statusRes.body.refreshToken).toBeDefined();
    expect(statusRes.body.sessionToken).toBeDefined();

    refreshToken = statusRes.body.refreshToken;
    sessionToken = statusRes.body.sessionToken;
  });

  test('POST /auth/token/refresh - generates a new valid short-lived session token', async () => {
    const validRefreshToken = jwt.sign(
      { uid: 'user-abc', email: 'test@downbeat.audio', name: 'Tester', type: 'plugin_refresh' },
      config.jwtSecret,
      { expiresIn: '90d' }
    );

    const refreshRes = await request(app).post('/auth/token/refresh').send({
      refreshToken: validRefreshToken,
    });

    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.success).toBe(true);
    expect(refreshRes.body.sessionToken).toBeDefined();

    // Verify token can access protected endpoint
    const protectedRes = await request(app)
      .post('/sessions')
      .set('Authorization', `Bearer ${refreshRes.body.sessionToken}`)
      .send({ name: 'Studio A Jam', bpm: 128 });

    expect(protectedRes.status).toBe(201);
    expect(protectedRes.body.session.bpm).toBe(128);
  });

  test('pairing credential is delivered once and the code cannot be reused', async () => {
    const start = await request(app).post('/auth/pair/start').send({ deviceLabel: 'Ableton Live on MacBook' });
    await request(app).post('/auth/pair/confirm').send({ code: start.body.code, idToken: 'dev-mock-token-test-user' }).expect(200);
    const first = await request(app).get(`/auth/pair/status?pairingId=${start.body.pairingId}`);
    expect(first.body.refreshToken).toBeDefined();
    const second = await request(app).get(`/auth/pair/status?pairingId=${start.body.pairingId}`);
    expect(second.body).toEqual({ status: 'confirmed', alreadyDelivered: true });
    const reuse = await request(app).post('/auth/pair/confirm').send({ code: start.body.code, idToken: 'dev-mock-token-test-user' });
    expect(reuse.status).toBe(409);
  });

  test('revoking a device kills its refresh token and session tokens', async () => {
    const start = await request(app).post('/auth/pair/start').send({ deviceLabel: 'FL Studio' });
    await request(app).post('/auth/pair/confirm').send({ code: start.body.code, idToken: 'dev-mock-token-test-user' }).expect(200);
    const st = await request(app).get(`/auth/pair/status?pairingId=${start.body.pairingId}`);
    const { refreshToken: rt, sessionToken: session } = st.body;

    // refresh works, session token works, device is listed
    const fresh = await request(app).post('/auth/token/refresh').send({ refreshToken: rt }).expect(200);
    const list = await request(app).get('/auth/devices').set('Authorization', `Bearer ${session}`).expect(200);
    const dev = list.body.devices.find((d: any) => d.deviceId === start.body.pairingId);
    expect(dev).toMatchObject({ label: 'FL Studio', current: true });
    expect(dev.tokenHash).toBeUndefined(); // never exposed

    // a forged refresh token for the same device (different secret material) is rejected
    const realUid = (jwt.decode(rt) as any).uid;
    const forged = jwt.sign({ uid: realUid, type: 'plugin_refresh', did: start.body.pairingId, n: 1 }, config.jwtSecret);
    await request(app).post('/auth/token/refresh').send({ refreshToken: forged }).expect(401);

    // revoke from "the dashboard"
    await request(app).delete(`/auth/devices/${start.body.pairingId}`).set('Authorization', `Bearer ${session}`).expect(200);
    await request(app).post('/auth/token/refresh').send({ refreshToken: rt }).expect(401);
    await request(app).get('/sessions').set('Authorization', `Bearer ${session}`).expect(401);
    await request(app).get('/sessions').set('Authorization', `Bearer ${fresh.body.sessionToken}`).expect(401);
    const other = (await request(app).post('/auth/token/refresh').send({ refreshToken: rt })).status;
    expect(other).toBe(401);
  });

  test('Protected routes reject requests without or with invalid tokens', async () => {
    const noTokenRes = await request(app).post('/sessions').send({ name: 'Forbidden' });
    expect(noTokenRes.status).toBe(401);

    const invalidTokenRes = await request(app)
      .post('/sessions')
      .set('Authorization', 'Bearer invalid-token-string')
      .send({ name: 'Forbidden' });
    expect(invalidTokenRes.status).toBe(401);
  });
});
