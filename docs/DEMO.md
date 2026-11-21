# DownBeat — 5-minute demo script

Two producers, two laptops, two DAWs, one session. Everything below is real (no mocked output).

## Before you go on stage (T-30 min)

| Check | How |
|---|---|
| Backend up | `curl https://<SERVER_URL>/health` → `"status":"healthy"` |
| Relay up | Plugin → tick **Force relay** briefly → dot turns amber, audio keeps flowing → untick |
| Gemini answering | Session page → upload any short WAV to Mix Doctor (Google sometimes returns 503 "high demand"; the server retries + falls back, but check now) |
| Lyria answering | Start + Stop a Beat Jam once |
| Both laptops signed in | Plugin header says **Signed in as …** (Linux without a keyring needs a fresh sign-in per launch) |
| Headphones on both | Prevents feedback loops (mic → collaborator → speakers → mic) |
| Same tempo | Both DAWs at the session tempo, or Ableton Link enabled in Live |
| Pre-bounced WAV ready | ~20–30 s of the track, < 20 MB, on laptop A's desktop |
| Browser tabs | Laptop A: session page open. Laptop B: dashboard. Both signed in |

Laptop A = **Alex** (Ableton Live, DownBeat on the master bus). Laptop B = **Sam** (FL Studio or Logic, DownBeat on an instrument/vocal bus).

---

## 0:00 — The problem (20 s)
> "Producers collaborate by emailing stems back and forth. Every DAW is an island. DownBeat is a plugin that turns two DAWs into one live session — and three Google AI agents join the jam."

## 0:20 — Pair & join (40 s)
1. **Alex**: plugin → **Sign In** → browser opens → Google sign-in → plugin shows *Signed in as Alex*.
   > "No passwords in the plugin: it's a device-pairing flow, and the credential lives in the OS keychain. I can revoke this laptop from the dashboard."
2. **Alex**: **New Session** → **Copy** → read the invite code out loud.
3. **Sam**: paste code → **Join**. Both plugins: *Online (2)* with each other's DAW name.

## 1:00 — Live audio + tempo (60 s)
1. **Alex** presses play in Live. **Sam** hears it in FL Studio — point at the **latency meter**:
   > "Lossless 48 kHz 24-bit PCM, peer-to-peer. Green dot = direct path; RTT and the one-way latency are measured live."
2. **Sam** plays a riff; Alex hears it.
3. **Alex** changes Live's tempo (Link on) → Sam's plugin shows the new session BPM within a second.
   > "Ableton Link is LAN-only, so we bridge it over the internet through our backend."
4. Optional: tick **Force relay** → amber "Via relay", audio continues.
   > "If the NAT won't let us go direct, a tiny UDP relay on a Compute Engine e2-micro takes over automatically."

## 2:00 — Beat Jam, Lyria RealTime (50 s)
1. **Sam**: Beat Jam prompt `dusty boom-bap drums, warm Rhodes` → **Start**; both tick **Hear Beat Jam**.
   > "One shared Lyria RealTime stream for the whole session, locked to our tempo and key, mixed in as its own track."
2. **Alex**: steer with `darker, add hi-hats`. ~2 s later the jam changes.
3. **Stop**.

## 2:50 — Mix Doctor, Gemini (50 s)
1. **Alex**: plugin → **Mix Doctor: analyze 30 s** while the track plays (DownBeat on the master), *or* drag the pre-bounced WAV onto the session page.
   > "Our DSP measures loudness to the ITU BS.1770 standard, true peak, clipping and stereo phase — then Gemini listens and explains what to fix, with concrete settings."
2. Show the report: score, the four checks, the *Fix:* lines. If it flags clipping, note that the measurement overrode the model.

## 3:40 — Who did what → split sheet (60 s)
1. Both type a note: Alex `programmed drums and bass`, Sam `wrote the chorus melody`.
2. Session page → **Who did what**: audio seconds, MIDI notes, tempo changes, notes — the CRDT event log.
3. **Propose splits** → Gemini proposes shares with reasoning.
4. **Sam**: *Request changes* → `I also arranged the bridge` → **Draft again** (approvals reset).
5. Both **Approve** → status **Final** → **Download split sheet (PDF)** → open it: shares, reasoning, approvals, **AI-use disclosure**.
   > "The AI drafts; humans approve. The disclosure is written from the log, not by the model — it says exactly which AI was used and by whom."

## 4:40 — Close (20 s)
> "Cross-DAW live collaboration, lossless audio, tempo sync, and three Google AI agents — Lyria to jam, Gemini to mix, Gemini to credit fairly. Built on Cloud Run, Firebase and Compute Engine."

---

## If something breaks live

| Symptom | Recovery |
|---|---|
| Mix Doctor / Credits says "overloaded" | Wait 30 s and press again (server already retried + fell back). Have a previous report open in another tab |
| Beat Jam error | Read the error aloud ("Google's experimental model is busy"), move on to Mix Doctor |
| No audio between laptops | Check *Mute my send* is off, collaborator volume up, both on headphones; tick **Force relay** |
| Connected ("receiving") but silent, and the session log never shows "played Ns of audio" | The plugin is getting silence: the OS mic is muted or the wrong mic is selected (Bluetooth headset mics are often muted, and force low-quality call mode). Linux: `pactl list short sources` and `pactl set-source-mute <mic> 0`. Standalone app: **Options → Audio/MIDI Settings** → untick *Mute audio input* |
| Session log shows audio but you hear nothing | Standalone **Options → Audio/MIDI Settings → Active output channels** must be **1 + 2** (it can default to 3 + 4) |
| Plugin says "Reconnecting" | Wi-Fi blip; it reconnects and resends queued log events automatically |
| Tempo mismatch | Press **Use my DAW tempo** on one laptop |
| Signed out | Revoked or token expired: **Sign In** again (10 s) |

## Honest limits (good answers for judges)
- Collaborators hear each other ~network one-way + jitter buffer late (≈45 ms on LAN, 50–80 ms across a city) — physics.
- Beat Jam is tempo-locked, not bar-aligned to the DAW playhead.
- The plugin only sees what passes through it (plus logged notes) — it can't read edits elsewhere in a DAW.
- The MVP backend runs a single Cloud Run instance (sessions live in memory).
- Ableton Link is GPL-2.0; a closed-source release needs Ableton's proprietary licence.
