import Link from 'next/link';
import { Sparkles, Radio, Users, Zap, Shield, Cpu } from 'lucide-react';

export default function HomePage() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-4 py-16 max-w-6xl mx-auto text-center">
      <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-xs font-semibold mb-8">
        <Sparkles className="w-3.5 h-3.5" />
        Live Cross-DAW Collaboration + 3 Google AI Agents
      </div>

      <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight text-white mb-6 leading-tight">
        Collaborate Live Across DAWs <br />
        <span className="bg-gradient-to-r from-indigo-400 via-cyan-400 to-emerald-400 bg-clip-text text-transparent">
          In Lossless Real-Time Quality
        </span>
      </h1>

      <p className="text-lg text-gray-400 max-w-2xl mb-10 leading-relaxed">
        Connect Ableton Live, Logic Pro, and FL Studio seamlessly. Hear each other in 48kHz/24-bit PCM, jam with Google Lyria RealTime, diagnose mixes with Gemini, and export fair AI split sheets.
      </p>

      <div className="flex flex-wrap items-center justify-center gap-4 mb-16">
        <Link
          href="/link"
          className="px-6 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold shadow-lg shadow-indigo-600/30 transition text-base"
        >
          Pair DAW Plugin
        </Link>
        <Link
          href="/dashboard"
          className="px-6 py-3 rounded-xl bg-surface-highlight hover:bg-gray-800 text-gray-200 font-semibold border border-gray-700 transition text-base"
        >
          Open Session Dashboard
        </Link>
      </div>

      {/* Feature Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-left w-full">
        <div className="p-6 rounded-2xl bg-surface border border-surface-highlight shadow-xl">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 mb-4">
            <Radio className="w-5 h-5" />
          </div>
          <h3 className="text-lg font-bold text-white mb-2">P2P Audio & Link Sync</h3>
          <p className="text-sm text-gray-400 leading-relaxed">
            Ultra low-latency 48 kHz / 24-bit raw PCM streaming over UDP with an adaptive 40ms jitter buffer, STUN NAT traversal, and automatic relay fallback.
          </p>
        </div>

        <div className="p-6 rounded-2xl bg-surface border border-surface-highlight shadow-xl">
          <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 mb-4">
            <Sparkles className="w-5 h-5" />
          </div>
          <h3 className="text-lg font-bold text-white mb-2">3 Google AI Agents</h3>
          <p className="text-sm text-gray-400 leading-relaxed">
            Lyria Beat Jam generates instrumental ideas locked to your BPM and key. Mix Doctor detects clipping and masking. Credits Agent logs edits for split sheets.
          </p>
        </div>

        <div className="p-6 rounded-2xl bg-surface border border-surface-highlight shadow-xl">
          <div className="w-10 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400 mb-4">
            <Users className="w-5 h-5" />
          </div>
          <h3 className="text-lg font-bold text-white mb-2">Conflict-Free CRDTs</h3>
          <p className="text-sm text-gray-400 leading-relaxed">
            Powered by Yjs CRDTs. Every parameter change, mute, and note edit is synchronized in real time across DAWs and logged immutably to Firestore.
          </p>
        </div>
      </div>
    </div>
  );
}
