import * as Y from 'yjs';
import { z } from 'zod';
import { crdtManager } from './crdt';

/**
 * The session's shared MIDI clip: one looping 4-bar pattern on a 16th-note grid that every
 * collaborator edits live from their plugin. Stored in the session's Yjs document (map
 * "clip_notes", keyed by note id), so it is persisted with the event log and merges
 * concurrent edits without conflicts. Each plugin renders it in sync with its own DAW.
 */
export const CLIP_STEPS = 64; // 4 bars x 16 sixteenths
export const STEPS_PER_BEAT = 4;
export const MIN_PITCH = 24; // C1
export const MAX_PITCH = 108; // C8
export const MAX_NOTES = 512;

export interface ClipNote {
  id: string;
  step: number;
  length: number;
  pitch: number;
  velocity: number;
  by: string; // uid
  byName: string;
}

const noteSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/),
    step: z.number().int().min(0).max(CLIP_STEPS - 1),
    length: z.number().int().min(1).max(CLIP_STEPS),
    pitch: z.number().int().min(MIN_PITCH).max(MAX_PITCH),
    velocity: z.number().int().min(1).max(127).default(100),
  })
  .refine((n) => n.step + n.length <= CLIP_STEPS, { message: 'note runs past the end of the clip' });

export const clipOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), note: noteSchema }),
  z.object({ op: z.literal('update'), note: noteSchema }),
  z.object({ op: z.literal('remove'), id: z.string().max(64) }),
  z.object({ op: z.literal('clear') }),
]);
export type ClipOp = z.infer<typeof clipOpSchema>;

function notesMap(sessionId: string): Y.Map<ClipNote> {
  return crdtManager.getOrCreateDoc(sessionId).getMap<ClipNote>('clip_notes');
}

export function getClip(sessionId: string) {
  return {
    steps: CLIP_STEPS,
    stepsPerBeat: STEPS_PER_BEAT,
    notes: Array.from(notesMap(sessionId).values()).sort((a, b) => a.step - b.step || a.pitch - b.pitch),
  };
}

export type ApplyResult =
  | { ok: true; op: ClipOp; note?: ClipNote; removed?: ClipNote; cleared?: number }
  | { ok: false; error: string };

/** Validates and applies one edit. `actor` becomes the author of added/updated notes. */
export function applyClipOp(sessionId: string, raw: unknown, actor: { uid: string; name: string }): ApplyResult {
  const parsed = clipOpSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid clip edit' };
  const op = parsed.data;
  const map = notesMap(sessionId);
  const doc = crdtManager.getOrCreateDoc(sessionId);

  switch (op.op) {
    case 'add': {
      if (map.has(op.note.id)) return { ok: false, error: 'duplicate note id' };
      if (map.size >= MAX_NOTES) return { ok: false, error: `clip is full (${MAX_NOTES} notes)` };
      const note: ClipNote = { ...op.note, by: actor.uid, byName: actor.name };
      doc.transact(() => map.set(note.id, note));
      crdtManager.touch(sessionId);
      return { ok: true, op, note };
    }
    case 'update': {
      const existing = map.get(op.note.id);
      if (!existing) return { ok: false, error: 'note no longer exists' };
      const note: ClipNote = { ...op.note, by: existing.by, byName: existing.byName }; // keep original author
      doc.transact(() => map.set(note.id, note));
      crdtManager.touch(sessionId);
      return { ok: true, op, note };
    }
    case 'remove': {
      const removed = map.get(op.id);
      if (!removed) return { ok: false, error: 'note no longer exists' };
      doc.transact(() => map.delete(op.id));
      crdtManager.touch(sessionId);
      return { ok: true, op, removed };
    }
    case 'clear': {
      const n = map.size;
      doc.transact(() => map.clear());
      crdtManager.touch(sessionId);
      return { ok: true, op, cleared: n };
    }
  }
}
