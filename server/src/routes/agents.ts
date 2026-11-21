import express, { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from './auth';
import { loadSession, isMember, SessionData } from './sessions';
import { config } from '../config';
import { AgentError } from '../services/gemini';
import { runMixDoctor } from '../services/mixDoctor';
import { draftProposal, renderSplitSheetPdf, CreditsProposal } from '../services/credits';
import { crdtManager } from '../services/crdt';
import { reportStore, StoredReport } from '../services/reports';
import { saveObject } from '../services/storage';
import { publishServerEvent } from '../services/sessionBus';
import type { VerifiedUser } from '../services/verifyToken';

export const agentsRouter = Router();

type Req = Request & { user: VerifiedUser; session: SessionData };

/** Loads ?sessionId= / body.sessionId and checks membership. */
async function requireMember(req: Request, res: Response, next: NextFunction) {
  const sessionId = String((req.query.sessionId as string) || (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body.sessionId : '') || '');
  if (!sessionId) return res.status(400).json({ success: false, error: 'sessionId is required.' });
  const session = await loadSession(sessionId);
  if (!session) return res.status(404).json({ success: false, error: 'Session not found.' });
  const user = (req as any).user as VerifiedUser;
  if (!isMember(session, user.uid)) return res.status(403).json({ success: false, error: 'You are not a member of this session.' });
  (req as any).session = session;
  next();
}

function fail(res: Response, e: any) {
  if (e instanceof AgentError) return res.status(e.status).json({ success: false, error: e.message });
  console.error('[Agents]', e);
  return res.status(500).json({ success: false, error: 'Internal error' });
}

const actorOf = (u: VerifiedUser) => ({ uid: u.uid, name: u.name });

/** Which agents can run on this server (no secrets exposed). */
agentsRouter.get('/status', requireAuth, (_req, res) => {
  res.json({
    success: true,
    geminiConfigured: Boolean(config.gemini.apiKey),
    model: config.gemini.model,
    lyriaModel: config.gemini.lyriaRealtimeModel,
    maxUploadMb: config.storage.maxUploadBytes / 1e6,
  });
});

/** Reports for a session. GET /agents/reports?sessionId=..&kind=mix_doctor|credits */
agentsRouter.get('/reports', requireAuth, requireMember, async (req, res) => {
  const { session } = req as Req;
  const kind = req.query.kind === 'mix_doctor' || req.query.kind === 'credits' ? req.query.kind : undefined;
  res.json({ success: true, reports: await reportStore.list(session.id, kind) });
});

// ---------------------------------------------------------------------------
// Mix Doctor: POST /agents/mix-doctor?sessionId=..&fileName=..   body = raw audio file
// ---------------------------------------------------------------------------
agentsRouter.post(
  '/mix-doctor',
  requireAuth,
  express.raw({ type: ['audio/*', 'application/octet-stream'], limit: config.storage.maxUploadBytes }),
  requireMember,
  async (req, res) => {
    const { user, session } = req as Req;
    const audio = req.body as Buffer;
    if (!Buffer.isBuffer(audio) || audio.length < 1000) {
      return res.status(400).json({ success: false, error: 'Send the audio file as the request body (Content-Type audio/wav, audio/mpeg, ...).' });
    }
    const fileName = String(req.query.fileName || 'mix').slice(0, 120);

    try {
      const result = await runMixDoctor(audio, {
        fileName,
        declaredType: req.headers['content-type'],
        notes: typeof req.query.notes === 'string' ? req.query.notes : undefined,
      });
      const ext = result.mimeType.split('/')[1].replace('mpeg', 'mp3');
      const audioPath = await saveObject(`sessions/${session.id}/mix-doctor/${result.id}.${ext}`, audio, result.mimeType);

      const report: StoredReport = {
        ...result,
        id: result.id,
        sessionId: session.id,
        kind: 'mix_doctor',
        createdAt: Date.now(),
        createdBy: actorOf(user),
        audioPath,
      };
      await reportStore.save(report);
      publishServerEvent(session.id, actorOf(user), 'mix_report', {
        reportId: report.id,
        fileName,
        score: result.diagnosis.overallScore,
      });
      res.status(201).json({ success: true, report });
    } catch (e) {
      fail(res, e);
    }
  }
);

// ---------------------------------------------------------------------------
// Credits Agent
// ---------------------------------------------------------------------------
async function getProposal(sessionId: string, id: string): Promise<CreditsProposal | undefined> {
  const r = await reportStore.get(sessionId, id);
  return r?.kind === 'credits' ? (r as unknown as CreditsProposal) : undefined;
}

/** POST /agents/credits/propose { sessionId, guidance? } */
agentsRouter.post('/credits/propose', requireAuth, requireMember, async (req, res) => {
  const { user, session } = req as Req;
  try {
    await crdtManager.ensureLoaded(session.id);
    const events = crdtManager.getEvents(session.id);
    const contributions = Object.values(crdtManager.getContributionSummary(session.id));
    const guidance = typeof req.body?.guidance === 'string' ? req.body.guidance.trim().slice(0, 500) : undefined;

    const proposal = await draftProposal({ session, contributions, events, actor: actorOf(user), guidance: guidance || undefined });

    // A new draft supersedes older open ones
    for (const old of (await reportStore.list(session.id, 'credits')) as unknown as CreditsProposal[]) {
      if (old.status === 'pending' || old.status === 'changes_requested') {
        await reportStore.save({ ...(old as any), status: 'superseded' });
      }
    }
    await reportStore.save(proposal as unknown as StoredReport);
    publishServerEvent(session.id, actorOf(user), 'credits_proposed', {
      proposalId: proposal.id,
      splits: proposal.splits.map((s) => ({ name: s.userName, percentage: s.percentage })),
    });
    res.status(201).json({ success: true, proposal });
  } catch (e) {
    fail(res, e);
  }
});

/** POST /agents/credits/:id/approve { sessionId } — when every member approved, the sheet becomes final. */
agentsRouter.post('/credits/:id/approve', requireAuth, requireMember, async (req, res) => {
  const { user, session } = req as Req;
  const proposal = await getProposal(session.id, String(req.params.id));
  if (!proposal) return res.status(404).json({ success: false, error: 'Proposal not found.' });
  if (proposal.status !== 'pending') {
    return res.status(409).json({ success: false, error: `This proposal is ${proposal.status.replace('_', ' ')} and can't be approved.` });
  }
  if (!proposal.splits.some((s) => s.userId === user.uid)) {
    return res.status(403).json({ success: false, error: 'Only collaborators listed on the split sheet can approve it.' });
  }

  proposal.approvals[user.uid] = { approvedAt: Date.now(), name: user.name };
  publishServerEvent(session.id, actorOf(user), 'credits_approved', { proposalId: proposal.id });

  if (proposal.splits.every((s) => proposal.approvals[s.userId])) {
    proposal.status = 'final';
    proposal.finalizedAt = Date.now();
    try {
      const pdf = await renderSplitSheetPdf(proposal);
      proposal.pdfPath = await saveObject(`sessions/${session.id}/split-sheets/${proposal.id}.pdf`, pdf, 'application/pdf');
    } catch (e: any) {
      console.warn(`[Credits] PDF render/upload failed: ${e.message}`);
    }
    publishServerEvent(session.id, actorOf(user), 'credits_final', {
      proposalId: proposal.id,
      splits: proposal.splits.map((s) => ({ name: s.userName, percentage: s.percentage })),
    });
  }
  await reportStore.save(proposal as unknown as StoredReport);
  res.json({ success: true, proposal });
});

/** POST /agents/credits/:id/request-changes { sessionId, comment } */
agentsRouter.post('/credits/:id/request-changes', requireAuth, requireMember, async (req, res) => {
  const { user, session } = req as Req;
  const comment = typeof req.body?.comment === 'string' ? req.body.comment.trim().slice(0, 500) : '';
  if (!comment) return res.status(400).json({ success: false, error: 'Say what should change.' });
  const proposal = await getProposal(session.id, String(req.params.id));
  if (!proposal) return res.status(404).json({ success: false, error: 'Proposal not found.' });
  if (proposal.status !== 'pending') return res.status(409).json({ success: false, error: `This proposal is ${proposal.status}.` });

  proposal.status = 'changes_requested';
  proposal.approvals = {}; // any change invalidates earlier approvals
  proposal.changeRequests.push({ uid: user.uid, name: user.name, comment, at: Date.now() });
  await reportStore.save(proposal as unknown as StoredReport);
  publishServerEvent(session.id, actorOf(user), 'credits_changes_requested', { proposalId: proposal.id, comment });
  res.json({ success: true, proposal });
});

/** GET /agents/credits/:id/pdf?sessionId=.. — final sheets only (drafts can be previewed with ?draft=1). */
agentsRouter.get('/credits/:id/pdf', requireAuth, requireMember, async (req, res) => {
  const { session } = req as Req;
  const proposal = await getProposal(session.id, String(req.params.id));
  if (!proposal) return res.status(404).json({ success: false, error: 'Proposal not found.' });
  if (proposal.status !== 'final' && req.query.draft !== '1') {
    return res.status(409).json({ success: false, error: 'The split sheet is not final yet. Every collaborator must approve it first.' });
  }
  const pdf = await renderSplitSheetPdf(proposal);
  const safe = proposal.songTitle.replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'split-sheet';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${safe} - split sheet.pdf"`);
  res.send(pdf);
});
