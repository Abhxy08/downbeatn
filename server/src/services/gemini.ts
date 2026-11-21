import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { config } from '../config';

/**
 * Thrown when an AI agent can't run (no API key, API error, or unusable output).
 * Routes turn this into a clear HTTP error instead of returning made-up results.
 */
export class AgentError extends Error {
  constructor(message: string, public status = 502) {
    super(message);
  }
}

let aiClient: GoogleGenAI | null = null;
let RETRY_DELAYS_MS = [1500, 4000];

/** Tests shorten the backoff. */
export function setRetryDelaysForTests(delays: number[]) {
  RETRY_DELAYS_MS = delays;
}
let clientOverride: GoogleGenAI | null = null;

/** Tests inject a fake client here. */
export function setGenAIClientForTests(client: unknown | null) {
  clientOverride = client as GoogleGenAI | null;
}

export function getGenAI(): GoogleGenAI {
  if (clientOverride) return clientOverride;
  if (!config.gemini.apiKey) {
    throw new AgentError('GEMINI_API_KEY is not set on the server, so AI agents are unavailable.', 503);
  }
  if (!aiClient) aiClient = new GoogleGenAI({ apiKey: config.gemini.apiKey });
  return aiClient;
}

type Part = { text: string } | { inlineData: { mimeType: string; data: string } };

/**
 * Calls Gemini with structured JSON output and validates the result with zod.
 * Retries once if the model returns JSON that doesn't match the schema.
 */
export async function generateStructured<T>(opts: {
  parts: Part[];
  jsonSchema: Record<string, unknown>;
  validator: z.ZodType<T>;
  systemInstruction?: string;
  temperature?: number;
}): Promise<{ data: T; model: string }> {
  const ai = getGenAI();
  const models = [config.gemini.model, ...config.gemini.fallbackModels.filter((m) => m !== config.gemini.model)];
  let lastError = '';
  const deadline = Date.now() + config.gemini.totalBudgetMs;

  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string | undefined;
    let model = models[0];
    // Transient overload (503) / rate limit (429): back off and retry, then fall back to the next model.
    outer: for (const candidate of models) {
      model = candidate;
      for (let tries = 0; ; tries++) {
        try {
          const response = await ai.models.generateContent({
            model,
            contents: [{ role: 'user', parts: opts.parts }],
            config: {
              responseMimeType: 'application/json',
              responseJsonSchema: opts.jsonSchema,
              systemInstruction: opts.systemInstruction,
              temperature: opts.temperature ?? 0.4,
              httpOptions: { timeout: Math.max(5000, Math.min(config.gemini.requestTimeoutMs, deadline - Date.now())) },
            },
          });
          text = response.text;
          break outer;
        } catch (e: any) {
          const status = Number(e?.status ?? e?.code);
          const msg = String(e?.message ?? e) + ' ' + String(e?.cause?.code ?? e?.cause?.message ?? '');
          const network = /fetch failed|EAI_AGAIN|ENOTFOUND|ECONNRESET|ETIMEDOUT|socket hang up|aborted|timed? ?out/i.test(msg);
          const busy = status === 503 || status === 429 || status === 504 || network;
          const outOfTime = Date.now() > deadline - 5000;
          if (busy && outOfTime) {
            throw new AgentError('Gemini is too slow or overloaded right now. Please try again in a minute.', 503);
          }
          if (busy && tries < RETRY_DELAYS_MS.length) {
            await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[tries]));
            continue;
          }
          if (busy && candidate !== models[models.length - 1]) {
            console.warn(`[Gemini] ${candidate} overloaded (${status}); falling back to the next model`);
            continue outer;
          }
          throw new AgentError(
            busy
              ? network
                ? `Can't reach Gemini (network error: ${msg.trim().slice(0, 120)}). Check the server's internet connection.`
                : `Gemini is overloaded right now (${status}). Please try again in a minute.`
              : `Gemini request failed${status ? ` (${status})` : ''}: ${String(e?.message ?? e).slice(0, 300)}`,
            busy ? 503 : 502
          );
        }
      }
    }

    try {
      const parsed = opts.validator.safeParse(JSON.parse(text ?? ''));
      if (parsed.success) return { data: parsed.data, model };
      lastError = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    } catch {
      lastError = 'response was not valid JSON';
    }
  }
  throw new AgentError(`Gemini returned an unusable response (${lastError}).`);
}
