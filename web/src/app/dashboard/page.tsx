'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import Link from 'next/link';
import { Radio, Plus, Sliders, FileText, LogIn, Loader2, X, Copy, Check, Users } from 'lucide-react';
import { listSessions, createSession, joinSession, type SessionData } from '@/lib/api';
import { DevicesPanel } from '@/components/DevicesPanel';

const KEYS = ['C maj', 'C min', 'D maj', 'D min', 'E maj', 'E min', 'F maj', 'F min', 'G maj', 'G min', 'A maj', 'A min', 'B maj', 'B min'];

function CopyCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(code);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      title="Copy invite code"
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 text-xs font-mono font-bold hover:bg-indigo-500/20 transition"
    >
      {code}
      {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

export default function DashboardPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionData[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'sessions' | 'mix-doctor' | 'credits'>('sessions');

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newBpm, setNewBpm] = useState(120);
  const [newKey, setNewKey] = useState('C min');
  const [creating, setCreating] = useState(false);

  const [joinCode, setJoinCode] = useState('');
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) router.replace('/login');
  }, [authLoading, user, router]);

  const refresh = useCallback(async () => {
    if (!user) return;
    setLoadingSessions(true);
    try {
      setSessions(await listSessions(user));
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoadingSessions(false);
    }
  }, [user]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleCreate = async () => {
    if (!user) return;
    setCreating(true);
    try {
      const s = await createSession(user, { name: newName.trim(), bpm: newBpm, keySignature: newKey });
      setShowCreate(false);
      setNewName('');
      router.push(`/session?id=${s.id}`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setCreating(false);
    }
  };

  const handleJoin = async () => {
    if (!user || joinCode.trim().length < 4) return;
    setJoining(true);
    try {
      const s = await joinSession(user, joinCode);
      setJoinCode('');
      router.push(`/session?id=${s.id}`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setJoining(false);
    }
  };

  if (authLoading || !user) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading...
      </div>
    );
  }

  return (
    <div className="flex-1 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 w-full">
      {/* Top Banner */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">Session Dashboard</h1>
          <p className="text-sm text-gray-400 mt-1">Welcome back, {user.displayName || user.email}</p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/link"
            className="px-4 py-2 rounded-xl bg-surface-highlight hover:bg-gray-800 border border-gray-700 text-sm font-semibold text-gray-200 transition"
          >
            Pair New DAW
          </Link>
          <button
            onClick={() => setShowCreate(true)}
            className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-sm font-semibold text-white shadow-md shadow-indigo-600/30 flex items-center gap-2 transition"
          >
            <Plus className="w-4 h-4" />
            New Session
          </button>
        </div>
      </div>

      {/* Join by invite code */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleJoin();
        }}
        className="flex flex-col sm:flex-row gap-3 mb-6 p-4 rounded-2xl bg-surface border border-surface-highlight"
      >
        <div className="flex-1">
          <label htmlFor="join-code" className="block text-xs font-semibold text-gray-400 mb-1">
            Join a collaborator&apos;s session
          </label>
          <input
            id="join-code"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            placeholder="Invite code, e.g. DB-7K9A"
            maxLength={8}
            className="w-full px-3 py-2 rounded-lg bg-background border border-gray-700 text-white font-mono placeholder:font-sans placeholder:text-gray-500 focus:outline-none focus:border-indigo-500"
          />
        </div>
        <button
          type="submit"
          disabled={joining || joinCode.trim().length < 4}
          className="self-end px-4 py-2 rounded-lg bg-surface-highlight hover:bg-gray-800 border border-gray-700 text-sm font-semibold text-gray-100 disabled:opacity-40 flex items-center gap-2 transition"
        >
          {joining ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
          Join
        </button>
      </form>

      {error && (
        <div className="mb-6 p-3 rounded-xl border border-red-500/30 bg-red-500/10 text-sm text-red-300 flex items-start justify-between gap-4">
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss" className="text-red-300 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={() => setShowCreate(false)}>
          <div className="w-full max-w-md p-6 rounded-2xl bg-surface border border-surface-highlight shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-bold text-white">New Session</h2>
              <button onClick={() => setShowCreate(false)} aria-label="Close" className="text-gray-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label htmlFor="s-name" className="block text-xs font-semibold text-gray-400 mb-1">Name</label>
                <input
                  id="s-name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Late night jam"
                  maxLength={80}
                  className="w-full px-3 py-2 rounded-lg bg-background border border-gray-700 text-white focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="s-bpm" className="block text-xs font-semibold text-gray-400 mb-1">Tempo (BPM)</label>
                  <input
                    id="s-bpm"
                    type="number"
                    min={20}
                    max={999}
                    value={newBpm}
                    onChange={(e) => setNewBpm(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-lg bg-background border border-gray-700 text-white focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label htmlFor="s-key" className="block text-xs font-semibold text-gray-400 mb-1">Key</label>
                  <select
                    id="s-key"
                    value={newKey}
                    onChange={(e) => setNewKey(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-background border border-gray-700 text-white focus:outline-none focus:border-indigo-500"
                  >
                    {KEYS.map((k) => (
                      <option key={k}>{k}</option>
                    ))}
                  </select>
                </div>
              </div>
              <button
                onClick={handleCreate}
                disabled={creating || newBpm < 20 || newBpm > 999}
                className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-sm font-semibold text-white disabled:opacity-50 flex items-center justify-center gap-2 transition"
              >
                {creating && <Loader2 className="w-4 h-4 animate-spin" />}
                Create &amp; get invite code
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-4 border-b border-surface-highlight mb-8 text-sm font-medium">
        <button
          onClick={() => setActiveTab('sessions')}
          className={`pb-3 px-1 border-b-2 transition flex items-center gap-2 ${
            activeTab === 'sessions'
              ? 'border-indigo-500 text-white'
              : 'border-transparent text-gray-400 hover:text-gray-300'
          }`}
        >
          <Radio className="w-4 h-4" />
          My Sessions ({sessions.length})
        </button>
        <button
          onClick={() => setActiveTab('mix-doctor')}
          className={`pb-3 px-1 border-b-2 transition flex items-center gap-2 ${
            activeTab === 'mix-doctor'
              ? 'border-indigo-500 text-white'
              : 'border-transparent text-gray-400 hover:text-gray-300'
          }`}
        >
          <Sliders className="w-4 h-4 text-emerald-400" />
          Mix Doctor Reports
        </button>
        <button
          onClick={() => setActiveTab('credits')}
          className={`pb-3 px-1 border-b-2 transition flex items-center gap-2 ${
            activeTab === 'credits'
              ? 'border-indigo-500 text-white'
              : 'border-transparent text-gray-400 hover:text-gray-300'
          }`}
        >
          <FileText className="w-4 h-4 text-cyan-400" />
          AI Split Sheets
        </button>
      </div>

      {/* Sessions Grid */}
      {activeTab === 'sessions' && (
        <>
          {loadingSessions && sessions.length === 0 ? (
            <div className="flex items-center text-gray-400 text-sm">
              <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading sessions...
            </div>
          ) : sessions.length === 0 ? (
            <div className="p-8 rounded-2xl border border-dashed border-gray-700 text-center max-w-xl mx-auto">
              <Users className="w-8 h-8 text-gray-500 mx-auto mb-3" />
              <h3 className="text-white font-semibold mb-1">No sessions yet</h3>
              <p className="text-sm text-gray-400">
                Create one here or from the plugin, then share the invite code with your collaborator.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {sessions.map((s) => (
                <div
                  key={s.id}
                  className="p-6 rounded-2xl bg-surface border border-surface-highlight hover:border-gray-700 transition shadow-xl flex flex-col"
                >
                  <div className="flex items-center justify-between mb-4">
                    <CopyCode code={s.inviteCode} />
                    <span className="text-xs text-gray-500">{new Date(s.updatedAt).toLocaleDateString()}</span>
                  </div>

                  <h3 className="text-lg font-bold text-white mb-2 truncate">{s.name}</h3>

                  <div className="flex items-center gap-4 text-xs text-gray-400 mb-6">
                    <span>Tempo: <strong className="text-white">{s.bpm} BPM</strong></span>
                    <span>Key: <strong className="text-white">{s.keySignature}</strong></span>
                    <span>Members: <strong className="text-white">{s.members.length}</strong></span>
                  </div>

                  <div className="mt-auto pt-4 border-t border-surface-highlight flex items-center justify-between text-xs">
                    <span className="text-gray-500 truncate">
                      {Object.values(s.memberNames || {}).join(', ')}
                    </span>
                    <Link
                      href={`/session?id=${s.id}`}
                      className="shrink-0 px-3 py-1.5 rounded-lg bg-surface-highlight hover:bg-gray-800 text-indigo-400 font-semibold transition"
                    >
                      Open
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Mix Doctor Tab */}
      {activeTab === 'mix-doctor' && (
        <div className="p-8 rounded-2xl bg-surface border border-surface-highlight text-center max-w-xl mx-auto">
          <div className="w-12 h-12 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 mx-auto mb-4">
            <Sliders className="w-6 h-6" />
          </div>
          <h3 className="text-lg font-bold text-white mb-2">Mix Doctor AI Diagnosis</h3>
          <p className="text-sm text-gray-400 mb-6">
            Upload bounced mixes or multi-track stems. Gemini will analyze true peaks, frequency masking, LUFS loudness, and phase correlation with actionable production fixes.
          </p>
          <div className="p-4 rounded-xl border border-dashed border-gray-700 bg-background text-xs text-gray-400">
            Mix Doctor runs per session: open a session and upload a bounce, or press “Analyze 30 s” in the plugin.
          </div>
        </div>
      )}

      {/* Credits Tab */}
      {activeTab === 'credits' && (
        <div className="p-8 rounded-2xl bg-surface border border-surface-highlight text-center max-w-xl mx-auto">
          <div className="w-12 h-12 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400 mx-auto mb-4">
            <FileText className="w-6 h-6" />
          </div>
          <h3 className="text-lg font-bold text-white mb-2">CRDT Split Sheet Generator</h3>
          <p className="text-sm text-gray-400 mb-6">
            The Credits Agent inspects every parameter automation, MIDI edit, and stem addition from the session CRDT log, proposing fair publishing splits with AI disclosure and PDF export.
          </p>
          <div className="p-4 rounded-xl border border-dashed border-gray-700 bg-background text-xs text-gray-400">
            Open a session to propose splits, approve them, and download the final split-sheet PDF.
          </div>
        </div>
      )}
      <DevicesPanel user={user} />
    </div>
  );
}
