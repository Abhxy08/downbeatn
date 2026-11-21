# DownBeat live demo: shot list (about 2.5 minutes)

Record a real jam with two people for the pitch. Pair it with the auto-generated walkthrough
(`demo/out/DownBeat-demo.mp4`) as a backup.

## Setup
- Two laptops, both online. Person A in REAPER, Ableton or Logic with the DownBeat plugin on a track.
  Person B in the Standalone app or another DAW.
- Both wear headphones. Mic sending is optional; if you want voices in the video, untick
  "Mute audio input" in the Standalone.
- Sign both plugins in through https://downbeat-919f8.web.app (Sign In → enter the code on the site).
- Create the session beforehand, so the video starts on the action.
- Recording: OBS (Windows/Mac), or on this Linux laptop:
  `wf-recorder -a "$(pactl get-default-sink).monitor" -f take.mp4` (select the screen; Ctrl+C stops it)

## Shots
| # | Time | On screen | Say (voice-over or live) |
|---|------|-----------|--------------------------|
| 1 | 0:00–0:10 | Both DAWs side by side (or a split-screen edit) | "Two producers, two different DAWs, two different places." |
| 2 | 0:10–0:25 | A clicks **New Session**, copies the code; B pastes it, clicks **Join**. "Direct P2P" turns green | "One invite code. Audio connects peer-to-peer at 48 kHz / 24-bit." |
| 3 | 0:25–0:50 | A draws a bassline in **Shared clip**, B adds a melody; notes appear on both screens. A presses Play in the DAW | "One shared MIDI clip. Every note syncs live and plays in time with each DAW's transport." |
| 4 | 0:50–1:15 | **AI agents** tab → Beat Jam prompt "dusty lo-fi drums, warm Rhodes" → **Start**. Then **Steer** with "add hi-hats" | "Beat Jam: Google's Lyria RealTime generates music locked to our tempo and key, in both plugins." |
| 5 | 1:15–1:35 | A plays for 30 s, clicks **Mix Doctor**; the report shows loudness and clipping fixes | "Mix Doctor: Gemini listens to the mix and gives concrete fixes." |
| 6 | 1:35–2:05 | **Credits: propose splits** (cut the ~40 s wait), then both click **Approve split** | "The Credits Agent reads what each of us actually did and drafts a split. Both of us must approve." |
| 7 | 2:05–2:25 | Browser: the session page → Who did what → **Download split sheet (PDF)** | "Everything lands on the web: who did what, and a split sheet with an AI disclosure." |
| 8 | 2:25–2:30 | Title card with the URL | "DownBeat. downbeat-919f8.web.app" |

## Tips
- Gemini's Credits proposal takes 20–45 seconds: cut that wait in the edit, or talk over it.
- Send me the raw takes (`take.mp4`, or one per laptop). I'll cut them, add captions and the title cards
  from `demo/out/card-*.png`, and level the audio.
