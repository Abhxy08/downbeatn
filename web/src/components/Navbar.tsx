'use client';

import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { Disc3, LogOut, User as UserIcon } from 'lucide-react';

export function Navbar() {
  const { user, signOut } = useAuth();

  return (
    <header className="border-b border-surface-highlight bg-surface/80 backdrop-blur sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-tr from-accent to-accent-neon flex items-center justify-center font-bold text-white shadow-lg">
            <Disc3 className="w-5 h-5 animate-spin-slow" />
          </div>
          <span className="text-xl font-bold tracking-tight bg-gradient-to-r from-white via-gray-200 to-indigo-300 bg-clip-text text-transparent">
            DownBeat
          </span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 font-medium">
            Google Buildathon MVP
          </span>
        </Link>

        <nav className="flex items-center gap-4 text-sm font-medium">
          <Link href="/dashboard" className="text-gray-300 hover:text-white transition">
            Dashboard
          </Link>
          <Link href="/link" className="text-gray-300 hover:text-white transition">
            Pair Plugin
          </Link>

          {user ? (
            <div className="flex items-center gap-3 pl-2 border-l border-surface-highlight">
              <span className="text-xs text-gray-300 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
                <strong className="text-white">{user.displayName || user.email}</strong>
                {user.isDevUser && (
                  <span data-dev-badge className="px-1.5 py-0.2 rounded bg-amber-500/10 text-amber-400 text-[10px] border border-amber-500/20">
                    Dev
                  </span>
                )}
              </span>
              <button
                onClick={() => signOut()}
                className="p-1.5 text-gray-400 hover:text-red-400 transition rounded-lg hover:bg-surface-highlight"
                title="Sign Out"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <Link
              href="/login"
              className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-semibold transition shadow-md shadow-indigo-600/30"
            >
              Sign In
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
