'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth, DEV_LOGIN_ENABLED } from '@/lib/auth-context';
import { KeyRound, CheckCircle2, AlertCircle, Laptop, ArrowRight, Zap, Sparkles, ClipboardPaste } from 'lucide-react';

function PairingContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const codeParam = searchParams.get('code') || '';

  const [code, setCode] = useState('');
  const { user, signInWithGoogle, signInAsDevUser, loading: authLoading } = useAuth();
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  // Synchronize code from URL query parameters or window.location on mount
  useEffect(() => {
    let resolvedCode = codeParam;

    if (!resolvedCode && typeof window !== 'undefined') {
      const urlParams = new URLSearchParams(window.location.search);
      resolvedCode = urlParams.get('code') || '';
    }

    if (!resolvedCode && typeof window !== 'undefined') {
      resolvedCode = sessionStorage.getItem('downbeat_pending_code') || '';
    }

    if (resolvedCode) {
      const clean = resolvedCode.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      setCode(clean);
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('downbeat_pending_code', clean);
      }
    }
  }, [codeParam]);

  const handlePasteClipboard = async () => {
    try {
      if (navigator.clipboard) {
        const text = await navigator.clipboard.readText();
        if (text) {
          const clean = text.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
          setCode(clean);
        }
      }
    } catch (e) {
      // Clipboard access denied
    }
  };

  const handlePair = async () => {
    const cleanCode = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

    if (!cleanCode || cleanCode.length !== 6) {
      setErrorMessage('Please enter a valid 6-character pairing code.');
      setStatus('error');
      return;
    }

    if (!user) {
      setErrorMessage('Please sign in first before confirming device pairing.');
      setStatus('error');
      return;
    }

    try {
      setLoading(true);
      setStatus('idle');
      setErrorMessage('');

      const idToken = await user.getIdToken();
      const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || 'http://localhost:8088';

      const response = await fetch(`${serverUrl}/auth/pair/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: cleanCode, idToken }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to confirm device pairing');
      }

      // Clear pending code on successful pairing
      if (typeof window !== 'undefined') {
        sessionStorage.removeItem('downbeat_pending_code');
      }

      setStatus('success');
    } catch (err: any) {
      setStatus('error');
      setErrorMessage(err.message || 'Failed to pair device');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg p-8 rounded-2xl bg-surface border border-surface-highlight shadow-2xl">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
            <KeyRound className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-white">Pair DownBeat DAW Plugin</h2>
            <p className="text-xs text-gray-400">Link your Ableton, Logic, or FL Studio instance</p>
          </div>
        </div>

        {status === 'success' ? (
          <div className="text-center py-6">
            <div className="w-16 h-16 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center mx-auto mb-4">
              <CheckCircle2 className="w-8 h-8" />
            </div>
            <h3 className="text-lg font-bold text-white mb-2">Plugin Successfully Paired!</h3>
            <p className="text-sm text-gray-400 mb-6 max-w-sm mx-auto">
              Your DAW plugin instance has received credentials for{' '}
              <span className="text-indigo-400 font-semibold">{user?.displayName || user?.email}</span>.
              Return to your DAW to start collaborating.
            </p>
            <button
              onClick={() => router.push('/dashboard')}
              className="px-6 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold transition text-sm shadow-md"
            >
              Go to Session Dashboard
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            {!user ? (
              <div className="p-4 rounded-xl bg-gradient-to-r from-indigo-950/60 to-purple-950/60 border border-indigo-500/30">
                <p className="text-xs text-indigo-300 font-semibold mb-2 flex items-center gap-1.5">
                  <Zap className="w-3.5 h-3.5 text-amber-400 fill-amber-400" />
                  Sign In Required to Approve Pairing
                </p>
                <p className="text-xs text-gray-300 mb-3">
                  Choose a sign-in method to authenticate this plugin instance:
                </p>
                <div className="flex flex-col sm:flex-row gap-2">
                  {DEV_LOGIN_ENABLED && (
                  <button
                    onClick={() => signInAsDevUser('Alex Beatmaker')}
                    className="flex-1 py-2 px-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs transition flex items-center justify-center gap-1.5 shadow"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    Sign in as Alex (dev)
                  </button>
                  )}
                  <button
                    onClick={() => signInWithGoogle()}
                    className="py-2 px-3 rounded-lg bg-surface-highlight hover:bg-gray-800 text-gray-200 font-semibold text-xs transition border border-gray-700 flex items-center justify-center gap-1.5"
                  >
                    Google Sign-In
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between p-3.5 rounded-xl bg-surface-highlight border border-gray-700 text-xs">
                <div className="flex items-center gap-2.5 text-gray-300">
                  <Laptop className="w-4 h-4 text-emerald-400" />
                  <span>
                    Signed in as <strong className="text-white">{user.displayName || user.email}</strong>
                  </span>
                </div>
                <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-semibold">
                  Active
                </span>
              </div>
            )}

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-semibold text-gray-300">
                  6-Character Pairing Code (from Plugin)
                </label>
                <button
                  type="button"
                  onClick={handlePasteClipboard}
                  className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1 transition"
                >
                  <ClipboardPaste className="w-3.5 h-3.5" />
                  Paste
                </button>
              </div>

              <input
                type="text"
                maxLength={6}
                value={code}
                onChange={(e) => {
                  const val = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
                  setCode(val);
                }}
                placeholder="XXXXXX"
                autoFocus
                className="w-full text-center tracking-widest text-3xl font-mono py-3.5 rounded-xl bg-background border border-gray-700 text-white focus:outline-none focus:border-indigo-500 uppercase font-bold shadow-inner placeholder-gray-600"
              />
              <p className="text-[11px] text-gray-400 text-center mt-1.5">
                {code.length === 6 ? (
                  <span className="text-emerald-400">✓ Ready to pair ({code})</span>
                ) : (
                  <span>Enter the 6 characters displayed on your DAW plugin</span>
                )}
              </p>
            </div>

            {status === 'error' && (
              <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{errorMessage}</span>
              </div>
            )}

            <button
              onClick={handlePair}
              disabled={loading || !user || code.length !== 6}
              className="w-full py-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold transition shadow-md shadow-indigo-600/30 flex items-center justify-center gap-2 text-sm"
            >
              {loading ? 'Confirming Pairing...' : 'Approve & Link Plugin'}
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function LinkPluginPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-gray-400">Loading pairing screen...</div>}>
      <PairingContent />
    </Suspense>
  );
}
