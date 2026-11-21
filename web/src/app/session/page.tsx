'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Copy, Check, Loader2, Laptop, Globe, Wifi, WifiOff, Activity, Music2, Gauge, LogIn, LogOut, VolumeX, Volume2, SlidersHorizontal, PenLine, Send } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { getSession, getEvents, getContributions, type SessionData, type SessionEvent, type UserContribution } from '@/lib/api';
import { useSessionPresence } from '@/lib/useSessionPresence';
import { AgentsPanel } from '@/components/AgentsPanel';

function first(name: string) {
  return name.split(' ')[0] || name;
}

/** Human-readable line + icon for one log entry. */
function describe(e: SessionEvent): { text: string; Icon: typeof Activity; tone: string } {
  const who = first(e.userName);
  const p = e.payload || {};
  switch (e.type) {
    case 'session_join':
      return { text: `${who} joined (${p.daw || p.client})`, Icon: LogIn, tone: 'text-emerald-300' };
    case 'session_leave':
      return { text: `${who} left`, Icon: LogOut, tone: 'text-gray-400' };
    case 'tempo_change':
      return { text: `${who} changed tempo ${p.previousBpm ? `${p.previousBpm} → ` : 'to '}${p.bpm} BPM`, Icon: Gauge, tone: 'text-amber-300' };
    case 'audio_activity':
      return { text: `${who} played ${Math.round(p.activeSeconds)}s of audio (peak ${p.peakDb} dB)`, Icon: Activity, tone: 'text-indigo-300' };
    case 'midi_activity':
      return { text: `${who} played ${p.notes} MIDI notes`, Icon: Music2, tone: 'text-cyan-300' };
    case 'send_mute':
      return { text: `${who} ${p.muted ? 'muted' : 'unmuted'} their send`, Icon: p.muted ? VolumeX : Volume2, tone: 'text-gray-300' };
    case 'param_change':
      return { text: `${who} set ${p.param} to ${p.value}`, Icon: SlidersHorizontal, tone: 'text-gray-300' };
    case 'contribution_note':
      return { text: `${who}: “${p.text}”`, Icon: PenLine, tone: 'text-white' };
    case 'beat_jam':
      return {
        text: p.action === 'start' ? `${who} started Beat Jam: “${p.prompt}”` : p.action === 'steer' ? `${who} steered Beat Jam: “${p.prompt}”` : `${who} stopped Beat Jam`,
        Icon: Music2, tone: 'text-purple-300',
      };
    case 'mix_report':
      return { text: `${who} ran Mix Doctor on ${p.fileName} (score ${p.score})`, Icon: Activity, tone: 'text-emerald-300' };
    case 'credits_proposed':
      return { text: `${who} asked the Credits Agent for a split proposal`, Icon: PenLine, tone: 'text-cyan-300' };
    case 'credits_approved':
      return { text: `${who} approved the split sheet`, Icon: PenLine, tone: 'text-cyan-300' };
    case 'credits_changes_requested':
      return { text: `${who} requested changes: “${p.comment}”`, Icon: PenLine, tone: 'text-red-300' };
    case 'credits_final':
      return { text: `Split sheet is final`, Icon: PenLine, tone: 'text-emerald-300' };
    default:
      return { text: `${who}: ${e.type}`, Icon: Activity, tone: 'text-gray-300' };
  }
}

function formatSeconds(s: number) {
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`;
}

function SessionContent() {
  const params = useSearchParams();
  const sessionId = params.get('id');
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [session, setSession] = useState<SessionData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) router.replace('/login');
  }, [authLoading, user, router]);

  useEffect(() => {
    if (!user || !sessionId) return;
    getSession(user, sessionId)
      .then(setSession)
      .catch((e) => setLoadError(e.message));
  }, [user, sessionId]);

  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [contributions, setContributions] = useState<UserContribution[]>([]);
  const [note, setNote] = useState('');
  const [agentsRefresh, setAgentsRefresh] = useState(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refreshLog = useCallback(async () => {
    if (!user || !sessionId) return;
    try {
      const [ev, c] = await Promise.all([getEvents(user, sessionId, 100), getContributions(user, sessionId)]);
      setEvents(ev.events);
      setContributions(c);
    } catch {
      /* shown via loadError / socket status */
    }
  }, [user, sessionId]);

  useEffect(() => {
    if (session) refreshLog();
  }, [session, refreshLog]);

  // Live events: append immediately, refresh the rollup at most once a second
  const onEvent = useCallback(
    (e: SessionEvent) => {
      setEvents((prev) => (prev.some((x) => x.id === e.id) ? prev : [...prev, e].slice(-100)));
      if (e.type === 'mix_report' || e.type.startsWith('credits_')) setAgentsRefresh((n) => n + 1);
      clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(refreshLog, 1000);
    },
    [refreshLog]
  );

  const { online, status, error: socketError, sendEvent, beatJam, send } = useSessionPresence(session ? user : null, session?.id ?? null, onEvent);

  const submitNote = () => {
    const text = note.trim();
    if (!text) return;
    if (sendEvent('contribution_note', { text })) {
      setNote('');
      // the server doesn't echo our own event back; refetch once it has been stored
      setTimeout(refreshLog, 400);
    }
  };

  if (!sessionId) return <p className="p-10 text-gray-400">No session selected.</p>;
  if (loadError) {
    return (
      <div className="p-10 max-w-xl mx-auto text-center">
        <p className="text-red-300 mb-4">{loadError}</p>
        <Link href="/dashboard" className="text-indigo-400 hover:underline">Back to dashboard</Link>
      </div>
    );
  }
  if (!session || !user) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading session...
      </div>
    );
  }

  const onlineIds = new Set(online.map((p) => p.userId));
  const offlineMembers = session.members.filter((uid) => !onlineIds.has(uid));

  const statusChip = {
    connected: { text: 'Live', cls: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10', Icon: Wifi },
    connecting: { text: 'Connecting...', cls: 'text-gray-300 border-gray-600 bg-gray-500/10', Icon: Wifi },
    reconnecting: { text: 'Reconnecting...', cls: 'text-amber-300 border-amber-500/30 bg-amber-500/10', Icon: WifiOff },
    error: { text: socketError || 'Disconnected', cls: 'text-red-300 border-red-500/30 bg-red-500/10', Icon: WifiOff },
  }[status];

  return (
    <div className="flex-1 max-w-4xl mx-auto px-4 sm:px-6 py-10 w-full">
      <Link href="/dashboard" className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-white mb-6">
        <ArrowLeft className="w-4 h-4" /> Dashboard
      </Link>

      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-8">
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight break-words">{session.name}</h1>
          <p className="text-sm text-gray-400 mt-1">
            {session.bpm} BPM · {session.keySignature} · created by {session.ownerName}
          </p>
        </div>
        <span className={`self-start inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-semibold ${statusChip.cls}`}>
          <statusChip.Icon className="w-3.5 h-3.5" /> {statusChip.text}
        </span>
      </div>

      {/* Invite */}
      <div className="p-5 rounded-2xl bg-surface border border-surface-highlight mb-6">
        <p className="text-xs font-semibold text-gray-400 mb-2">Invite code: enter this in the DownBeat plugin or on the dashboard</p>
        <div className="flex items-center gap-3">
          <span className="text-3xl font-mono font-extrabold tracking-widest text-indigo-300">{session.inviteCode}</span>
          <button
            onClick={() => {
              navigator.clipboard?.writeText(session.inviteCode);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="px-3 py-1.5 rounded-lg bg-surface-highlight hover:bg-gray-800 text-sm text-gray-200 inline-flex items-center gap-1.5"
          >
            {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>

      {/* Presence */}
      <div className="p-5 rounded-2xl bg-surface border border-surface-highlight">
        <h2 className="text-sm font-bold text-white mb-4">
          Online now <span className="text-gray-500 font-normal">({online.length})</span>
        </h2>
        <ul className="space-y-2" aria-live="polite">
          {online.map((p) => (
            <li key={p.connectionId} className="flex items-center gap-3 p-3 rounded-xl bg-background border border-surface-highlight">
              <span className="w-2 h-2 rounded-full bg-emerald-400" aria-hidden />
              {p.client === 'plugin' ? <Laptop className="w-4 h-4 text-indigo-300" /> : <Globe className="w-4 h-4 text-cyan-300" />}
              <span className="text-sm text-white font-semibold">
                {p.userName}
                {p.userId === user.uid && <span className="text-gray-500 font-normal"> (you)</span>}
              </span>
              <span className="ml-auto text-xs text-gray-400 truncate">{p.daw}</span>
            </li>
          ))}
          {offlineMembers.map((uid) => (
            <li key={uid} className="flex items-center gap-3 p-3 rounded-xl border border-dashed border-surface-highlight opacity-60">
              <span className="w-2 h-2 rounded-full bg-gray-600" aria-hidden />
              <span className="text-sm text-gray-300">{session.memberNames?.[uid] || uid}</span>
              <span className="ml-auto text-xs text-gray-500">offline</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Contributions */}
      <div className="mt-6 p-5 rounded-2xl bg-surface border border-surface-highlight">
        <h2 className="text-sm font-bold text-white mb-1">Who did what</h2>
        <p className="text-xs text-gray-500 mb-4">
          Measured by the DownBeat plugin (audio sent, MIDI through its track, tempo changes) plus notes people log. The
          Credits Agent uses this to propose splits.
        </p>
        {contributions.length === 0 ? (
          <p className="text-sm text-gray-500">Nothing logged yet.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {contributions.map((c) => (
              <div key={c.userId} className="p-4 rounded-xl bg-background border border-surface-highlight min-w-0">
                <div className="text-sm font-semibold text-white mb-2 truncate">
                  {c.userName}
                  {c.userId === user.uid && <span className="text-gray-500 font-normal"> (you)</span>}
                </div>
                <dl className="grid grid-cols-3 gap-2 text-center mb-3">
                  <div>
                    <dt className="text-[11px] text-gray-500">Audio played</dt>
                    <dd className="text-sm font-bold text-indigo-300">{formatSeconds(c.audioActiveSeconds)}</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] text-gray-500">MIDI notes</dt>
                    <dd className="text-sm font-bold text-cyan-300">{c.midiNotes}</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] text-gray-500">Tempo changes</dt>
                    <dd className="text-sm font-bold text-amber-300">{c.tempoChanges}</dd>
                  </div>
                </dl>
                {c.notes.length > 0 && (
                  <ul className="space-y-1 text-xs text-gray-300">
                    {c.notes.slice(-5).map((n, i) => (
                      <li key={i} className="break-words">“{n}”</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitNote();
          }}
          className="mt-4 flex gap-2"
        >
          <label htmlFor="note" className="sr-only">Log a contribution</label>
          <input
            id="note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={280}
            placeholder="Log what you did, e.g. wrote the verse lyrics"
            className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-background border border-gray-700 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:border-indigo-500"
          />
          <button
            type="submit"
            disabled={!note.trim() || status !== 'connected'}
            className="px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-sm font-semibold text-white disabled:opacity-40 inline-flex items-center gap-1.5"
          >
            <Send className="w-4 h-4" /> Log
          </button>
        </form>
      </div>

      <AgentsPanel
        user={user}
        sessionId={session.id}
        refreshKey={agentsRefresh}
        beatJam={beatJam}
        send={send}
        connected={status === 'connected'}
      />

      {/* Activity feed */}
      <div className="mt-6 p-5 rounded-2xl bg-surface border border-surface-highlight">
        <h2 className="text-sm font-bold text-white mb-4">
          Session log <span className="text-gray-500 font-normal">({events.length})</span>
        </h2>
        {events.length === 0 ? (
          <p className="text-sm text-gray-500">No events yet.</p>
        ) : (
          <ol className="space-y-1.5 max-h-96 overflow-y-auto pr-1" aria-live="polite">
            {[...events].reverse().map((e) => {
              const d = describe(e);
              return (
                <li key={e.id} className="flex items-start gap-3 text-sm">
                  <time className="shrink-0 w-12 text-xs text-gray-500 tabular-nums pt-0.5">
                    {new Date(e.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </time>
                  <d.Icon className={`shrink-0 w-4 h-4 mt-0.5 ${d.tone}`} aria-hidden />
                  <span className={`min-w-0 break-words ${d.tone}`}>{d.text}</span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}

export default function SessionPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-gray-400">Loading...</div>}>
      <SessionContent />
    </Suspense>
  );
}
