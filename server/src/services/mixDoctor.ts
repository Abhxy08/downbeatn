import crypto from 'crypto';
import { z } from 'zod';
import { generateStructured, AgentError } from './gemini';
import { analyzeMix, decodeWav, isWav, MixMetrics } from './audioAnalysis';

export const SUPPORTED_AUDIO = ['audio/wav', 'audio/mpeg', 'audio/mp3', 'audio/flac', 'audio/ogg', 'audio/aac', 'audio/aiff', 'audio/m4a'];

/** Detects the audio type from magic bytes (falls back to the declared Content-Type). */
export function detectAudioMime(buf: Buffer, declared?: string): string | null {
  const ascii = (a: number, b: number) => buf.toString('ascii', a, b);
  if (buf.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (buf.length >= 4 && ascii(0, 4) === 'fLaC') return 'audio/flac';
  if (buf.length >= 4 && ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (buf.length >= 12 && ascii(0, 4) === 'FORM' && ['AIFF', 'AIFC'].includes(ascii(8, 12))) return 'audio/aiff';
  if (buf.length >= 3 && (ascii(0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0))) return 'audio/mpeg';
  if (buf.length >= 8 && ascii(4, 8) === 'ftyp') return 'audio/m4a';
  const d = (declared || '').split(';')[0].trim().toLowerCase();
  return SUPPORTED_AUDIO.includes(d) ? d : null;
}

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------
const STATUS = ['ok', 'warning', 'problem'] as const;

const check = z.object({
  status: z.enum(STATUS),
  finding: z.string().min(1).max(600),
  fix: z.string().min(1).max(600),
});

export const diagnosisSchema = z.object({
  summary: z.string().min(1).max(800),
  overallScore: z.number().int().min(0).max(100),
  checks: z.object({
    clipping: check,
    loudness: check,
    frequencyMasking: check,
    stereo: check,
  }),
  otherIssues: z
    .array(
      z.object({
        title: z.string().min(1).max(120),
        severity: z.enum(['low', 'medium', 'high']),
        timestamp: z.string().max(40).optional(),
        finding: z.string().min(1).max(600),
        fix: z.string().min(1).max(600),
      })
    )
    .max(6),
  strengths: z.array(z.string().max(200)).max(5),
});

export type Diagnosis = z.infer<typeof diagnosisSchema>;

const checkJson = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: [...STATUS] },
    finding: { type: 'string', description: 'What you measured/heard, citing numbers or timestamps.' },
    fix: { type: 'string', description: 'A concrete fix: which processor, frequency, amount, settings.' },
  },
  required: ['status', 'finding', 'fix'],
};

const diagnosisJsonSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: '2-3 sentence overview for the producer.' },
    overallScore: { type: 'integer', minimum: 0, maximum: 100, description: 'Technical mix readiness (not taste).' },
    checks: {
      type: 'object',
      properties: { clipping: checkJson, loudness: checkJson, frequencyMasking: checkJson, stereo: checkJson },
      required: ['clipping', 'loudness', 'frequencyMasking', 'stereo'],
    },
    otherIssues: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
          timestamp: { type: 'string', description: 'e.g. "0:42" if the issue is localized' },
          finding: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['title', 'severity', 'finding', 'fix'],
      },
    },
    strengths: { type: 'array', maxItems: 5, items: { type: 'string' } },
  },
  required: ['summary', 'overallScore', 'checks', 'otherIssues', 'strengths'],
};

const SYSTEM = `You are Mix Doctor, a senior mixing and mastering engineer reviewing a producer's bounce.
Rules:
- The "measurements" JSON was computed by DSP code and is ground truth. Never contradict it; cite it.
- Use your listening only for things measurements can't show (e.g. which instruments mask each other, harshness, mud), and say when a finding is based on listening.
- Every fix must be concrete and actionable in any DAW: name the tool (EQ, compressor, limiter, M/S EQ, sidechain...), the frequency/threshold/ratio/ceiling, and the amount.
- Loudness targets: streaming ~-14 LUFS integrated with true peak <= -1 dBTP; club/DJ masters often -8 to -6 LUFS. Judge against the producer's likely intent and state which target you used.
- Stereo: correlation below 0 suggests phase problems; low-end (<150 Hz) correlation below ~0.7 risks mono/club issues.
- Be honest and specific; don't pad with generic advice.`;

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
export interface MixDoctorResult {
  id: string;
  fileName: string;
  mimeType: string;
  bytes: number;
  metrics: MixMetrics | null;
  metricsError?: string;
  diagnosis: Diagnosis;
  model: string;
}

export async function runMixDoctor(audio: Buffer, opts: { fileName: string; declaredType?: string; notes?: string }): Promise<MixDoctorResult> {
  const mimeType = detectAudioMime(audio, opts.declaredType);
  if (!mimeType) throw new AgentError('Unsupported audio format. Upload WAV, MP3, FLAC, OGG, AAC, AIFF or M4A.', 415);

  let metrics: MixMetrics | null = null;
  let metricsError: string | undefined;
  if (isWav(audio)) {
    try {
      metrics = analyzeMix(decodeWav(audio));
    } catch (e: any) {
      metricsError = e.message;
    }
  } else {
    metricsError = 'Exact measurements are only computed for WAV uploads.';
  }

  const context = [
    `File: ${opts.fileName} (${mimeType}, ${(audio.length / 1e6).toFixed(1)} MB)`,
    metrics
      ? `measurements = ${JSON.stringify(metrics)}`
      : `No measurements available (${metricsError}). Estimate levels by listening and clearly say they are estimates.`,
    opts.notes ? `Producer's notes: ${opts.notes.slice(0, 500)}` : '',
    'Diagnose clipping, loudness, frequency masking and stereo issues, each with a concrete fix.',
  ]
    .filter(Boolean)
    .join('\n');

  const { data, model } = await generateStructured({
    systemInstruction: SYSTEM,
    parts: [{ inlineData: { mimeType, data: audio.toString('base64') } }, { text: context }],
    jsonSchema: diagnosisJsonSchema,
    validator: diagnosisSchema,
    temperature: 0.3,
  });

  return {
    id: `mix_${crypto.randomUUID()}`,
    fileName: opts.fileName,
    mimeType,
    bytes: audio.length,
    metrics,
    metricsError,
    diagnosis: enforceMeasurements(data, metrics),
    model,
  };
}

/** Measurements win over the model where they're unambiguous. */
export function enforceMeasurements(d: Diagnosis, m: MixMetrics | null): Diagnosis {
  if (!m) return d;
  const out = structuredClone(d);
  const clipped = m.clippedRegions > 0 || m.truePeakDbfs > -0.1;
  if (clipped && out.checks.clipping.status === 'ok') {
    out.checks.clipping.status = m.clippedRegions > 0 ? 'problem' : 'warning';
    out.checks.clipping.finding =
      `Measured: ${m.clippedRegions} clipped region(s)${m.clippedAtSeconds.length ? ` (first at ${m.clippedAtSeconds.join('s, ')}s)` : ''}, ` +
      `true peak ${m.truePeakDbfs} dBTP. ` + out.checks.clipping.finding;
  }
  if (!clipped && m.truePeakDbfs <= -1 && out.checks.clipping.status === 'problem') {
    out.checks.clipping.status = 'ok';
    out.checks.clipping.finding = `Measured true peak ${m.truePeakDbfs} dBTP with no clipped samples. ` + out.checks.clipping.finding;
  }
  return out;
}
