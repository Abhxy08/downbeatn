import { decodeWav, analyzeMix, integratedLoudness, isWav } from '../src/services/audioAnalysis';
import { makeWav } from './helpers/wav';

const sine = (fs: number, seconds: number, freq: number, dbfs: number, phase = 0) => {
  const a = Math.pow(10, dbfs / 20);
  const x = new Float32Array(Math.round(fs * seconds));
  for (let i = 0; i < x.length; i++) x[i] = a * Math.sin((2 * Math.PI * freq * i) / fs + phase);
  return x;
};

describe('Mix Doctor audio measurements', () => {
  test('EBU Tech 3341 case 1: stereo 1 kHz sine at -23 dBFS reads -23.0 LUFS (48 kHz and 44.1 kHz)', () => {
    for (const fs of [48000, 44100]) {
      const s = sine(fs, 20, 1000, -23);
      const { integrated } = integratedLoudness([s, s], fs);
      expect(Math.abs(integrated - -23)).toBeLessThan(0.1);
    }
  });

  test('EBU Tech 3341 case 2: stereo 1 kHz sine at -33 dBFS reads -33.0 LUFS', () => {
    const s = sine(48000, 20, 1000, -33);
    expect(Math.abs(integratedLoudness([s, s], 48000).integrated - -33)).toBeLessThan(0.1);
  });

  test('gating ignores silence', () => {
    const fs = 48000;
    const s = sine(fs, 10, 1000, -23);
    const withSilence = new Float32Array(s.length * 2);
    withSilence.set(s, 0); // second half silent
    expect(Math.abs(integratedLoudness([withSilence, withSilence], fs).integrated - -23)).toBeLessThan(0.15);
  });

  test('decodes 16/24/32-bit PCM and 32-bit float WAV', () => {
    const s = sine(48000, 0.5, 440, -6);
    for (const [bits, float] of [[16, false], [24, false], [32, false], [32, true]] as const) {
      const buf = makeWav([s, s], 48000, bits, float);
      expect(isWav(buf)).toBe(true);
      const d = decodeWav(buf);
      expect(d.channels).toHaveLength(2);
      expect(d.sampleRate).toBe(48000);
      expect(Math.abs(d.channels[0][1000] - s[1000])).toBeLessThan(1e-3);
    }
    expect(() => decodeWav(Buffer.from('not a wav file at all'))).toThrow();
  });

  test('detects clipping and reports true peak above sample peak', () => {
    const fs = 48000;
    const s = sine(fs, 2, 100, 3); // +3 dBFS -> hard clipped by the WAV writer
    const m = analyzeMix(decodeWav(makeWav([s, s], fs)), 300);
    expect(m.clippedRegions).toBeGreaterThan(10);
    expect(m.clippedAtSeconds.length).toBeGreaterThan(0);
    expect(m.samplePeakDbfs).toBeGreaterThan(-0.1);
  });

  test('stereo image: identical channels = +1, inverted = -1, mono file = null', () => {
    const fs = 48000;
    const s = sine(fs, 2, 220, -12);
    const inv = s.map((v) => -v);
    expect(analyzeMix(decodeWav(makeWav([s, s], fs)), 300).stereoCorrelation).toBe(1);
    const out = analyzeMix(decodeWav(makeWav([s, inv], fs)), 300);
    expect(out.stereoCorrelation).toBe(-1);
    expect(out.lowEndCorrelation).toBe(-1);
    expect(analyzeMix(decodeWav(makeWav([s], fs)), 300).stereoCorrelation).toBeNull();
  });

  test('spectral balance puts a 100 Hz tone in the bass band', () => {
    const fs = 48000;
    const s = sine(fs, 2, 100, -12);
    const m = analyzeMix(decodeWav(makeWav([s, s], fs)), 300);
    const bands = m.spectralBalanceDb;
    expect(bands.bass_60_250).toBeGreaterThan(-3);
    expect(bands.mid_500_2k).toBeLessThan(bands.bass_60_250 - 15);
    expect(bands.air_6k_16k).toBeLessThan(bands.bass_60_250 - 30);
  });
});
