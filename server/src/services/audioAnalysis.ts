/**
 * Objective measurements for Mix Doctor, computed on the server (deterministic) and
 * handed to Gemini as ground truth. Gemini listens to the audio for interpretation;
 * numbers like dBFS / LUFS / correlation come from here, not from the model.
 */

export interface DecodedAudio {
  sampleRate: number;
  channels: Float32Array[]; // 1 or 2 channels (extra channels ignored)
  durationSec: number;
  bitDepth: number;
  format: 'pcm' | 'float';
}

export interface MixMetrics {
  durationSec: number;
  sampleRate: number;
  channels: number;
  bitDepth: number;
  samplePeakDbfs: number;
  truePeakDbfs: number; // 4x oversampled estimate
  clippedRegions: number; // runs of >= 3 consecutive samples at/above -0.01 dBFS
  clippedAtSeconds: number[]; // first few clip locations
  integratedLufs: number; // ITU-R BS.1770-4, gated
  maxShortTermLufs: number; // loudest 3 s window
  rmsDbfs: number;
  crestFactorDb: number; // sample peak - RMS
  peakToLoudnessDb: number; // true peak - integrated loudness (PLR)
  stereoCorrelation: number | null; // -1..1 (null for mono)
  lowEndCorrelation: number | null; // below ~150 Hz
  sideToMidDb: number | null;
  balanceDb: number | null; // L - R RMS
  dcOffset: number[];
  /** Band level (dB) relative to the full-band RMS of the mono sum */
  spectralBalanceDb: Record<'sub_20_60' | 'bass_60_250' | 'lowmid_250_500' | 'mid_500_2k' | 'highmid_2k_6k' | 'air_6k_16k', number>;
}

// ---------------------------------------------------------------------------
// WAV decoding
// ---------------------------------------------------------------------------
export function isWav(buf: Buffer): boolean {
  return buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE';
}

export function decodeWav(buf: Buffer): DecodedAudio {
  if (!isWav(buf)) throw new Error('Not a RIFF/WAVE file');
  let offset = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number; blockAlign: number } | null = null;
  let dataStart = -1;
  let dataLen = 0;

  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      let format = buf.readUInt16LE(body);
      const channels = buf.readUInt16LE(body + 2);
      const sampleRate = buf.readUInt32LE(body + 4);
      const blockAlign = buf.readUInt16LE(body + 12);
      const bits = buf.readUInt16LE(body + 14);
      if (format === 0xfffe && size >= 26) format = buf.readUInt16LE(body + 24); // WAVE_FORMAT_EXTENSIBLE subformat
      fmt = { format, channels, sampleRate, bits, blockAlign };
    } else if (id === 'data') {
      dataStart = body;
      dataLen = Math.min(size, buf.length - body); // tolerate truncated/streamed files
      break;
    }
    offset = body + size + (size & 1);
  }

  if (!fmt || dataStart < 0) throw new Error('WAV is missing fmt or data chunk');
  const { format, channels, sampleRate, bits, blockAlign } = fmt;
  if (!(format === 1 && [16, 24, 32].includes(bits)) && !(format === 3 && bits === 32)) {
    throw new Error(`Unsupported WAV encoding (format ${format}, ${bits}-bit). Use 16/24/32-bit PCM or 32-bit float.`);
  }
  if (channels < 1 || sampleRate < 8000 || blockAlign <= 0) throw new Error('Invalid WAV header');

  const frames = Math.floor(dataLen / blockAlign);
  const useCh = Math.min(2, channels);
  const out = Array.from({ length: useCh }, () => new Float32Array(frames));
  const bytes = bits / 8;

  for (let i = 0; i < frames; i++) {
    const frameOff = dataStart + i * blockAlign;
    for (let c = 0; c < useCh; c++) {
      const p = frameOff + c * bytes;
      let v: number;
      if (format === 3) v = buf.readFloatLE(p);
      else if (bits === 16) v = buf.readInt16LE(p) / 32768;
      else if (bits === 24) v = buf.readIntLE(p, 3) / 8388608;
      else v = buf.readInt32LE(p) / 2147483648;
      out[c][i] = v;
    }
  }
  return { sampleRate, channels: out, durationSec: frames / sampleRate, bitDepth: bits, format: format === 3 ? 'float' : 'pcm' };
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------
type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number };

function normalise(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): Biquad {
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function filter(x: Float32Array, f: Biquad): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = f.b0 * xi + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi;
    y[i] = yi;
  }
  return y;
}

/** BS.1770 K-weighting for any sample rate (same design as libebur128). */
function kWeighting(fs: number): [Biquad, Biquad] {
  // Stage 1: high-shelf pre-filter
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  // Stage 2: RLB high-pass
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / fs);
  a0 = 1 + K / Q + K * K;
  const hp: Biquad = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [shelf, hp];
}

function bandpass(fs: number, lo: number, hi: number): Biquad {
  const f0 = Math.sqrt(lo * hi);
  const Q = f0 / (hi - lo);
  const w0 = (2 * Math.PI * Math.min(f0, fs * 0.45)) / fs, alpha = Math.sin(w0) / (2 * Q), c = Math.cos(w0);
  return normalise(alpha, 0, -alpha, 1 + alpha, -2 * c, 1 - alpha);
}

function lowpass(fs: number, fc: number): Biquad {
  const w0 = (2 * Math.PI * fc) / fs, alpha = Math.sin(w0) / (2 * Math.SQRT1_2), c = Math.cos(w0);
  return normalise((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + alpha, -2 * c, 1 - alpha);
}

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------
const toDb = (x: number, floor = -160) => (x > 0 ? Math.max(floor, 20 * Math.log10(x)) : floor);
const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

function meanSquare(x: Float32Array, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return to > from ? s / (to - from) : 0;
}

function correlation(a: Float32Array, b: Float32Array): number {
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < a.length; i++) {
    sab += a[i] * b[i];
    saa += a[i] * a[i];
    sbb += b[i] * b[i];
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 1;
}

/** Integrated loudness per ITU-R BS.1770-4 (400 ms blocks, 75 % overlap, -70 LUFS absolute + -10 LU relative gate). */
export function integratedLoudness(channels: Float32Array[], fs: number): { integrated: number; maxShortTerm: number } {
  const [shelf, hp] = kWeighting(fs);
  const weighted = channels.map((ch) => filter(filter(ch, shelf), hp));
  const n = weighted[0].length;

  const blockPower = (len: number, step: number) => {
    const out: number[] = [];
    for (let start = 0; start + len <= n; start += step) {
      let sum = 0;
      for (const ch of weighted) sum += meanSquare(ch, start, start + len);
      out.push(sum);
    }
    return out;
  };
  const lufs = (p: number) => -0.691 + 10 * Math.log10(p);

  const blocks = blockPower(Math.round(0.4 * fs), Math.round(0.1 * fs));
  const absGated = blocks.filter((p) => p > 0 && lufs(p) > -70);
  let integrated = -70;
  if (absGated.length) {
    const relGate = lufs(absGated.reduce((a, b) => a + b, 0) / absGated.length) - 10;
    const gated = absGated.filter((p) => lufs(p) > relGate);
    if (gated.length) integrated = lufs(gated.reduce((a, b) => a + b, 0) / gated.length);
  }

  const st = blockPower(Math.round(3 * fs), Math.round(0.1 * fs)).filter((p) => p > 0);
  const maxShortTerm = st.length ? Math.max(...st.map(lufs)) : integrated;
  return { integrated, maxShortTerm };
}

/** 4x oversampled peak estimate using cubic (Catmull-Rom) interpolation between samples. */
function truePeak(x: Float32Array): number {
  let peak = 0;
  for (let i = 1; i + 2 < x.length; i++) {
    const y0 = x[i - 1], y1 = x[i], y2 = x[i + 1], y3 = x[i + 2];
    peak = Math.max(peak, Math.abs(y1));
    const a = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3;
    const b = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
    const c = -0.5 * y0 + 0.5 * y2;
    for (const t of [0.25, 0.5, 0.75]) peak = Math.max(peak, Math.abs(((a * t + b) * t + c) * t + y1));
  }
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  return peak;
}

export function analyzeMix(audio: DecodedAudio, maxSeconds = 300): MixMetrics {
  const fs = audio.sampleRate;
  const limit = Math.min(audio.channels[0].length, Math.round(maxSeconds * fs));
  const chans = audio.channels.map((c) => c.subarray(0, limit));
  const stereo = chans.length >= 2;
  const L = chans[0];
  const R = stereo ? chans[1] : chans[0];

  // Peaks + clipping
  let samplePeak = 0;
  let clippedRegions = 0;
  const clippedAt: number[] = [];
  for (const ch of chans) {
    let run = 0;
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > samplePeak) samplePeak = a;
      if (a >= 0.9989) {
        run++;
        if (run === 3) {
          clippedRegions++;
          if (clippedAt.length < 5) clippedAt.push(round(i / fs, 2));
        }
      } else run = 0;
    }
  }
  const tp = Math.max(...chans.map(truePeak));

  // Loudness
  const { integrated, maxShortTerm } = integratedLoudness(chans, fs);
  const rms = Math.sqrt(chans.reduce((s, c) => s + meanSquare(c), 0) / chans.length);

  // Stereo image
  let stereoCorrelation: number | null = null, lowEndCorrelation: number | null = null, sideToMidDb: number | null = null, balanceDb: number | null = null;
  if (stereo) {
    stereoCorrelation = round(correlation(L, R), 2);
    const lp = lowpass(fs, 150);
    lowEndCorrelation = round(correlation(filter(L, lp), filter(R, lp)), 2);
    let sm = 0, ss = 0;
    for (let i = 0; i < L.length; i++) {
      const m = (L[i] + R[i]) / 2, s = (L[i] - R[i]) / 2;
      sm += m * m;
      ss += s * s;
    }
    sideToMidDb = round(10 * Math.log10((ss + 1e-20) / (sm + 1e-20)));
    balanceDb = round(10 * Math.log10((meanSquare(L) + 1e-20) / (meanSquare(R) + 1e-20)));
  }

  // Spectral balance of the mono sum
  const mono = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) mono[i] = (L[i] + R[i]) / 2;
  const total = meanSquare(mono) + 1e-20;
  const band = (lo: number, hi: number) => round(10 * Math.log10((meanSquare(filter(mono, bandpass(fs, lo, hi))) + 1e-20) / total));

  return {
    durationSec: round(audio.durationSec, 2),
    sampleRate: fs,
    channels: audio.channels.length,
    bitDepth: audio.bitDepth,
    samplePeakDbfs: round(toDb(samplePeak), 2),
    truePeakDbfs: round(toDb(tp), 2),
    clippedRegions,
    clippedAtSeconds: clippedAt,
    integratedLufs: round(integrated),
    maxShortTermLufs: round(maxShortTerm),
    rmsDbfs: round(toDb(rms)),
    crestFactorDb: round(toDb(samplePeak) - toDb(rms)),
    peakToLoudnessDb: round(toDb(tp) - integrated),
    stereoCorrelation,
    lowEndCorrelation,
    sideToMidDb,
    balanceDb,
    dcOffset: chans.map((c) => round(c.reduce((s, v) => s + v, 0) / Math.max(1, c.length), 4)),
    spectralBalanceDb: {
      sub_20_60: band(20, 60),
      bass_60_250: band(60, 250),
      lowmid_250_500: band(250, 500),
      mid_500_2k: band(500, 2000),
      highmid_2k_6k: band(2000, 6000),
      air_6k_16k: band(6000, Math.min(16000, fs * 0.45)),
    },
  };
}
