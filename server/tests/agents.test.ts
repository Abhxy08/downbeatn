// AI agents: Mix Doctor, Credits Agent, Beat Jam — against a fake Gemini client and a fake Lyria stream.
jest.mock('../src/services/firebase', () => ({
  initFirebase: () => undefined,
  isFirebaseAdminConfigured: () => false,
  getAuth: () => ({
    verifyIdToken: async () => {
      throw new Error('no firebase in tests');
    },
  }),
  getFirestore: () => {
    throw new Error('Firestore not configured in tests');
  },
}));

// Fake Lyria RealTime connection, captured so tests can drive it.
const mockMusic: { calls: any[]; callbacks: any; session: any } = { calls: [], callbacks: null, session: null };
jest.mock('../src/services/beatJam', () => {
  const actual = jest.requireActual('../src/services/beatJam');
  return {
    ...actual,
    lyriaConnector: async (callbacks: any) => {
      mockMusic.callbacks = callbacks;
      mockMusic.session = {
        setWeightedPrompts: async (p: any) => void mockMusic.calls.push(['prompts', p]),
        setMusicGenerationConfig: async (p: any) => void mockMusic.calls.push(['config', p]),
        play: () => void mockMusic.calls.push(['play']),
        stop: () => void mockMusic.calls.push(['stop']),
        resetContext: () => void mockMusic.calls.push(['reset']),
        close: () => void mockMusic.calls.push(['close']),
      };
      return mockMusic.session;
    },
  };
});

import request from 'supertest';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
import { AddressInfo } from 'net';
import { app, server, signaling } from '../src/index';
import { config } from '../src/config';
import { setGenAIClientForTests, setRetryDelaysForTests } from '../src/services/gemini';
import { normaliseSplits, buildAiDisclosure } from '../src/services/credits';
import { keyToScale, lyriaBpm } from '../src/services/beatJam';
import { detectAudioMime } from '../src/services/mixDoctor';
import { makeWav } from './helpers/wav';

const token = (uid: string, name: string) =>
  jwt.sign({ uid, name, email: `${uid}@x.dev`, type: 'session' }, config.jwtSecret, { expiresIn: '1h' });
const ALEX = token('u-alex', 'Alex');
const SAM = token('u-sam', 'Sam');
const EVE = token('u-eve', 'Eve');
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

/** Fake @google/genai client: returns queued JSON responses and records requests. */
const genai = {
  requests: [] as any[],
  queue: [] as any[],
  models: {
    generateContent: async (req: any) => {
      genai.requests.push(req);
      const next = genai.queue.shift();
      if (next instanceof Error) throw next;
      return { text: typeof next === 'string' ? next : JSON.stringify(next) };
    },
  },
};

let sessionId = '';
let wsUrl = '';

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, () => r()));
  wsUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
  const created = await request(app).post('/sessions').set(auth(ALEX)).send({ name: 'Agents Test', bpm: 124, keySignature: 'F min' });
  sessionId = created.body.session.id;
  await request(app).post('/sessions/join').set(auth(SAM)).send({ inviteCode: created.body.session.inviteCode });
});

afterAll((done) => {
  setGenAIClientForTests(null);
  signaling.close();
  server.close(() => done());
});

beforeEach(() => {
  setGenAIClientForTests(genai);
  genai.requests = [];
  genai.queue = [];
});

// ---------------------------------------------------------------------------
const okCheck = { status: 'ok', finding: 'fine', fix: 'none needed' };
const diagnosis = (overrides: any = {}) => ({
  summary: 'Solid mix.',
  overallScore: 80,
  checks: { clipping: okCheck, loudness: okCheck, frequencyMasking: okCheck, stereo: okCheck },
  otherIssues: [],
  strengths: ['punchy kick'],
  ...overrides,
});

const tone = (seconds: number, dbfs: number) => {
  const fs = 48000, a = 10 ** (dbfs / 20), x = new Float32Array(fs * seconds);
  for (let i = 0; i < x.length; i++) x[i] = a * Math.sin((2 * Math.PI * 220 * i) / fs);
  return x;
};

describe('Mix Doctor', () => {
  test('measures the WAV, sends audio + measurements to Gemini with a JSON schema, stores the report', async () => {
    genai.queue.push(diagnosis());
    const wav = makeWav([tone(2, -12), tone(2, -12)], 48000);
    const res = await request(app)
      .post(`/agents/mix-doctor?sessionId=${sessionId}&fileName=bounce.wav`)
      .set(auth(ALEX))
      .set('Content-Type', 'audio/wav')
      .send(wav)
      .expect(201);

    const report = res.body.report;
    expect(report.kind).toBe('mix_doctor');
    expect(report.metrics.samplePeakDbfs).toBeCloseTo(-12, 0);
    expect(report.metrics.stereoCorrelation).toBe(1);
    expect(report.model).toBe(config.gemini.model);

    const req = genai.requests[0];
    expect(req.model).toBe(config.gemini.model);
    expect(req.config.responseMimeType).toBe('application/json');
    expect(req.config.responseJsonSchema.required).toContain('checks');
    const parts = req.contents[0].parts;
    expect(parts[0].inlineData.mimeType).toBe('audio/wav');
    expect(parts[1].text).toContain('"integratedLufs"');

    const list = await request(app).get(`/agents/reports?sessionId=${sessionId}&kind=mix_doctor`).set(auth(SAM)).expect(200);
    expect(list.body.reports.map((r: any) => r.id)).toContain(report.id);

    const ev = await request(app).get(`/sessions/${sessionId}/events`).set(auth(SAM));
    expect(ev.body.events.some((e: any) => e.type === 'mix_report' && e.payload.reportId === report.id)).toBe(true);
  });

  test('measured clipping overrides a model that says "ok"', async () => {
    genai.queue.push(diagnosis());
    const wav = makeWav([tone(1, 2), tone(1, 2)], 48000); // +2 dBFS -> clipped
    const res = await request(app).post(`/agents/mix-doctor?sessionId=${sessionId}`).set(auth(ALEX)).set('Content-Type', 'audio/wav').send(wav).expect(201);
    expect(res.body.report.diagnosis.checks.clipping.status).toBe('problem');
    expect(res.body.report.diagnosis.checks.clipping.finding).toMatch(/clipped region/);
  });

  test('retries once on schema-invalid output, then fails with a clear error (no fake report)', async () => {
    genai.queue.push({ nope: true }, 'not json');
    const wav = makeWav([tone(1, -12), tone(1, -12)], 48000);
    const res = await request(app).post(`/agents/mix-doctor?sessionId=${sessionId}`).set(auth(ALEX)).set('Content-Type', 'audio/wav').send(wav).expect(502);
    expect(res.body.error).toMatch(/unusable response/);
    expect(genai.requests).toHaveLength(2);
  });

  test('rejects non-members, non-audio and missing API key', async () => {
    const wav = makeWav([tone(1, -12), tone(1, -12)], 48000);
    await request(app).post(`/agents/mix-doctor?sessionId=${sessionId}`).set(auth(EVE)).set('Content-Type', 'audio/wav').send(wav).expect(403);
    await request(app)
      .post(`/agents/mix-doctor?sessionId=${sessionId}`)
      .set(auth(ALEX))
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(5000, 7))
      .expect(415);

    setGenAIClientForTests(null); // real client path, but GEMINI_API_KEY is empty in tests
    const prev = config.gemini.apiKey;
    (config.gemini as any).apiKey = '';
    const res = await request(app).post(`/agents/mix-doctor?sessionId=${sessionId}`).set(auth(ALEX)).set('Content-Type', 'audio/wav').send(wav).expect(503);
    expect(res.body.error).toMatch(/GEMINI_API_KEY/);
    (config.gemini as any).apiKey = prev;
  });

  test('overloaded model (503) is retried, then falls back to the next model', async () => {
    setRetryDelaysForTests([1, 1]);
    const overloaded = Object.assign(new Error('high demand'), { status: 503 });
    genai.queue.push(overloaded, overloaded, overloaded, diagnosis({ overallScore: 77 }));
    const wav = makeWav([tone(1, -12), tone(1, -12)], 48000);
    const res = await request(app).post(`/agents/mix-doctor?sessionId=${sessionId}`).set(auth(ALEX)).set('Content-Type', 'audio/wav').send(wav).expect(201);
    expect(genai.requests.map((r) => r.model)).toEqual([config.gemini.model, config.gemini.model, config.gemini.model, config.gemini.fallbackModels[0]]);
    expect(res.body.report.model).toBe(config.gemini.fallbackModels[0]);
    expect(res.body.report.diagnosis.overallScore).toBe(77);
  });

  test('detectAudioMime', () => {
    expect(detectAudioMime(Buffer.from('ID3\u0003\u0000'))).toBe('audio/mpeg');
    expect(detectAudioMime(Buffer.from('fLaC\u0000\u0000'))).toBe('audio/flac');
    expect(detectAudioMime(Buffer.from('random bytes'), 'text/plain')).toBeNull();
  });
});

describe('Credits Agent', () => {
  let proposalId = '';

  test('normaliseSplits always sums to exactly 100', () => {
    const r = normaliseSplits([{ userId: 'a', percentage: 33.3 }, { userId: 'b', percentage: 33.3 }, { userId: 'c', percentage: 33.3 }]);
    expect(Array.from(r.values()).reduce((x, y) => x + y, 0)).toBe(100);
    const z = normaliseSplits([{ userId: 'a', percentage: 0 }, { userId: 'b', percentage: 0 }]);
    expect(Array.from(z.values())).toEqual([50, 50]);
  });

  test('proposal is constrained to real members, sums to 100, and has a log-based AI disclosure', async () => {
    // log some activity first
    const c = new WebSocket(wsUrl);
    await new Promise((r) => c.once('open', r));
    c.send(JSON.stringify({ type: 'auth', token: ALEX, client: 'plugin' }));
    c.send(JSON.stringify({ type: 'join_session', sessionId }));
    c.send(JSON.stringify({ type: 'crdt_event', id: 'note-credits-1', eventType: 'contribution_note', payload: { text: 'made the drums' } }));
    await new Promise((r) => setTimeout(r, 150));
    c.close();

    genai.queue.push({
      sessionOverview: 'Alex made drums; Sam wrote lyrics.',
      splits: [
        { userId: 'u-alex', role: 'Beat', percentage: 50, reasoning: 'drums note' },
        { userId: 'u-hacker', role: 'Nobody', percentage: 30, reasoning: 'not a member' },
        { userId: 'u-alex', role: 'Dup', percentage: 10, reasoning: 'duplicate' },
      ],
      caveats: [],
    });
    const res = await request(app).post('/agents/credits/propose').set(auth(SAM)).send({ sessionId }).expect(201);
    const p = res.body.proposal;
    proposalId = p.id;

    expect(p.status).toBe('pending');
    expect(p.splits.map((s: any) => s.userId).sort()).toEqual(['u-alex', 'u-sam']);
    expect(p.splits.reduce((a: number, s: any) => a + s.percentage, 0)).toBe(100);
    expect(p.splits.find((s: any) => s.userId === 'u-alex').percentage).toBe(100); // Sam omitted -> 0%
    expect(p.caveats.join(' ')).toMatch(/omitted 1 member/);
    expect(p.aiDisclosure).toMatch(/drafted by an AI model/);

    const prompt = genai.requests[0].contents[0].parts[0].text;
    expect(prompt).toContain('made the drums');
    expect(prompt).toContain('u-sam');
  });

  test('approval flow: non-listed user refused, PDF only when final, final after all approve', async () => {
    await request(app).post(`/agents/credits/${proposalId}/approve`).set(auth(EVE)).send({ sessionId }).expect(403); // not a member
    await request(app).get(`/agents/credits/${proposalId}/pdf?sessionId=${sessionId}`).set(auth(ALEX)).expect(409);
    const draft = await request(app).get(`/agents/credits/${proposalId}/pdf?sessionId=${sessionId}&draft=1`).set(auth(ALEX)).expect(200);
    expect(draft.headers['content-type']).toBe('application/pdf');

    let r = await request(app).post(`/agents/credits/${proposalId}/approve`).set(auth(ALEX)).send({ sessionId }).expect(200);
    expect(r.body.proposal.status).toBe('pending');
    r = await request(app).post(`/agents/credits/${proposalId}/approve`).set(auth(SAM)).send({ sessionId }).expect(200);
    expect(r.body.proposal.status).toBe('final');
    expect(r.body.proposal.finalizedAt).toBeGreaterThan(0);

    const pdf = await request(app)
      .get(`/agents/credits/${proposalId}/pdf?sessionId=${sessionId}`)
      .set(auth(SAM))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.headers['content-disposition']).toMatch(/Agents Test - split sheet\.pdf/);

    await request(app).post(`/agents/credits/${proposalId}/approve`).set(auth(SAM)).send({ sessionId }).expect(409); // already final

    const ev = await request(app).get(`/sessions/${sessionId}/events`).set(auth(SAM));
    const types = ev.body.events.map((e: any) => e.type);
    expect(types).toEqual(expect.arrayContaining(['credits_proposed', 'credits_approved', 'credits_final']));
  });

  test('request-changes resets approvals, and a new draft supersedes open ones', async () => {
    genai.queue.push({
      sessionOverview: 'x',
      splits: [{ userId: 'u-alex', role: 'Beat', percentage: 60, reasoning: 'r' }, { userId: 'u-sam', role: 'Lyrics', percentage: 40, reasoning: 'r' }],
      caveats: [],
    });
    const p = (await request(app).post('/agents/credits/propose').set(auth(ALEX)).send({ sessionId }).expect(201)).body.proposal;
    await request(app).post(`/agents/credits/${p.id}/approve`).set(auth(ALEX)).send({ sessionId }).expect(200);
    const r = await request(app).post(`/agents/credits/${p.id}/request-changes`).set(auth(SAM)).send({ sessionId, comment: 'I also wrote the melody' }).expect(200);
    expect(r.body.proposal.status).toBe('changes_requested');
    expect(r.body.proposal.approvals).toEqual({});

    genai.queue.push({
      sessionOverview: 'y',
      splits: [{ userId: 'u-alex', role: 'Beat', percentage: 50, reasoning: 'r' }, { userId: 'u-sam', role: 'Lyrics & melody', percentage: 50, reasoning: 'r' }],
      caveats: [],
    });
    await request(app).post('/agents/credits/propose').set(auth(SAM)).send({ sessionId, guidance: 'I also wrote the melody' }).expect(201);
    expect(genai.requests[genai.requests.length - 1].contents[0].parts[0].text).toContain('I also wrote the melody');

    const list = (await request(app).get(`/agents/reports?sessionId=${sessionId}&kind=credits`).set(auth(ALEX))).body.reports;
    expect(list.find((x: any) => x.id === p.id).status).toBe('superseded');
  });

  test('AI disclosure mentions Beat Jam only when it was used', () => {
    const base = { id: 'x', userId: 'u', userName: 'Alex', timestamp: 1, source: 'server' as const };
    expect(buildAiDisclosure([], 'm')).toMatch(/No AI-generated music/);
    expect(buildAiDisclosure([{ ...base, type: 'beat_jam', payload: { action: 'start' } }], 'm')).toMatch(/Lyria RealTime\) was started 1 time\(s\) by Alex/);
  });
});

describe('Beat Jam', () => {
  test('key and tempo mapping', () => {
    expect(keyToScale('F min')).toBe('A_FLAT_MAJOR_F_MINOR');
    expect(keyToScale('C maj')).toBe('C_MAJOR_A_MINOR');
    expect(keyToScale('C min')).toBe('E_FLAT_MAJOR_C_MINOR');
    expect(keyToScale('Bb major')).toBe('B_FLAT_MAJOR_G_MINOR');
    expect(keyToScale('C#m')).toBe('E_MAJOR_D_FLAT_MINOR');
    expect(keyToScale('???')).toBe('SCALE_UNSPECIFIED');
    expect(lyriaBpm(124)).toBe(124);
    expect(lyriaBpm(240)).toBe(120);
    expect(lyriaBpm(45)).toBe(90);
  });

  test('start -> audio streamed to plugins as binary frames; steer; tempo change resets; stop', async () => {
    mockMusic.calls = [];
    const plugin = new WebSocket(wsUrl);
    const web = new WebSocket(wsUrl);
    const frames: Buffer[] = [];
    const states: any[] = [];
    const webFrames: Buffer[] = [];
    plugin.on('message', (d, isBinary) => (isBinary ? frames.push(d as Buffer) : JSON.parse(d.toString()).type === 'beatjam_state' && states.push(JSON.parse(d.toString()).state)));
    web.on('message', (d, isBinary) => isBinary && webFrames.push(d as Buffer));
    await Promise.all([new Promise((r) => plugin.once('open', r)), new Promise((r) => web.once('open', r))]);
    plugin.send(JSON.stringify({ type: 'auth', token: ALEX, client: 'plugin', daw: 'Live' }));
    plugin.send(JSON.stringify({ type: 'join_session', sessionId }));
    web.send(JSON.stringify({ type: 'auth', token: SAM, client: 'web' }));
    web.send(JSON.stringify({ type: 'join_session', sessionId }));
    await new Promise((r) => setTimeout(r, 100));

    plugin.send(JSON.stringify({ type: 'beatjam_start', prompt: 'dark minimal techno' }));
    await new Promise((r) => setTimeout(r, 100));
    const sessionBpm = (await request(app).get(`/sessions/${sessionId}`).set(auth(ALEX))).body.session.bpm;
    expect(mockMusic.calls[0]).toEqual(['prompts', { weightedPrompts: [{ text: 'dark minimal techno', weight: 1 }] }]);
    expect(mockMusic.calls[1][1].musicGenerationConfig).toMatchObject({ bpm: lyriaBpm(sessionBpm), scale: 'A_FLAT_MAJOR_F_MINOR' });
    expect(mockMusic.calls[2]).toEqual(['play']);
    expect(states[states.length - 1]).toMatchObject({ active: true, status: 'playing', startedBy: 'Alex' });

    // Lyria sends audio -> plugin gets [0x01][pcm], web gets nothing
    const pcm = Buffer.alloc(1920, 3);
    mockMusic.callbacks.onmessage({ serverContent: { audioChunks: [{ data: pcm.toString('base64'), mimeType: 'audio/l16' }] } });
    await new Promise((r) => setTimeout(r, 50));
    expect(frames).toHaveLength(1);
    expect(frames[0][0]).toBe(0x01);
    expect(frames[0].subarray(1)).toEqual(pcm);
    expect(webFrames).toHaveLength(0);

    // steer adds a weighted prompt
    web.send(JSON.stringify({ type: 'beatjam_steer', prompt: 'add hi-hats' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(mockMusic.calls.find((c) => c[0] === 'prompts' && c[1].weightedPrompts.length === 2)).toBeTruthy();

    // tempo change -> new config + context reset
    plugin.send(JSON.stringify({ type: 'tempo_sync', bpm: 132 }));
    await new Promise((r) => setTimeout(r, 50));
    expect(mockMusic.calls.some((c) => c[0] === 'config' && c[1].musicGenerationConfig.bpm === 132)).toBe(true);
    expect(mockMusic.calls.some((c) => c[0] === 'reset')).toBe(true);

    plugin.send(JSON.stringify({ type: 'beatjam_stop' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(states[states.length - 1]).toMatchObject({ active: false });
    expect(mockMusic.calls.some((c) => c[0] === 'close')).toBe(true);

    const ev = await request(app).get(`/sessions/${sessionId}/events`).set(auth(SAM));
    const jam = ev.body.events.filter((e: any) => e.type === 'beat_jam').map((e: any) => e.payload.action);
    expect(jam).toEqual(['start', 'steer', 'stop']);
    plugin.close();
    web.close();
  });

  test('Lyria error is surfaced to the room instead of failing silently', async () => {
    const plugin = new WebSocket(wsUrl);
    const states: any[] = [];
    plugin.on('message', (d, isBinary) => {
      if (isBinary) return;
      const m = JSON.parse(d.toString());
      if (m.type === 'beatjam_state') states.push(m.state);
    });
    await new Promise((r) => plugin.once('open', r));
    plugin.send(JSON.stringify({ type: 'auth', token: ALEX, client: 'plugin' }));
    plugin.send(JSON.stringify({ type: 'join_session', sessionId }));
    plugin.send(JSON.stringify({ type: 'beatjam_start', prompt: 'lofi' }));
    await new Promise((r) => setTimeout(r, 100));
    mockMusic.callbacks.onerror(new Error('quota exceeded'));
    await new Promise((r) => setTimeout(r, 50));
    expect(states[states.length - 1]).toMatchObject({ active: false, status: 'error' });
    expect(states[states.length - 1].error).toMatch(/quota exceeded/);
    plugin.close();
  });
});
