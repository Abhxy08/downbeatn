import type { Metadata } from 'next';
import './globals.css';
import Link from 'next/link';
import { Activity, Music, Disc3, ShieldCheck } from 'lucide-react';

export const metadata: Metadata = {
  title: 'DownBeat | Cross-DAW Live Audio Collaboration with Google AI',
  description: 'Collaborate live across Ableton, Logic, and FL Studio with Lyria Beat Jam, Mix Doctor, and Credits Agent.',
};

import { Navbar } from '@/components/Navbar';
import { Providers } from './providers';

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-background text-gray-100 flex flex-col min-h-screen">
        <Providers>
          <Navbar />
          <main className="flex-1 flex flex-col">{children}</main>
        </Providers>

        <footer className="border-t border-surface-highlight py-6 bg-surface/50 text-center text-xs text-gray-400">
          <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-4">
            <p>© 2026 DownBeat Audio. Google Buildathon Hackathon Project.</p>
            <div className="flex items-center gap-6">
              <span>JUCE 8 VST3 / AU</span>
              <span>Ableton Link 48kHz PCM</span>
              <span>Google Gemini & Lyria RealTime</span>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
