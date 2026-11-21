'use client';

import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth, DEV_LOGIN_ENABLED } from '@/lib/auth-context';
import { Lock, Mail, ArrowRight, Zap, AlertCircle, Sparkles } from 'lucide-react';

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectCode = searchParams.get('code');

  const {
    user,
    signInWithGoogle,
    signInWithEmail,
    signInAsDevUser,
    error,
    clearError,
    isFirebaseConfigured,
  } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [devName, setDevName] = useState('Alex Beatmaker');
  const [isSignUp, setIsSignUp] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSuccessRedirect = () => {
    if (redirectCode) {
      router.push(`/link?code=${redirectCode}`);
    } else {
      router.push('/dashboard');
    }
  };

  const handleGoogle = async () => {
    try {
      setLoading(true);
      await signInWithGoogle();
      handleSuccessRedirect();
    } catch (e) {
      // Handled by context
    } finally {
      setLoading(false);
    }
  };

  const handleEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    try {
      setLoading(true);
      await signInWithEmail(email, password, isSignUp);
      handleSuccessRedirect();
    } catch (e) {
      // Handled by context
    } finally {
      setLoading(false);
    }
  };

  const handleDevSignIn = (nameToUse: string) => {
    signInAsDevUser(nameToUse, `${nameToUse.toLowerCase().replace(/\s+/g, '')}@downbeat.audio`);
    handleSuccessRedirect();
  };

  return (
    <div className="flex-1 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md p-8 rounded-2xl bg-surface border border-surface-highlight shadow-2xl">
        <div className="text-center mb-6">
          <h2 className="text-2xl font-bold text-white tracking-tight">
            {isSignUp ? 'Create your Producer Account' : 'Sign in to DownBeat'}
          </h2>
          <p className="text-sm text-gray-400 mt-2">
            Connect your DAW plugin and sync live sessions with AI agents
          </p>
        </div>

        {/* Dev-only quick sign-in (NEXT_PUBLIC_ALLOW_DEV_LOGIN=true) */}
        {DEV_LOGIN_ENABLED && (
        <div className="mb-6 p-4 rounded-xl bg-gradient-to-r from-indigo-950/60 to-purple-950/60 border border-indigo-500/30">
          <div className="flex items-center gap-2 text-indigo-300 font-semibold text-xs mb-2">
            <Zap className="w-4 h-4 text-amber-400 fill-amber-400" />
            Local dev sign-in (disabled in production)
          </div>
          <p className="text-xs text-gray-300 mb-3 leading-relaxed">
            Instantly pair and authenticate your DAW plugin with a simulated Google producer identity:
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleDevSignIn('Alex Beatmaker')}
              className="flex-1 py-2 px-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs transition flex items-center justify-center gap-1.5 shadow"
            >
              <Sparkles className="w-3.5 h-3.5" />
              Sign in as Alex (Producer 1)
            </button>
            <button
              onClick={() => handleDevSignIn('Sarah Sound')}
              className="flex-1 py-2 px-3 rounded-lg bg-surface-highlight hover:bg-gray-800 text-gray-200 font-semibold text-xs transition border border-gray-700 flex items-center justify-center gap-1.5"
            >
              Sign in as Sarah (Producer 2)
            </button>
          </div>
        </div>
        )}

        {error && (
          <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-semibold">Authentication Notice</p>
              <p className="leading-relaxed">{error}</p>
            </div>
          </div>
        )}

        <button
          onClick={handleGoogle}
          disabled={loading}
          className="w-full py-3 px-4 rounded-xl bg-surface-highlight hover:bg-gray-800 border border-gray-700 text-white font-medium flex items-center justify-center gap-3 transition shadow-sm mb-6 text-sm"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24">
            <path
              fill="#4285F4"
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
            />
            <path
              fill="#34A853"
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            />
            <path
              fill="#FBBC05"
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
            />
            <path
              fill="#EA4335"
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
            />
          </svg>
          Continue with Google
        </button>

        <div className="relative my-6">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-surface-highlight"></div>
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-surface px-2 text-gray-400">Or continue with email</span>
          </div>
        </div>

        <form onSubmit={handleEmail} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-gray-300 mb-1">Email address</label>
            <div className="relative">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full px-4 py-2.5 rounded-xl bg-background border border-gray-700 text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 text-sm"
                placeholder="producer@studio.com"
              />
              <Mail className="w-4 h-4 text-gray-500 absolute right-3 top-3" />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-300 mb-1">Password</label>
            <div className="relative">
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full px-4 py-2.5 rounded-xl bg-background border border-gray-700 text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 text-sm"
                placeholder="••••••••"
              />
              <Lock className="w-4 h-4 text-gray-500 absolute right-3 top-3" />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold transition shadow-md shadow-indigo-600/30 flex items-center justify-center gap-2 mt-2 text-sm"
          >
            {loading ? 'Authenticating...' : isSignUp ? 'Create Account' : 'Sign In'}
            <ArrowRight className="w-4 h-4" />
          </button>
        </form>

        <div className="text-center mt-6">
          <button
            onClick={() => setIsSignUp(!isSignUp)}
            className="text-xs text-indigo-400 hover:text-indigo-300 transition"
          >
            {isSignUp ? 'Already have an account? Sign in' : "Don't have an account? Sign up"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-gray-400">Loading sign in...</div>}>
      <LoginContent />
    </Suspense>
  );
}
