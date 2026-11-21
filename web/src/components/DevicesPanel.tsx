'use client';

import { useCallback, useEffect, useState } from 'react';
import { Laptop, Loader2, ShieldOff } from 'lucide-react';
import type { AppUser } from '@/lib/auth-context';
import { listDevices, revokeDevice, type Device } from '@/lib/api';

function ago(ms: number) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

/** Plugins paired to this account, with revoke (signs that plugin out immediately). */
export function DevicesPanel({ user }: { user: AppUser }) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    listDevices(user).then(setDevices).catch((e) => setError(e.message));
  }, [user]);
  useEffect(load, [load]);

  const active = (devices ?? []).filter((d) => !d.revokedAt);

  return (
    <section className="mt-10 p-5 rounded-2xl bg-surface border border-surface-highlight" aria-labelledby="devices-heading">
      <h2 id="devices-heading" className="text-sm font-bold text-white mb-1">Paired plugins</h2>
      <p className="text-xs text-gray-500 mb-4">DAW plugins signed in to your account. Revoke one if a laptop is lost or shared.</p>
      {error && <p role="alert" className="text-sm text-red-300 mb-3">{error}</p>}
      {devices === null ? (
        <p className="text-sm text-gray-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</p>
      ) : active.length === 0 ? (
        <p className="text-sm text-gray-500">No plugins paired. Click “Sign in” in the DownBeat plugin to pair one.</p>
      ) : (
        <ul className="divide-y divide-surface-highlight">
          {active.map((d) => (
            <li key={d.deviceId} className="flex items-center gap-3 py-3">
              <Laptop className="w-4 h-4 text-indigo-300 shrink-0" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-white truncate">{d.label}</p>
                <p className="text-xs text-gray-500">Paired {ago(d.pairedAt)} · last used {ago(d.lastUsedAt)}</p>
              </div>
              <button
                type="button"
                disabled={busy !== null}
                onClick={async () => {
                  if (!confirm(`Sign out "${d.label}"? It will need to be paired again.`)) return;
                  setBusy(d.deviceId);
                  try {
                    await revokeDevice(user, d.deviceId);
                    load();
                  } catch (e: any) {
                    setError(e.message);
                  } finally {
                    setBusy(null);
                  }
                }}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold text-red-300 border border-red-500/30 hover:bg-red-500/10 inline-flex items-center gap-1.5 disabled:opacity-40"
              >
                {busy === d.deviceId ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldOff className="w-3.5 h-3.5" />}
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
