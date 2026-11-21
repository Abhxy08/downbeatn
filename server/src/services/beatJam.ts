import { GoogleGenAI } from '@google/genai';
import { config } from '../config';
import { AgentError } from './gemini';
import type { Actor } from './sessionBus';

/**
 * Beat Jam: one shared Lyria RealTime stream per DownBeat session.
 * Audio (16-bit PCM, 48 kHz stereo) is forwarded to every plugin in the room.
 */

// ---------------------------------------------------------------------------
// Lyria connection abstraction (lets tests inject a fake)
// ---------------------------------------------------------------------------
export interface MusicSessionLike {
  setWeightedPrompts(p: { weightedPrompts: Array<{ text: string; weight: number }> }): Promise<void>;
  setMusicGenerationConfig(p: { musicGenerationConfig: Record<string, unknown> }): Promise<void>;
  play(): void;
  stop(): void;
  resetContext(): void;
  close(): void;
}

export interface MusicCallbacks {
  onmessage: (msg: any) => void;
  onerror: (e: any) => void;
  onclose: (e: any) => void;
}

export type MusicConnector = (callbacks: MusicCallbacks) => Promise<MusicSessionLike>;

export const lyriaConnector: MusicConnector = async (callbacks) => {
  if (!config.gemini.apiKey) throw new AgentError('GEMINI_API_KEY is not set on the server, so Beat Jam is unavailable.', 503);
  // Lyria RealTime is served on the v1beta API surface.
  const client = new GoogleGenAI({ apiKey: config.gemini.apiKey, apiVersion: 'v1beta' });
  const session = await client.live.music.connect({ model: config.gemini.lyriaRealtimeModel, callbacks });
  return session as unknown as MusicSessionLike;
};

// ---------------------------------------------------------------------------
// Tempo / key mapping
// ---------------------------------------------------------------------------
const SCALES_BY_MAJOR_ROOT = [
  'C_MAJOR_A_MINOR', 'D_FLAT_MAJOR_B_FLAT_MINOR', 'D_MAJOR_B_MINOR', 'E_FLAT_MAJOR_C_MINOR',
  'E_MAJOR_D_FLAT_MINOR', 'F_MAJOR_D_MINOR', 'G_FLAT_MAJOR_E_FLAT_MINOR', 'G_MAJOR_E_MINOR',
  'A_FLAT_MAJOR_F_MINOR', 'A_MAJOR_G_FLAT_MINOR', 'B_FLAT_MAJOR_G_MINOR', 'B_MAJOR_A_FLAT_MINOR',
];
const NOTE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "F min" / "Bb major" / "C#m" -> Lyria Scale enum (relative major/minor share a scale). */
export function keyToScale(key: string): string {
  const m = /^\s*([A-Ga-g])\s*([#b♯♭]?)\s*(.*)$/.exec(key || '');
  if (!m) return 'SCALE_UNSPECIFIED';
  let root = NOTE[m[1].toUpperCase()];
  if (m[2] === '#' || m[2] === '♯') root += 1;
  if (m[2] === 'b' || m[2] === '♭') root -= 1;
  const quality = m[3].toLowerCase();
  const minor = /^(m(?!aj)|min)/.test(quality);
  const majorRoot = (((minor ? root + 3 : root) % 12) + 12) % 12;
  return SCALES_BY_MAJOR_ROOT[majorRoot];
}

/** Lyria accepts 60..200 BPM; halve/double to stay tempo-locked (e.g. 240 -> 120). */
export function lyriaBpm(bpm: number): number {
  let b = bpm;
  while (b > 200) b /= 2;
  while (b < 60) b *= 2;
  return Math.round(b);
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------
export interface BeatJamState {
  active: boolean;
  status: 'idle' | 'connecting' | 'playing' | 'error';
  prompts: Array<{ text: string; by: string }>;
  bpm?: number;
  scale?: string;
  startedBy?: string;
  startedAt?: number;
  error?: string;
}

export interface BeatJamSink {
  sendAudio(sessionId: string, pcm: Buffer): void;
  sendState(sessionId: string, state: BeatJamState): void;
  logEvent(sessionId: string, actor: Actor, payload: Record<string, unknown>): void;
  hasListeners(sessionId: string): boolean;
}

interface Jam {
  session?: MusicSessionLike;
  state: BeatJamState;
  basePrompt: string;
  steers: Array<{ text: string; by: string }>;
  maxTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  closing: boolean;
}

const MAX_STEERS = 3;

export class BeatJamManager {
  private jams = new Map<string, Jam>();

  constructor(
    private connector: MusicConnector,
    private sink: BeatJamSink,
    private opts = { maxDurationMs: 15 * 60_000, idleStopMs: 60_000 }
  ) {}

  getState(sessionId: string): BeatJamState {
    return this.jams.get(sessionId)?.state ?? { active: false, status: 'idle', prompts: [] };
  }

  private publish(sessionId: string, jam: Jam) {
    jam.state.prompts = [{ text: jam.basePrompt, by: jam.state.startedBy || '' }, ...jam.steers];
    this.sink.sendState(sessionId, { ...jam.state });
  }

  private weighted(jam: Jam) {
    return [{ text: jam.basePrompt, weight: 1.0 }, ...jam.steers.map((s) => ({ text: s.text, weight: 1.0 }))];
  }

  private genConfig(jam: Jam) {
    // Send the full config every time: unspecified fields reset to defaults.
    return { musicGenerationConfig: { bpm: jam.state.bpm, scale: jam.state.scale, temperature: 1.1, guidance: 4.0 } };
  }

  async start(sessionId: string, actor: Actor, prompt: string, bpm: number, key: string): Promise<BeatJamState> {
    const existing = this.jams.get(sessionId);
    if (existing && existing.state.active) return this.steer(sessionId, actor, prompt);

    const jam: Jam = {
      basePrompt: prompt,
      steers: [],
      closing: false,
      state: { active: true, status: 'connecting', prompts: [], bpm: lyriaBpm(bpm), scale: keyToScale(key), startedBy: actor.name, startedAt: Date.now() },
    };
    this.jams.set(sessionId, jam);
    this.publish(sessionId, jam);

    try {
      jam.session = await this.connector({
        onmessage: (msg) => this.onMessage(sessionId, jam, msg),
        onerror: (e) => this.fail(sessionId, jam, `Lyria error: ${e?.message ?? e}`),
        onclose: () => {
          if (!jam.closing) this.fail(sessionId, jam, 'Lyria closed the stream');
        },
      });
      await jam.session.setWeightedPrompts({ weightedPrompts: this.weighted(jam) });
      await jam.session.setMusicGenerationConfig(this.genConfig(jam));
      jam.session.play();
    } catch (e: any) {
      this.fail(sessionId, jam, e instanceof AgentError ? e.message : `Could not start Lyria RealTime: ${e?.message ?? e}`);
      return { ...jam.state };
    }

    jam.state.status = 'playing';
    jam.maxTimer = setTimeout(() => this.stop(sessionId, undefined, 'time limit reached'), this.opts.maxDurationMs);
    jam.maxTimer.unref();
    this.publish(sessionId, jam);
    this.sink.logEvent(sessionId, actor, { action: 'start', prompt, bpm: jam.state.bpm, scale: jam.state.scale });
    return { ...jam.state };
  }

  async steer(sessionId: string, actor: Actor, prompt: string): Promise<BeatJamState> {
    const jam = this.jams.get(sessionId);
    if (!jam || !jam.state.active || !jam.session) throw new AgentError('Beat Jam is not running in this session.', 409);
    jam.steers.push({ text: prompt, by: actor.name });
    if (jam.steers.length > MAX_STEERS) jam.steers.shift();
    await jam.session.setWeightedPrompts({ weightedPrompts: this.weighted(jam) });
    this.publish(sessionId, jam);
    this.sink.logEvent(sessionId, actor, { action: 'steer', prompt });
    return { ...jam.state };
  }

  /** Session tempo changed: Lyria needs a context reset for bpm to take effect. */
  async setTempo(sessionId: string, bpm: number) {
    const jam = this.jams.get(sessionId);
    if (!jam?.session || !jam.state.active) return;
    const b = lyriaBpm(bpm);
    if (b === jam.state.bpm) return;
    jam.state.bpm = b;
    await jam.session.setMusicGenerationConfig(this.genConfig(jam));
    jam.session.resetContext();
    this.publish(sessionId, jam);
  }

  stop(sessionId: string, actor?: Actor, reason = 'stopped'): BeatJamState {
    const jam = this.jams.get(sessionId);
    if (!jam) return this.getState(sessionId);
    jam.closing = true;
    clearTimeout(jam.maxTimer);
    clearTimeout(jam.idleTimer);
    try {
      jam.session?.stop();
      jam.session?.close();
    } catch {
      /* already closed */
    }
    this.jams.delete(sessionId);
    const state: BeatJamState = { active: false, status: 'idle', prompts: [] };
    this.sink.sendState(sessionId, { ...state, error: reason === 'stopped' ? undefined : `Beat Jam stopped: ${reason}` });
    if (actor) this.sink.logEvent(sessionId, actor, { action: 'stop' });
    return state;
  }

  /** Call when listeners join/leave: stops a jam nobody is listening to (saves API cost). */
  listenersChanged(sessionId: string) {
    const jam = this.jams.get(sessionId);
    if (!jam) return;
    clearTimeout(jam.idleTimer);
    if (!this.sink.hasListeners(sessionId)) {
      jam.idleTimer = setTimeout(() => this.stop(sessionId, undefined, 'no plugins listening'), this.opts.idleStopMs);
      jam.idleTimer.unref();
    }
  }

  stopAll() {
    for (const id of Array.from(this.jams.keys())) this.stop(id, undefined, 'server shutting down');
  }

  private onMessage(sessionId: string, jam: Jam, msg: any) {
    const chunks = msg?.serverContent?.audioChunks;
    if (Array.isArray(chunks)) {
      for (const c of chunks) if (c?.data) this.sink.sendAudio(sessionId, Buffer.from(c.data, 'base64'));
    }
    if (msg?.filteredPrompt) {
      jam.state.error = `Lyria filtered a prompt: ${msg.filteredPrompt.filteredReason || msg.filteredPrompt.text || ''}`.trim();
      this.publish(sessionId, jam);
    }
  }

  private fail(sessionId: string, jam: Jam, error: string) {
    if (jam.closing) return;
    jam.closing = true;
    clearTimeout(jam.maxTimer);
    clearTimeout(jam.idleTimer);
    try {
      jam.session?.close();
    } catch {
      /* ignore */
    }
    if (this.jams.get(sessionId) === jam) this.jams.delete(sessionId);
    this.sink.sendState(sessionId, { active: false, status: 'error', prompts: [], error });
  }
}
