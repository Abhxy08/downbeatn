# DownBeat 🎵
### Cross-DAW Live Audio Collaboration with 3 Google AI Agents
**Google Buildathon Hackathon MVP**

DownBeat is a VST3 / AU audio plugin and real-time collaboration engine that connects two music producers live across different DAWs (**Ableton Live, Logic Pro, FL Studio**). DownBeat features lossless 48 kHz / 24-bit raw PCM peer-to-peer audio streaming, tempo synchronization via Ableton Link, conflict-free state replication via CRDTs (Yjs), and three Google AI agents:
1. **Beat Jam** (*Google DeepMind Lyria RealTime*): Streams instrumental ideas locked to session BPM and musical key.
2. **Mix Doctor** (*Google Gemini*): Diagnoses clipping, loudness (LUFS), frequency masking, and stereo issues with actionable production fixes.
3. **Credits Agent** (*Google Gemini*): Analyzes the session CRDT event log to propose fair contribution splits and exports an AI-disclosed split sheet PDF.

---

## Architecture Overview

```
 ┌──────────────────────┐                           ┌──────────────────────┐
 │    Producer 1        │                           │    Producer 2        │
 │ Ableton Live / Logic │                           │ FL Studio / Ableton  │
 │ ┌──────────────────┐ │                           │ ┌──────────────────┐ │
 │ │ DownBeat Plugin  │ │                           │ │ DownBeat Plugin  │ │
 │ │ (VST3 / AU)      │ │                           │ │ (VST3 / AU)      │ │
 │ └────────┬─────────┘ │                           │ └────────┬─────────┘ │
 └──────────┼───────────┘                           └──────────┼───────────┘
            │                                                  │
            │   Lossless 48kHz / 24-bit PCM (UDP / STUN P2P)   │
            ├──────────────────────────────────────────────────┤
            │ (Fallback: Compute Engine e2-micro UDP Relay)     │
            │                                                  │
            │ WebSocket (Signaling, CRDT, Presence)            │
            ▼                                                  ▼
 ┌─────────────────────────────────────────────────────────────────────────┐
 │               Google Cloud Run Backend (Node.js + TS)                   │
 │  - Express REST + WebSocket Server (/ws)                                │
 │  - Device-Pairing Flow (/auth/pair/*)                                   │
 │  - Session Rooms & CRDT Event Log (Yjs)                                 │
 │  - Google GenAI SDK (Gemini 2.5 Flash + Lyria RealTime)                 │
 └──────────────┬───────────────────────────────┬──────────────────────────┘
                │                               │
                ▼                               ▼
 ┌──────────────────────────────┐ ┌────────────────────────────────────────┐
 │   Firebase Authentication    │ │   Google Cloud Storage & Firestore     │
 │   & Next.js Web App          │ │   - User Profiles & Active Sessions    │
 │   - Google Sign-In & Email   │ │   - Stems & Mix Doctor Reports         │
 │   - Device Pairing (/link)   │ │   - Split Sheet PDFs (/reports)        │
 │   - Producer Dashboard       │ └────────────────────────────────────────┘
 └──────────────────────────────┘
```

---

## Monorepo Structure

```
Downbeat/
├── .env.example              # Central configuration template
├── firebase.json             # Firebase Hosting, Firestore, Storage & Emulator config
├── firestore.rules           # Security rules for profiles, sessions, CRDT logs
├── storage.rules             # Security rules for stems and split sheet PDFs
├── package.json              # Monorepo root workspace configuration
│
├── plugin/                   # C++17 JUCE 8 Audio Plugin
│   ├── CMakeLists.txt        # CMake build script (VST3, AU, Standalone, Unit Tests)
│   ├── Source/
│   │   ├── AudioFifo.h       # Lock-free ring buffer (juce::AbstractFifo)
│   │   ├── JitterBuffer.h/.cpp # 40ms adaptive jitter buffer & packet sequencer
│   │   ├── NetworkClient.h/.cpp # UDP audio transport & WebSocket signaling client
│   │   ├── PluginProcessor.h/.cpp # Real-time audio engine & Ableton Link sync
│   │   └── PluginEditor.h/.cpp    # Dark DAW GUI & controls
│   └── Tests/
│       └── JitterBufferTests.cpp  # Lock-free FIFO & Jitter buffer unit tests
│
├── server/                   # Google Cloud Run Backend (Node.js + TypeScript)
│   ├── Dockerfile            # Production container image
│   ├── src/
│   │   ├── index.ts          # Express + WebSocket HTTP server entrypoint
│   │   ├── config/           # Typed environment configuration
│   │   ├── routes/           # Auth (pairing), Sessions, and AI Agent endpoints
│   │   ├── services/         # Firebase Admin, Yjs CRDT Manager, Gemini GenAI
│   │   └── websocket/        # WebSocket signaling & presence
│   └── tests/
│       ├── auth.test.ts      # Device pairing & token verification tests
│       └── crdt.test.ts      # CRDT log & conflict-free synchronization tests
│
├── web/                      # Next.js App Router + Tailwind CSS Web Dashboard
│   ├── src/app/
│   │   ├── page.tsx          # Landing page
│   │   ├── login/page.tsx    # Firebase Auth (Google + Email)
│   │   ├── link/page.tsx     # 6-Character DAW Plugin Device Pairing
│   │   └── dashboard/page.tsx# Active sessions, stems, Mix Doctor & Split sheets
│   └── src/lib/firebase.ts   # Firebase client SDK initialization
│
└── relay/                    # Low-Latency UDP Audio Relay (Compute Engine e2-micro)
    ├── Dockerfile            # Container for e2-micro deployment
    └── src/index.ts          # UDP socket server (packet forwarding & keepalives)
```

---

## Real-Time Audio Thread Rules

In accordance with professional audio software standards (JUCE / VST3 / AudioUnit specifications):
- **NO memory allocations** (`malloc`, `new`, `std::vector::resize`, `std::string`) inside `processBlock`.
- **NO locks or mutexes** (`std::mutex`, `juce::CriticalSection`) on the audio thread.
- **NO network calls or blocking system calls** on the audio thread.
- **Inter-thread communication**: uses `downbeat::AudioFifo`, a lock-free ring buffer wrapper around `juce::AbstractFifo`, to pass 48kHz 24-bit stereo PCM between the audio thread and the asynchronous network worker thread.

---

## Build & Run Instructions

### 1. Prerequisites

- **Node.js**: v20 or newer (`node -v`, `npm -v`)
- **CMake**: v3.22 or newer (`cmake --version`)
- **C++ Compiler**:
  - **macOS**: Xcode 15+ / Apple Clang
  - **Windows**: Visual Studio 2022 (MSVC with C++17)
  - **Linux**: GCC 11+ or Clang 14+
- **Git**: (`git --version`)

---

### 2. Backend & Web App Setup

1. Copy `.env.example` to `.env` in the root:
   ```bash
   cp .env.example .env
   ```
2. Install dependencies for all workspaces:
   ```bash
   npm install --workspace=server
   npm install --workspace=relay
   npm install --workspace=web
   ```
3. Run Backend unit tests (Auth token verification & CRDT sync):
   ```bash
   npm run --workspace=server test
   ```
4. Start development servers:
   ```bash
   # Terminal 1: Cloud Run Backend (Port 8080)
   npm run dev:server

   # Terminal 2: UDP Relay Server (Port 48000 UDP)
   npm run dev:relay

   # Terminal 3: Next.js Web App (Port 3000)
   npm run dev:web
   ```

---

### 3. Plugin Build Guide (macOS)

Supports **Apple Silicon (M1/M2/M3)** and **Intel x86_64**. Produces both **VST3** and **AudioUnit (AU)** formats.

```bash
# In the project root:
cd plugin
mkdir build && cd build

# Configure with CMake (Fetches JUCE 8 automatically)
cmake -B . -DCMAKE_BUILD_TYPE=Release ..

# Build VST3, AU, and Standalone targets
cmake --build . --config Release -j$(sysctl -n hw.logicalcpu)

# Run Unit Tests (Lock-free FIFO and Jitter Buffer)
ctest --output-on-failure
# Or run directly:
./downbeat_tests
```

#### Plugin Installation on macOS:
After building, the artifacts are located in `plugin/build/DownBeat_artefacts/Release/`:
- **VST3**: Copy `DownBeat.vst3` to `~/Library/Audio/Plug-Ins/VST3/`
- **AU (Component)**: Copy `DownBeat.component` to `~/Library/Audio/Plug-Ins/Components/`

Restart **Ableton Live**, **Logic Pro**, or **FL Studio**, and rescan plugins. Insert `DownBeat` onto your master bus or collaboration track.

---

### 4. Plugin Build Guide (Windows)

Using **Visual Studio 2022 (Community or Professional)**:

```powershell
# In PowerShell / Developer Command Prompt:
cd plugin
mkdir build
cd build

# One-time: install TLS (for wss://) and curl via vcpkg
#   git clone https://github.com/microsoft/vcpkg C:\vcpkg; C:\vcpkg\bootstrap-vcpkg.bat
#   C:\vcpkg\vcpkg install mbedtls:x64-windows curl:x64-windows

# Configure CMake with Visual Studio 17 2022 generator
cmake -G "Visual Studio 17 2022" -A x64 -DCMAKE_BUILD_TYPE=Release `
      -DCMAKE_TOOLCHAIN_FILE=C:/vcpkg/scripts/buildsystems/vcpkg.cmake ..

# Build VST3 and Standalone targets
cmake --build . --config Release --parallel

# Run Unit Tests
.\Release\downbeat_tests.exe
```

#### Plugin Installation on Windows:
Copy `DownBeat.vst3` from `plugin/build/DownBeat_artefacts/Release/VST3/` to:
`C:\Program Files\Common Files\VST3\`

Restart **Ableton Live** or **FL Studio**, rescan plugins, and load `DownBeat`.

---

### 5. Plugin Build Guide (Linux)

Needs the OpenSSL and libcurl development packages (Arch: `openssl curl`; Debian/Ubuntu: `libssl-dev libcurl4-openssl-dev`) plus JUCE's usual X11/ALSA/freetype deps.

```bash
cd plugin
mkdir build && cd build
cmake -B . -DCMAKE_BUILD_TYPE=Release ..
cmake --build . --config Release -j$(nproc)
./downbeat_tests
```

Copy `DownBeat.vst3` to `~/.vst3/`.

### 6. Pointing the plugin at a server

The plugin talks to `http://localhost:8088` by default. To use another server (a LAN machine or Cloud Run), either:

- set the env var `DOWNBEAT_SERVER_URL=https://downbeat-server-xxxx.run.app` before starting the DAW, or
- put the URL on one line in `server-url.txt` in the plugin's data folder:
  - macOS: `~/Library/DownBeat/server-url.txt`
  - Windows: `%APPDATA%\DownBeat\server-url.txt`
  - Linux: `~/.config/DownBeat/server-url.txt`

`https://` URLs automatically use `wss://` for the WebSocket.

---

## Firebase Setup

1. Login and initialize Firebase project:
   ```bash
   npx firebase login
   npx firebase use downbeat-live
   ```
2. Deploy Firestore and Storage security rules:
   ```bash
   npx firebase deploy --only firestore:rules,storage:rules
   ```
3. Run local Firebase Emulators (Auth, Firestore, Storage):
   ```bash
   npm run emulators
   ```

---

## Deploying to Google Cloud

Prerequisites: [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) (`gcloud auth login`), Node 20+,
a Firebase project with **Authentication** (Google + Email/Password), **Firestore** and **Storage** enabled, billing enabled.

```bash
cp .env.production.example .env.production   # git-ignored; fill in secrets + Firebase web config
# secrets: openssl rand -base64 48   (JWT_SECRET, RELAY_SECRET)

scripts/deploy-all.sh          # = the three steps below
scripts/deploy-relay.sh        # Compute Engine e2-micro + static IP + UDP 48000 firewall + systemd service
scripts/deploy-server.sh       # Cloud Run (built from the repo-root Dockerfile), least-privilege service account
scripts/deploy-web.sh          # static Next.js export -> Firebase Hosting, + Firestore/Storage rules
scripts/build-plugin.sh        # release plugin build with the Cloud Run URL baked in
```

The scripts refuse to run with missing/short/default secrets and write `PUBLIC_RELAY_IP` / `SERVER_URL`
back into `.env.production`. After the first web deploy, add `<project>.web.app` under
Firebase Authentication -> Settings -> Authorized domains.

**MVP scaling note:** sessions, presence and Beat Jam streams live in the server's memory (the event log,
reports and devices are persisted in Firestore), so Cloud Run runs exactly one instance with CPU always
allocated (`--max-instances 1 --no-cpu-throttling --timeout 3600 --session-affinity`).

## Security model

- **No API keys in clients.** Gemini/Lyria are called only by the backend; the key lives in Cloud Run env vars.
- **Plugin sign-in** uses device pairing: the browser signs in with Firebase, the server issues a device-bound
  refresh credential (handed out once, stored server-side only as a SHA-256 hash) and 1-hour session tokens.
  The plugin keeps the credential in the **OS keychain** (macOS Keychain, Windows Credential Manager, Linux
  Secret Service via libsecret; if no keychain is running it stays in memory only — never on disk).
- **Revocation**: Dashboard -> *Paired plugins* -> Revoke. Refresh + session tokens stop working immediately and
  open WebSockets for that device are closed.
- **Every** REST endpoint and WebSocket verifies a token (plugin JWT or Firebase ID token); sessions, events and
  reports are members-only. Dev logins (`dev-mock-token-*`) require `ALLOW_DEV_TOKENS=true` and are always
  disabled when `NODE_ENV=production`.
- **Firestore/Storage rules** deny direct client writes (all access goes through the backend's Admin SDK);
  members may read their own sessions/events/reports; device records and pairings are never client-readable.
- **UDP relay** forwards audio only for senders holding a server-signed HMAC ticket, only from the address that
  registered, and rate-limits each sender. CORS is restricted to the web app's origins.

## How audio & tempo sync work (Phase 4)

- **Audio**: 48 kHz / 24-bit stereo PCM, 128-frame packets (2.67 ms, ~2.4 Mbit/s each way), over UDP.
  Each plugin learns its public address via STUN and exchanges address candidates through the WebSocket;
  both sides then "hole punch" for a direct path. The relay is always registered as a fallback and used
  automatically if the direct path fails (or when "Force relay" is ticked).
- **Jitter buffer** (default 40 ms, adjustable): the network thread reorders packets, conceals losses,
  resamples 48 kHz -> host rate and trims clock drift (±0.2 %); the audio thread only reads a lock-free FIFO.
- **Tempo**: the session BPM lives on the server. Each plugin joins the *local* Ableton Link session
  (Link is LAN-only) at that tempo, so Link-enabled apps (e.g. Ableton Live with Link on) follow it, and
  tempo changes made in a Link app are sent to every collaborator. A plugin cannot change a DAW's tempo
  through VST3/AU, so DAWs without Link show "Set your DAW to X BPM" and a "Use my DAW tempo" button.
- **Latency is physics**: collaborators hear each other ~(network one-way + jitter buffer) late.
  On a LAN that's ~45 ms with the default buffer; across a city typically 50–80 ms.

**Licensing note:** Ableton Link is GPL-2.0+. That's fine for an open-source hackathon project; shipping
DownBeat closed-source requires a proprietary Link license from Ableton (link-devs@ableton.com).

## Demo

See [docs/DEMO.md](docs/DEMO.md) for the 5-minute demo script, pre-flight checklist and fallbacks.

## AI agents (Phase 6)

All Gemini / Lyria calls go through the backend; the API key never reaches the plugin or the browser.
Set `GEMINI_API_KEY` in `.env` (Google AI Studio). Models: `GEMINI_MODEL` (default `gemini-3.8-flash`, the newest
model Google labels Stable) and `LYRIA_REALTIME_MODEL` (default `models/lyria-realtime-exp`, experimental).

- **Beat Jam** — one shared Lyria RealTime stream per session, set to the session BPM (halved/doubled into Lyria's
  60–200 range) and key. Anyone can start/steer/stop it from the plugin or the session page; audio is sent to every
  plugin as 48 kHz 16-bit PCM over the WebSocket and mixed as its own track ("Hear Beat Jam" + volume).
  It is tempo-locked, not bar-aligned to your DAW's playhead. Auto-stops after 15 min or 60 s with no plugin listening.
- **Mix Doctor** — upload a bounce on the session page, or press "Analyze 30 s" in the plugin (put DownBeat on the
  master bus). For WAV files the server measures loudness (ITU-R BS.1770-4, verified against EBU Tech 3341),
  true peak, clipping, stereo correlation and band balance, then Gemini listens to the audio and returns a JSON
  report (clipping / loudness / masking / stereo, each with a concrete fix). Measurements override the model
  where they're unambiguous. Max 20 MB.
- **Credits Agent** — Gemini reads the session log and proposes splits. The server forces the result to list
  exactly the session members with whole percentages summing to 100, and writes the AI-use disclosure from the log
  (not the model). Every listed collaborator must approve; "request changes" resets approvals; the final split
  sheet is a PDF (stored in Cloud Storage when configured, always downloadable from the session page).

If Gemini is unavailable the agents return a clear error — they never fabricate a report.

### Phase 4 tests
```bash
cd plugin/build && ctest --output-on-failure          # unit tests + direct-path transport E2E
# Relay path too (uses a throwaway relay on port 48555):
(cd ../../relay && RELAY_PORT=48555 RELAY_SECRET=e2e npx ts-node-dev --transpile-only src/index.ts &)
DOWNBEAT_TEST_RELAY_PORT=48555 DOWNBEAT_TEST_RELAY_SECRET=e2e ./downbeat_transport_e2e
npm run test:all   # (repo root) server + relay tests
```

---

## Phase 1 Verification Checklist

- [x] Monorepo directory structure established (`/plugin`, `/server`, `/web`, `/relay`).
- [x] `.env.example` with comprehensive settings for Firebase, Cloud Run, Gemini, Lyria, and Relay.
- [x] `firebase.json`, `firestore.rules`, and `storage.rules` configured with strict user and session boundaries.
- [x] Cloud Run backend TypeScript service with Express, WebSocket signaling, and device pairing routes.
- [x] Server unit tests passing (`tests/auth.test.ts` and `tests/crdt.test.ts`).
- [x] Next.js 15 web client with dark DAW styling, Google login, `/link` pairing page, and dashboard.
- [x] Low-latency UDP relay service (`/relay`) for Compute Engine e2-micro.
- [x] JUCE 8 CMake project with `downbeat::AudioFifo` lock-free ring buffer and `downbeat::JitterBuffer`.
- [x] C++ unit tests target (`downbeat_tests`) verifying lock-free push/pop, in-order packet delivery, out-of-order packet reordering, and late packet drops.
- [x] Full build instructions documented for macOS, Windows, and Linux.
