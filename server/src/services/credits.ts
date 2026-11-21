import crypto from 'crypto';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import { generateStructured, AgentError } from './gemini';
import type { SessionEvent, UserContribution } from './crdt';
import type { SessionData } from '../routes/sessions';

// ---------------------------------------------------------------------------
// Model output
// ---------------------------------------------------------------------------
export const proposalSchema = z.object({
  sessionOverview: z.string().min(1).max(1000),
  splits: z
    .array(
      z.object({
        userId: z.string().min(1).max(128),
        role: z.string().min(1).max(80),
        percentage: z.number().min(0).max(100),
        reasoning: z.string().min(1).max(800),
      })
    )
    .min(1)
    .max(20),
  caveats: z.array(z.string().max(300)).max(5),
});
export type RawProposal = z.infer<typeof proposalSchema>;

const proposalJsonSchema = {
  type: 'object',
  properties: {
    sessionOverview: { type: 'string', description: 'What happened in the session, in 2-4 sentences.' },
    splits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          userId: { type: 'string', description: 'Must be one of the member userIds given.' },
          role: { type: 'string', description: 'e.g. "Producer / beat", "Topline & lyrics"' },
          percentage: { type: 'number', description: 'Share of the composition/production split, 0-100.' },
          reasoning: { type: 'string', description: 'Cite concrete evidence from the log (numbers, notes).' },
        },
        required: ['userId', 'role', 'percentage', 'reasoning'],
      },
    },
    caveats: {
      type: 'array',
      maxItems: 5,
      items: { type: 'string' },
      description: 'What the log cannot see / where humans should double-check.',
    },
  },
  required: ['sessionOverview', 'splits', 'caveats'],
};

const SYSTEM = `You are the DownBeat Credits Agent. You draft a fair songwriting/production split sheet
from a collaboration session's activity log, for the collaborators to review and approve.
Rules:
- Include every member exactly once, using the given userIds. Percentages should sum to 100.
- Base shares on evidence: audio played (seconds of real signal sent), MIDI notes played through the plugin,
  notes written in the session's shared MIDI clip (direct compositional work),
  tempo/arrangement decisions, and especially the contribution notes people logged (these describe creative
  work the plugin cannot see, like writing lyrics or a melody). Weigh creative contributions over mere presence.
- The plugin cannot see edits made elsewhere in each DAW; say so in caveats when it matters.
- AI-generated material (Beat Jam / Lyria) is not a human contributor and gets no share.
- If evidence is thin or balanced, propose an equal split and say why. Never invent activity that isn't in the log.`;

// ---------------------------------------------------------------------------
// Proposal (stored as a report of kind "credits")
// ---------------------------------------------------------------------------
export interface SplitLine {
  userId: string;
  userName: string;
  role: string;
  percentage: number; // integer, all lines sum to 100
  reasoning: string;
}

export type ProposalStatus = 'pending' | 'changes_requested' | 'final' | 'superseded';

export interface CreditsProposal {
  id: string;
  sessionId: string;
  kind: 'credits';
  createdAt: number;
  createdBy: { uid: string; name: string };
  songTitle: string;
  status: ProposalStatus;
  sessionOverview: string;
  splits: SplitLine[];
  caveats: string[];
  aiDisclosure: string;
  model: string;
  guidance?: string;
  eventCount: number;
  approvals: Record<string, { approvedAt: number; name: string }>;
  changeRequests: Array<{ uid: string; name: string; comment: string; at: number }>;
  finalizedAt?: number;
  pdfPath?: string | null;
}

/** Largest-remainder rounding to whole percentages that sum to exactly 100. */
export function normaliseSplits(raw: Array<{ userId: string; percentage: number }>): Map<string, number> {
  const total = raw.reduce((s, r) => s + Math.max(0, r.percentage), 0);
  const shares = raw.map((r) => ({
    userId: r.userId,
    exact: total > 0 ? (Math.max(0, r.percentage) / total) * 100 : 100 / raw.length,
  }));
  const out = new Map(shares.map((s) => [s.userId, Math.floor(s.exact)]));
  let remaining = 100 - Array.from(out.values()).reduce((a, b) => a + b, 0);
  for (const s of [...shares].sort((a, b) => (b.exact % 1) - (a.exact % 1))) {
    if (remaining <= 0) break;
    out.set(s.userId, out.get(s.userId)! + 1);
    remaining--;
  }
  return out;
}

/** Builds the AI-use disclosure from the log itself (not from the model). */
export function buildAiDisclosure(events: SessionEvent[], model: string): string {
  const jams = events.filter((e) => e.type === 'beat_jam' && (e.payload as any).action === 'start');
  const jamUsers = Array.from(new Set(jams.map((e) => e.userName)));
  const mixReports = events.filter((e) => e.type === 'mix_report').length;
  const parts = [
    `This split sheet was drafted by an AI model (Google ${model}) from DownBeat's session activity log ` +
      `(${events.length} recorded events) and was reviewed and approved by every listed collaborator before it became final.`,
  ];
  if (jams.length) {
    parts.push(
      `AI-generated music was used in this session: Beat Jam (Google Lyria RealTime) was started ${jams.length} time(s) by ${jamUsers.join(', ')}. ` +
        `Lyria output is watermarked by Google. AI-generated material receives no share here, and may not be eligible for copyright ` +
        `protection in some jurisdictions; collaborators should confirm whether any of it remains in the final recording.`
    );
  } else {
    parts.push('No AI-generated music (Beat Jam) was used in this session according to the log.');
  }
  if (mixReports) parts.push(`Mix Doctor (Google Gemini) produced ${mixReports} technical mix report(s); these are advisory only.`);
  parts.push('The activity log only covers what passes through the DownBeat plugin plus notes the collaborators logged.');
  return parts.join(' ');
}

function evidence(session: SessionData, contributions: UserContribution[], events: SessionEvent[]) {
  const byUser = new Map(contributions.map((c) => [c.userId, c]));
  const members = session.members.map((uid) => {
    const c = byUser.get(uid);
    return {
      userId: uid,
      name: session.memberNames?.[uid] || c?.userName || uid,
      audioSecondsPlayed: c?.audioActiveSeconds ?? 0,
      midiNotesPlayed: c?.midiNotes ?? 0,
      sharedClipNotesWritten: c?.clipNotesAdded ?? 0,
      tempoChanges: c?.tempoChanges ?? 0,
      eventCount: c?.count ?? 0,
      eventTypes: c?.types ?? {},
      contributionNotes: c?.notes ?? [],
    };
  });
  const timeline = events
    .filter((e) => ['contribution_note', 'tempo_change', 'beat_jam', 'session_join'].includes(e.type) || (e.type === 'clip_edit' && (e.payload as any).action !== 'add'))
    .slice(-60)
    .map((e) => `${new Date(e.timestamp).toISOString().slice(11, 16)} ${e.userName}: ${e.type} ${JSON.stringify(e.payload)}`);
  return { members, timeline };
}

export async function draftProposal(args: {
  session: SessionData;
  contributions: UserContribution[];
  events: SessionEvent[];
  actor: { uid: string; name: string };
  guidance?: string;
}): Promise<CreditsProposal> {
  const { session, contributions, events, actor } = args;
  if (session.members.length === 0) throw new AgentError('Session has no members.', 400);

  const ev = evidence(session, contributions, events);
  const prompt = [
    `Session "${session.name}" (${session.bpm} BPM, ${session.keySignature}).`,
    `members = ${JSON.stringify(ev.members)}`,
    `timeline (latest key events) =\n${ev.timeline.join('\n') || '(none)'}`,
    args.guidance ? `A collaborator asked for changes to the previous draft: "${args.guidance.slice(0, 500)}". Take it into account if the evidence supports it.` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const { data, model } = await generateStructured({
    systemInstruction: SYSTEM,
    parts: [{ text: prompt }],
    jsonSchema: proposalJsonSchema,
    validator: proposalSchema,
    temperature: 0.2,
  });

  // Enforce: exactly the session members, each once; whole percentages summing to 100.
  const fromModel = new Map<string, RawProposal['splits'][number]>();
  for (const s of data.splits) if (session.members.includes(s.userId) && !fromModel.has(s.userId)) fromModel.set(s.userId, s);
  const caveats = [...data.caveats];
  const missing = session.members.filter((uid) => !fromModel.has(uid));
  if (missing.length) caveats.push(`The AI omitted ${missing.length} member(s); they were added with 0% — review before approving.`);

  const rows = session.members.map((uid) => {
    const m = fromModel.get(uid);
    return { userId: uid, percentage: m?.percentage ?? 0, role: m?.role ?? 'Collaborator', reasoning: m?.reasoning ?? 'Not addressed by the AI draft.' };
  });
  const pct = normaliseSplits(rows);

  return {
    id: `credits_${crypto.randomUUID()}`,
    sessionId: session.id,
    kind: 'credits',
    createdAt: Date.now(),
    createdBy: actor,
    songTitle: session.name,
    status: 'pending',
    sessionOverview: data.sessionOverview,
    splits: rows.map((r) => ({
      userId: r.userId,
      userName: session.memberNames?.[r.userId] || r.userId,
      role: r.role,
      percentage: pct.get(r.userId)!,
      reasoning: r.reasoning,
    })),
    caveats,
    aiDisclosure: buildAiDisclosure(events, model),
    model,
    guidance: args.guidance,
    eventCount: events.length,
    approvals: {},
    changeRequests: [],
  };
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------
export function renderSplitSheetPdf(p: CreditsProposal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Split Sheet - ${p.songTitle}`, Author: 'DownBeat' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const final = p.status === 'final';
    doc.fontSize(22).font('Helvetica-Bold').text('Split Sheet', { continued: false });
    if (!final) doc.fontSize(12).fillColor('#b45309').text('DRAFT - not approved by all collaborators').fillColor('black');
    doc.moveDown(0.5);
    doc.fontSize(11).font('Helvetica');
    doc.text(`Work: ${p.songTitle}`);
    doc.text(`Session ID: ${p.sessionId}`);
    doc.text(`Proposal ID: ${p.id}`);
    doc.text(`Drafted: ${new Date(p.createdAt).toUTCString()}`);
    if (p.finalizedAt) doc.text(`Finalized: ${new Date(p.finalizedAt).toUTCString()}`);
    doc.moveDown();

    // Table
    doc.font('Helvetica-Bold').fontSize(12).text('Shares');
    doc.moveDown(0.3);
    const x = 50;
    const cols = [170, 160, 70, 95];
    const header = ['Collaborator', 'Role', 'Share', 'Approved'];
    let y = doc.y;
    doc.fontSize(10);
    header.forEach((h, i) => doc.text(h, x + cols.slice(0, i).reduce((a, b) => a + b, 0), y, { width: cols[i] }));
    y += 16;
    doc.moveTo(x, y - 3).lineTo(x + cols.reduce((a, b) => a + b, 0), y - 3).stroke();
    doc.font('Helvetica');
    for (const s of p.splits) {
      const approval = p.approvals[s.userId];
      const cells = [s.userName, s.role, `${s.percentage}%`, approval ? new Date(approval.approvedAt).toISOString().slice(0, 10) : '-'];
      const h = Math.max(...cells.map((c, i) => doc.heightOfString(c, { width: cols[i] })));
      cells.forEach((c, i) => doc.text(c, x + cols.slice(0, i).reduce((a, b) => a + b, 0), y, { width: cols[i] }));
      y += h + 6;
    }
    doc.font('Helvetica-Bold').text(`Total: ${p.splits.reduce((a, s) => a + s.percentage, 0)}%`, x, y);
    doc.x = x;
    doc.moveDown(1.5);

    doc.font('Helvetica-Bold').fontSize(12).text('Session overview');
    doc.font('Helvetica').fontSize(10).text(p.sessionOverview);
    doc.moveDown();

    doc.font('Helvetica-Bold').fontSize(12).text('Reasoning');
    doc.font('Helvetica').fontSize(10);
    for (const s of p.splits) doc.text(`${s.userName} (${s.percentage}%): ${s.reasoning}`).moveDown(0.3);
    if (p.caveats.length) {
      doc.moveDown(0.5).font('Helvetica-Bold').fontSize(12).text('Caveats');
      doc.font('Helvetica').fontSize(10);
      for (const c of p.caveats) doc.text(`- ${c}`);
    }
    doc.moveDown();

    doc.font('Helvetica-Bold').fontSize(12).text('AI-use disclosure');
    doc.font('Helvetica').fontSize(10).text(p.aiDisclosure);
    doc.moveDown();

    doc.font('Helvetica-Bold').fontSize(12).text('Approvals');
    doc.font('Helvetica').fontSize(10);
    for (const s of p.splits) {
      const a = p.approvals[s.userId];
      doc.text(a ? `${s.userName}: approved electronically in DownBeat on ${new Date(a.approvedAt).toUTCString()}` : `${s.userName}: not yet approved`);
    }
    doc.end();
  });
}
