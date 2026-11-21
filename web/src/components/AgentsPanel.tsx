'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, CircleAlert, Download, FileText, Loader2, Music, Play, Sparkles, Square, Upload, Wand2,
} from 'lucide-react';
import type { AppUser } from '@/lib/auth-context';
import {
  approveCredits, downloadSplitSheet, getAgentStatus, listReports, proposeCredits, requestCreditChanges, uploadMix,
  type CreditsProposal, type MixCheck, type MixReport,
} from '@/lib/api';
import type { BeatJamState } from '@/lib/useSessionPresence';

interface Props {
  user: AppUser;
  sessionId: string;
  /** bumps whenever a mix_report / credits_* event arrives, to refresh lists */
  refreshKey: number;
  beatJam: BeatJamState;
  send: (msg: Record<string, unknown>) => boolean;
  connected: boolean;
}

const card = 'p-5 rounded-2xl bg-surface border border-surface-highlight';
const btn = 'px-3 py-2 rounded-lg text-sm font-semibold inline-flex items-center gap-1.5 transition disabled:opacity-40';

function StatusBadge({ status }: { status: MixCheck['status'] }) {
  const map = {
    ok: { cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30', Icon: CheckCircle2, label: 'OK' },
    warning: { cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30', Icon: AlertTriangle, label: 'Warning' },
    problem: { cls: 'text-red-300 bg-red-500/10 border-red-500/30', Icon: CircleAlert, label: 'Fix' },
  }[status];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-bold ${map.cls}`}>
      <map.Icon className="w-3 h-3" aria-hidden /> {map.label}
    </span>
  );
}

function MixReportCard({ r }: { r: MixReport }) {
  const d = r.diagnosis;
  const m = r.metrics;
  const checks: Array<[string, MixCheck]> = [
    ['Clipping', d.checks.clipping],
    ['Loudness', d.checks.loudness],
    ['Frequency masking', d.checks.frequencyMasking],
    ['Stereo', d.checks.stereo],
  ];
  return (
    <article className="p-4 rounded-xl bg-background border border-surface-highlight">
      <header className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
        <h4 className="text-sm font-bold text-white break-all">{r.fileName}</h4>
        <span className="text-xs text-gray-500">
          {r.createdBy.name} · {new Date(r.createdAt).toLocaleString()} · score{' '}
          <strong className="text-white">{d.overallScore}/100</strong>
        </span>
      </header>
      <p className="text-sm text-gray-300 mb-3">{d.summary}</p>
      {m ? (
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4 text-center">
          {[
            ['Loudness', `${m.integratedLufs} LUFS`],
            ['True peak', `${m.truePeakDbfs} dBTP`],
            ['Clipped regions', `${m.clippedRegions}`],
            ['Stereo corr.', m.stereoCorrelation === null ? 'mono' : `${m.stereoCorrelation}`],
          ].map(([k, v]) => (
            <div key={k} className="p-2 rounded-lg bg-surface border border-surface-highlight">
              <dt className="text-[11px] text-gray-500">{k}</dt>
              <dd className="text-sm font-bold text-white tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-xs text-amber-300 mb-3">No exact measurements: {r.metricsError}</p>
      )}
      <ul className="space-y-3">
        {checks.map(([label, c]) => (
          <li key={label} className="text-sm">
            <div className="flex items-center gap-2 mb-0.5">
              <StatusBadge status={c.status} />
              <span className="font-semibold text-white">{label}</span>
            </div>
            <p className="text-gray-300">{c.finding}</p>
            {c.status !== 'ok' && <p className="text-indigo-200 mt-0.5"><strong>Fix:</strong> {c.fix}</p>}
          </li>
        ))}
        {d.otherIssues.map((i, n) => (
          <li key={n} className="text-sm">
            <div className="flex items-center gap-2 mb-0.5">
              <StatusBadge status={i.severity === 'high' ? 'problem' : 'warning'} />
              <span className="font-semibold text-white">{i.title}</span>
              {i.timestamp && <span className="text-xs text-gray-500">@ {i.timestamp}</span>}
            </div>
            <p className="text-gray-300">{i.finding}</p>
            <p className="text-indigo-200 mt-0.5"><strong>Fix:</strong> {i.fix}</p>
          </li>
        ))}
      </ul>
      {d.strengths.length > 0 && (
        <p className="mt-3 text-xs text-emerald-300">Strengths: {d.strengths.join(' · ')}</p>
      )}
      <p className="mt-3 text-[11px] text-gray-500">Measurements by DownBeat DSP; diagnosis by Google {r.model}. AI advice can be wrong — trust your ears.</p>
    </article>
  );
}

export function AgentsPanel({ user, sessionId, refreshKey, beatJam, send, connected }: Props) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [mixReports, setMixReports] = useState<MixReport[]>([]);
  const [proposals, setProposals] = useState<CreditsProposal[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jamPrompt, setJamPrompt] = useState('');
  const [changeComment, setChangeComment] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [m, c] = await Promise.all([
        listReports<MixReport>(user, sessionId, 'mix_doctor'),
        listReports<CreditsProposal>(user, sessionId, 'credits'),
      ]);
      setMixReports(m);
      setProposals(c);
    } catch (e: any) {
      setError(e.message);
    }
  }, [user, sessionId]);

  useEffect(() => {
    getAgentStatus(user).then((s) => setConfigured(s.geminiConfigured)).catch(() => setConfigured(null));
  }, [user]);
  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const current = proposals.find((p) => p.status !== 'superseded');
  const iAmListed = current?.splits.some((s) => s.userId === user.uid);
  const iApproved = current ? Boolean(current.approvals[user.uid]) : false;

  return (
    <section className="mt-6 space-y-6" aria-labelledby="agents-heading">
      <h2 id="agents-heading" className="text-lg font-bold text-white flex items-center gap-2">
        <Sparkles className="w-5 h-5 text-indigo-300" aria-hidden /> Google AI agents
      </h2>

      {configured === false && (
        <div className="p-3 rounded-xl border border-amber-500/30 bg-amber-500/10 text-sm text-amber-200">
          The server has no <code>GEMINI_API_KEY</code>, so the agents can&apos;t run yet.
        </div>
      )}
      {error && (
        <div role="alert" className="p-3 rounded-xl border border-red-500/30 bg-red-500/10 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Beat Jam */}
      <div className={card}>
        <h3 className="text-sm font-bold text-white mb-1 flex items-center gap-2">
          <Music className="w-4 h-4 text-indigo-300" aria-hidden /> Beat Jam (Lyria RealTime)
        </h3>
        <p className="text-xs text-gray-500 mb-3">
          One shared AI jam per session, locked to the session tempo and key. Audio plays in everyone&apos;s plugin
          (tick “Hear Beat Jam” there); anyone can steer it from here or the plugin.
        </p>
        <p className="text-sm mb-3" aria-live="polite">
          {beatJam.active ? (
            <span className="text-emerald-300">
              Playing · started by {beatJam.startedBy} · {beatJam.bpm} BPM · {beatJam.prompts.map((p) => p.text).join(' + ')}
            </span>
          ) : beatJam.status === 'connecting' ? (
            <span className="text-gray-300">Connecting to Lyria…</span>
          ) : beatJam.error ? (
            <span className="text-red-300">{beatJam.error}</span>
          ) : (
            <span className="text-gray-400">Not playing.</span>
          )}
        </p>
        <form
          className="flex flex-col sm:flex-row gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const prompt = jamPrompt.trim();
            if (!prompt) return;
            if (send({ type: beatJam.active ? 'beatjam_steer' : 'beatjam_start', prompt })) setJamPrompt('');
          }}
        >
          <label htmlFor="jam-prompt" className="sr-only">Beat Jam prompt</label>
          <input
            id="jam-prompt"
            value={jamPrompt}
            onChange={(e) => setJamPrompt(e.target.value)}
            maxLength={200}
            placeholder={beatJam.active ? 'Steer it: darker, add hi-hats, half-time…' : 'e.g. dusty boom-bap drums with warm Rhodes'}
            className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-background border border-gray-700 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:border-indigo-500"
          />
          <div className="flex gap-2">
            <button type="submit" disabled={!connected || !jamPrompt.trim()} className={`${btn} bg-indigo-600 hover:bg-indigo-500 text-white`}>
              <Play className="w-4 h-4" aria-hidden /> {beatJam.active ? 'Steer' : 'Start'}
            </button>
            <button
              type="button"
              disabled={!connected || !beatJam.active}
              onClick={() => send({ type: 'beatjam_stop' })}
              className={`${btn} bg-surface-highlight hover:bg-gray-800 text-gray-100 border border-gray-700`}
            >
              <Square className="w-4 h-4" aria-hidden /> Stop
            </button>
          </div>
        </form>
      </div>

      {/* Mix Doctor */}
      <div className={card}>
        <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Wand2 className="w-4 h-4 text-emerald-300" aria-hidden /> Mix Doctor (Gemini)
            </h3>
            <p className="text-xs text-gray-500 mt-1">
              Upload a bounce (WAV gives exact LUFS / true-peak / phase measurements; MP3, FLAC, OGG, AAC, AIFF also work). Max 20 MB, or use
              “Analyze 30 s” in the plugin.
            </p>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept="audio/*,.wav,.mp3,.flac,.ogg,.aac,.aiff,.m4a"
            className="sr-only"
            id="mix-file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              if (f.size > 20 * 1024 * 1024) return setError('That file is over 20 MB. Bounce a shorter section or use MP3.');
              run('mix', () => uploadMix(user, sessionId, f));
            }}
          />
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => fileInput.current?.click()}
            className={`${btn} bg-emerald-600 hover:bg-emerald-500 text-white`}
          >
            {busy === 'mix' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Upload className="w-4 h-4" aria-hidden />}
            {busy === 'mix' ? 'Analyzing…' : 'Upload mix'}
          </button>
        </div>
        {mixReports.length === 0 ? (
          <p className="text-sm text-gray-500">No reports yet.</p>
        ) : (
          <div className="space-y-4">
            {mixReports.slice(0, 5).map((r) => <MixReportCard key={r.id} r={r} />)}
          </div>
        )}
      </div>

      {/* Credits */}
      <div className={card}>
        <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <FileText className="w-4 h-4 text-cyan-300" aria-hidden /> Credits Agent (Gemini)
            </h3>
            <p className="text-xs text-gray-500 mt-1">
              Proposes splits from the session log. It only becomes final when every collaborator approves; then you can
              download the split-sheet PDF (with AI-use disclosure).
            </p>
          </div>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => run('propose', () => proposeCredits(user, sessionId, current?.status === 'changes_requested' ? current.changeRequests.at(-1)?.comment : undefined))}
            className={`${btn} bg-cyan-600 hover:bg-cyan-500 text-white`}
          >
            {busy === 'propose' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Sparkles className="w-4 h-4" aria-hidden />}
            {current ? 'Draft again' : 'Propose splits'}
          </button>
        </div>

        {!current ? (
          <p className="text-sm text-gray-500">No proposal yet.</p>
        ) : (
          <div>
            <p className="text-sm mb-3">
              Status:{' '}
              <strong className={current.status === 'final' ? 'text-emerald-300' : current.status === 'pending' ? 'text-amber-300' : 'text-red-300'}>
                {current.status === 'final' ? 'Final — approved by everyone' : current.status === 'pending' ? 'Awaiting approval' : 'Changes requested'}
              </strong>
            </p>
            <p className="text-sm text-gray-300 mb-3">{current.sessionOverview}</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">Proposed splits</caption>
                <thead>
                  <tr className="text-left text-xs text-gray-500">
                    <th className="py-1 pr-3 font-semibold">Collaborator</th>
                    <th className="py-1 pr-3 font-semibold">Role</th>
                    <th className="py-1 pr-3 font-semibold text-right">Share</th>
                    <th className="py-1 font-semibold">Approved</th>
                  </tr>
                </thead>
                <tbody>
                  {current.splits.map((s) => (
                    <tr key={s.userId} className="border-t border-surface-highlight align-top">
                      <td className="py-2 pr-3 text-white">{s.userName}</td>
                      <td className="py-2 pr-3 text-gray-300">
                        {s.role}
                        <div className="text-xs text-gray-500 mt-0.5">{s.reasoning}</div>
                      </td>
                      <td className="py-2 pr-3 text-right font-bold text-white tabular-nums">{s.percentage}%</td>
                      <td className="py-2 text-gray-300">{current.approvals[s.userId] ? '✓' : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {current.caveats.length > 0 && (
              <ul className="mt-3 text-xs text-amber-200 list-disc pl-5 space-y-0.5">
                {current.caveats.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            )}
            <p className="mt-3 text-xs text-gray-400"><strong>AI-use disclosure:</strong> {current.aiDisclosure}</p>
            {current.changeRequests.length > 0 && (
              <p className="mt-2 text-xs text-red-200">
                Change requested by {current.changeRequests.at(-1)!.name}: “{current.changeRequests.at(-1)!.comment}”
              </p>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              {current.status === 'pending' && iAmListed && !iApproved && (
                <button type="button" disabled={busy !== null} onClick={() => run('approve', () => approveCredits(user, sessionId, current.id))} className={`${btn} bg-emerald-600 hover:bg-emerald-500 text-white`}>
                  <CheckCircle2 className="w-4 h-4" aria-hidden /> Approve my share
                </button>
              )}
              {current.status === 'final' ? (
                <button type="button" onClick={() => run('pdf', () => downloadSplitSheet(user, sessionId, current.id))} className={`${btn} bg-indigo-600 hover:bg-indigo-500 text-white`}>
                  <Download className="w-4 h-4" aria-hidden /> Download split sheet (PDF)
                </button>
              ) : (
                <button type="button" onClick={() => run('pdf', () => downloadSplitSheet(user, sessionId, current.id, true))} className={`${btn} bg-surface-highlight hover:bg-gray-800 text-gray-100 border border-gray-700`}>
                  <Download className="w-4 h-4" aria-hidden /> Preview draft PDF
                </button>
              )}
            </div>

            {current.status === 'pending' && iAmListed && (
              <form
                className="mt-3 flex flex-col sm:flex-row gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const c = changeComment.trim();
                  if (c) run('changes', () => requestCreditChanges(user, sessionId, current.id, c)).then(() => setChangeComment(''));
                }}
              >
                <label htmlFor="changes" className="sr-only">Request changes</label>
                <input
                  id="changes"
                  value={changeComment}
                  onChange={(e) => setChangeComment(e.target.value)}
                  maxLength={500}
                  placeholder="Disagree? e.g. “I also wrote the chorus melody”"
                  className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-background border border-gray-700 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:border-indigo-500"
                />
                <button type="submit" disabled={busy !== null || !changeComment.trim()} className={`${btn} bg-surface-highlight hover:bg-gray-800 text-gray-100 border border-gray-700`}>
                  Request changes
                </button>
              </form>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
