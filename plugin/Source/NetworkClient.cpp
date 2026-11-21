#include "NetworkClient.h"
#include "CredentialStorage.h"

#include <juce_audio_processors/juce_audio_processors.h>

namespace downbeat {

namespace {
constexpr juce::int64 kSessionTokenMaxAgeMs = 50 * 60 * 1000; // server issues 1h tokens

juce::var makeObject(std::initializer_list<std::pair<const char*, juce::var>> props) {
    auto* obj = new juce::DynamicObject();
    for (auto& [k, v] : props) obj->setProperty(k, v);
    return juce::var(obj);
}

/** DOWNBEAT_SERVER_URL env var, else <app data>/DownBeat/server-url.txt, else localhost. */
juce::String resolveServerUrl() {
    auto fromEnv = juce::SystemStats::getEnvironmentVariable("DOWNBEAT_SERVER_URL", {}).trim();
    if (fromEnv.isNotEmpty()) return fromEnv.trimCharactersAtEnd("/");

    auto file = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
                    .getChildFile("DownBeat").getChildFile("server-url.txt");
    if (file.existsAsFile()) {
        auto fromFile = file.loadFileAsString().trim();
        if (fromFile.isNotEmpty()) return fromFile.trimCharactersAtEnd("/");
    }
#ifdef DOWNBEAT_DEFAULT_SERVER_URL
    return DOWNBEAT_DEFAULT_SERVER_URL;
#else
    return "http://localhost:8088";
#endif
}
} // namespace

NetworkClient::NetworkClient(AudioFifo& tx, JitterBuffer& rx, BeatJamBuffer& bj, SharedClip& clip)
    : txFifo(tx),
      rxJitterBuffer(rx),
      beatJamBuffer(bj),
      sharedClip(clip),
      transport(tx, rx),
      signaling([this](bool force) { return getFreshSessionToken(force); })
{
    serverBaseUrl = resolveServerUrl();

    signaling.onMessage = [this](const juce::var& msg) { onSignalingMessage(msg); };
    signaling.onBinary = [this](const std::string& data) {
        // [0x01][int16 LE stereo 48 kHz PCM] = Beat Jam audio
        if (data.size() > 1 && (uint8_t) data[0] == 0x01)
            beatJamBuffer.pushPcm16(reinterpret_cast<const uint8_t*>(data.data()) + 1, data.size() - 1);
    };

    // Transport thread: our address candidates changed (e.g. STUN answered) -> tell the peer again
    transport.onLocalCandidatesChanged = [this](const std::vector<Endpoint>&) {
        juce::String peer;
        {
            const juce::ScopedLock sl(peerLock);
            peer = currentPeerId;
            candidatesSentTo.erase(peer);
        }
        if (peer.isNotEmpty()) sendCandidatesTo(peer);
    };

    // Link thread: someone changed the tempo in a Link-enabled app on this machine/LAN
    link.onTempoChanged = [this](double bpm) {
        if (juce::Time::getMillisecondCounterHiRes() < suppressLinkUntilMs.load()) return;
        if (std::abs(bpm - signaling.getSnapshot().bpm) < 0.01) return; // our own echo
        pendingLinkTempo.store(bpm);
    };

    tryRestoreSavedAuth();
    startTimerHz(5);
}

NetworkClient::~NetworkClient() {
    stopTimer();
    activityProvider = nullptr;
    paramProvider = nullptr;
    alive.reset(); // pending callAsync lambdas become no-ops
    signaling.onMessage = nullptr;
    signaling.onBinary = nullptr;
    signaling.disconnect();
    transport.onLocalCandidatesChanged = nullptr;
    transport.stop();
    link.onTempoChanged = nullptr;
    link.setEnabled(false);
    httpPool.removeAllJobs(true, 5000);
}

void NetworkClient::setServerUrl(const juce::String& url) {
    const juce::ScopedLock sl(authLock);
    serverBaseUrl = url.trimCharactersAtEnd("/");
}

juce::String NetworkClient::getServerUrl() const {
    const juce::ScopedLock sl(authLock);
    return serverBaseUrl;
}

juce::String NetworkClient::getWebSocketUrl() const {
    auto base = getServerUrl();
    if (base.startsWithIgnoreCase("https://")) base = "wss://" + base.substring(8);
    else if (base.startsWithIgnoreCase("http://")) base = "ws://" + base.substring(7);
    return base + "/ws";
}

juce::String NetworkClient::detectHostName() {
    if (juce::JUCEApplicationBase::isStandaloneApp()) return "Standalone";
    juce::PluginHostType host;
    juce::String name = host.getHostDescription();
    if (name.isNotEmpty() && name != "Unknown") return name;

    // JUCE doesn't recognise every host on every OS (e.g. REAPER on Linux): use the host's executable name.
    auto exe = juce::File::getSpecialLocation(juce::File::hostApplicationPath).getFileNameWithoutExtension();
    if (exe.isEmpty()) return "Unknown DAW";
    if (exe.equalsIgnoreCase("reaper")) return "REAPER";
    if (exe.containsIgnoreCase("bitwig")) return "Bitwig Studio";
    if (exe.containsIgnoreCase("ardour")) return "Ardour";
    return exe.substring(0, 1).toUpperCase() + exe.substring(1);
}

// ---------------------------------------------------------------------------
// HTTP helper (blocking — only call from httpPool / background threads)
// ---------------------------------------------------------------------------
juce::var NetworkClient::postJson(const juce::String& path, const juce::var& body,
                                  const juce::String& bearer, int& statusCode) {
    statusCode = 0;
    juce::String headers = "Content-Type: application/json";
    if (bearer.isNotEmpty()) headers << "\r\nAuthorization: Bearer " << bearer;

    auto url = juce::URL(getServerUrl() + path).withPOSTData(juce::JSON::toString(body, true));
    auto options = juce::URL::InputStreamOptions(juce::URL::ParameterHandling::inPostData)
                       .withExtraHeaders(headers)
                       .withConnectionTimeoutMs(8000)
                       .withStatusCode(&statusCode);

    auto stream = url.createInputStream(options);
    if (stream == nullptr) return {};
    return juce::JSON::parse(stream->readEntireStreamAsString());
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
bool NetworkClient::isSignedIn() const {
    const juce::ScopedLock sl(authLock);
    return refreshToken.isNotEmpty();
}

bool NetworkClient::tryRestoreSavedAuth() {
    // Keychain access can block (e.g. an unlock prompt), so never do it on the message thread.
    httpPool.addJob([this] {
        CredentialStorage::deleteLegacyFile();
        auto creds = CredentialStorage::loadCredentials();
        if (!creds.isValid) return;
        {
            const juce::ScopedLock sl(authLock);
            if (refreshToken.isNotEmpty()) return; // signed in meanwhile via pairing
            refreshToken = creds.refreshToken;
            currentUserName = creds.displayName.isNotEmpty() ? creds.displayName : creds.userEmail;
            currentUserId = creds.userId;
        }
        // Validates the stored credential (clears it if revoked) and warms the session token.
        if (getFreshSessionToken().isNotEmpty())
            state.store(ConnectionState::ConnectedSignaling);
    });
    return true;
}

juce::String NetworkClient::getFreshSessionToken(bool forceRefresh) {
    juce::String refresh;
    {
        const juce::ScopedLock sl(authLock);
        const auto age = juce::Time::currentTimeMillis() - sessionTokenIssuedMs;
        if (!forceRefresh && sessionToken.isNotEmpty() && age < kSessionTokenMaxAgeMs)
            return sessionToken;
        refresh = refreshToken;
    }
    if (refresh.isEmpty()) return {};

    int status = 0;
    auto resp = postJson("/auth/token/refresh", makeObject({ {"refreshToken", refresh} }), {}, status);

    if (status == 200 && resp.isObject() && resp["success"]) {
        const juce::ScopedLock sl(authLock);
        sessionToken = resp["sessionToken"].toString();
        sessionTokenIssuedMs = juce::Time::currentTimeMillis();
        return sessionToken;
    }

    if (status == 401) {
        // Refresh credential expired or revoked: forget it so the UI offers "Sign In" again.
        // (Don't touch `signaling` here — this may be running on its thread.)
        CredentialStorage::clearCredentials();
        const juce::ScopedLock sl(authLock);
        refreshToken = {};
        sessionToken = {};
        currentUserName = {};
    }
    return {};
}

void NetworkClient::signOut() {
    leaveSession();
    CredentialStorage::clearCredentials();
    const juce::ScopedLock sl(authLock);
    refreshToken = {};
    sessionToken = {};
    sessionTokenIssuedMs = 0;
    currentUserName = {};
    currentUserId = {};
    currentPairingId = {};
    state.store(ConnectionState::Disconnected);
}

void NetworkClient::startPairing(std::function<void(bool, const juce::String&, const juce::String&)> callback) {
    state.store(ConnectionState::Pairing);

    httpPool.addJob([this, callback] {
        int status = 0;
        const auto label = detectHostName() + " on " + juce::SystemStats::getComputerName();
        auto parsed = postJson("/auth/pair/start", makeObject({ {"deviceLabel", label} }), {}, status);

        juce::String pairUrl, code;
        bool success = false;
        if (parsed.isObject() && parsed["success"]) {
            const juce::ScopedLock sl(authLock);
            currentPairingId = parsed["pairingId"].toString();
            currentPairingCode = parsed["code"].toString();
            pairUrl = parsed["pairUrl"].toString();
            code = currentPairingCode;
            success = true;
        }

        juce::MessageManager::callAsync([callback, success, code, pairUrl] { callback(success, code, pairUrl); });
    });
}

void NetworkClient::pollPairingStatus(std::function<void(bool, const juce::String&)> callback) {
    juce::String pairingId;
    {
        const juce::ScopedLock sl(authLock);
        pairingId = currentPairingId;
    }
    if (pairingId.isEmpty()) return;
    if (pairingPollInFlight.exchange(true)) return; // one poll at a time

    httpPool.addJob([this, callback, pairingId] {
        juce::URL url(getServerUrl() + "/auth/pair/status?pairingId=" + juce::URL::addEscapeChars(pairingId, true));
        auto stream = url.createInputStream(juce::URL::InputStreamOptions(juce::URL::ParameterHandling::inAddress)
                                                .withConnectionTimeoutMs(5000));

        bool confirmed = false;
        juce::String userEmail;

        if (stream != nullptr) {
            auto parsed = juce::JSON::parse(stream->readEntireStreamAsString());
            if (parsed.isObject() && parsed["status"].toString() == "confirmed") {
                confirmed = true;

                StoredCredentials creds;
                creds.refreshToken = parsed["refreshToken"].toString();
                if (parsed["user"].isObject()) {
                    creds.userEmail = parsed["user"]["email"].toString();
                    creds.displayName = parsed["user"]["displayName"].toString();
                    creds.userId = parsed["user"]["uid"].toString();
                }
                creds.isValid = creds.refreshToken.isNotEmpty();
                userEmail = creds.userEmail;
                if (!CredentialStorage::saveCredentials(creds)) {
                    const juce::ScopedLock sl(authLock);
                    keychainWarning = "Couldn't save to " + CredentialStorage::backendName() + " (" + CredentialStorage::lastError()
                                    + "). You'll need to sign in again next time.";
                }

                {
                    const juce::ScopedLock sl(authLock);
                    refreshToken = creds.refreshToken;
                    sessionToken = parsed["sessionToken"].toString();
                    sessionTokenIssuedMs = juce::Time::currentTimeMillis();
                    currentUserName = creds.displayName.isNotEmpty() ? creds.displayName : creds.userEmail;
                    currentUserId = creds.userId;
                    currentPairingId = {};
                }
                state.store(ConnectionState::ConnectedSignaling);
            }
        }

        pairingPollInFlight.store(false);
        juce::MessageManager::callAsync([callback, confirmed, userEmail] { callback(confirmed, userEmail); });
    });
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
void NetworkClient::createSession(const juce::String& name, double bpm, SessionCallback callback) {
    httpPool.addJob([this, name, bpm, callback] {
        const auto token = getFreshSessionToken();
        if (token.isEmpty()) {
            juce::MessageManager::callAsync([callback] { callback(false, "Sign in first"); });
            return;
        }
        int status = 0;
        auto resp = postJson("/sessions", makeObject({ {"name", name}, {"bpm", bpm} }), token, status);
        handleSessionResponse(resp, status, callback);
    });
}

void NetworkClient::joinSessionByInviteCode(const juce::String& inviteCode, SessionCallback callback) {
    httpPool.addJob([this, inviteCode, callback] {
        const auto token = getFreshSessionToken();
        if (token.isEmpty()) {
            juce::MessageManager::callAsync([callback] { callback(false, "Sign in first"); });
            return;
        }
        int status = 0;
        auto resp = postJson("/sessions/join", makeObject({ {"inviteCode", inviteCode.trim()} }), token, status);
        handleSessionResponse(resp, status, callback);
    });
}

void NetworkClient::handleSessionResponse(const juce::var& resp, int status, SessionCallback callback) {
    if ((status == 200 || status == 201) && resp.isObject() && resp["success"] && resp["session"].isObject()) {
        // Socket lifecycle stays on the message thread (see leaveSession / signOut).
        const auto sessionId = resp["session"]["id"].toString();
        std::weak_ptr<bool> weakAlive = alive;
        juce::MessageManager::callAsync([this, weakAlive, sessionId, callback] {
            if (weakAlive.expired()) return;
            connectSignaling(sessionId);
            callback(true, {});
        });
        return;
    }

    juce::String error;
    if (status == 0) error = "Can't reach server at " + getServerUrl();
    else if (resp.isObject() && resp["error"].isString()) error = resp["error"].toString();
    else error = "Server error (HTTP " + juce::String(status) + ")";

    juce::MessageManager::callAsync([callback, error] { callback(false, error); });
}

void NetworkClient::connectSignaling(const juce::String& sessionId) {
    {
        const juce::ScopedLock sl(peerLock);
        currentPeerId = {};
        candidatesSentTo.clear();
    }
    signaling.connect(getWebSocketUrl(), sessionId, detectHostName());
}

void NetworkClient::leaveSession() {
    if (signaling.isConnected())
        signaling.send(makeObject({ {"type", "leave_session"} }));
    signaling.disconnect();
    transport.stop();
    link.setEnabled(false);
    beatJamBuffer.requestFlush();
    sharedClip.clear();
    {
        const juce::ScopedLock sl(agentLock);
        agentBusy = false;
        agentStatus = {};
        agentReport = {};
        latestCredits = juce::var();
    }
    {
        const juce::ScopedLock sl(eventLock);
        outbox.clear();
        recentActivity.clear();
        eventsAcked = 0;
        lastEventError = {};
    }
    {
        const juce::ScopedLock sl(peerLock);
        currentPeerId = {};
        candidatesSentTo.clear();
    }
    if (state.load() != ConnectionState::Pairing)
        state.store(isSignedIn() ? ConnectionState::ConnectedSignaling : ConnectionState::Disconnected);
}

// ---------------------------------------------------------------------------
// Signalling events (socket thread)
// ---------------------------------------------------------------------------
void NetworkClient::onSignalingMessage(const juce::var& msg) {
    const auto type = msg["type"].toString();
    const auto snap = signaling.getSnapshot();

    if (type == "session_joined") {
        // (Re)start the audio transport with our new connection id + relay ticket.
        TransportConfig cfg;
        cfg.sessionId = snap.sessionId;
        cfg.myConnectionId = snap.connectionId;
        cfg.relayHost = snap.relay.host;
        cfg.relayPort = snap.relay.port;
        cfg.relayToken = snap.relay.token;
        cfg.relayExpiresAt = snap.relay.expiresAt;
        cfg.stunServer = snap.stunServer;
        {
            const juce::ScopedLock sl(peerLock);
            currentPeerId = {};
            candidatesSentTo.clear();
        }
        transport.setRemotePeer({}, {});
        transport.start(cfg);

        refreshCredits();

        sessionBpm.store(snap.bpm);

        // Join the local Link session at the session tempo.
        suppressLinkUntilMs.store(juce::Time::getMillisecondCounterHiRes() + 2000.0);
        link.setEnabled(true);
        link.setTempo(snap.bpm);
    } else if (type == "presence") {
        choosePeer(snap.online, snap.connectionId);
    } else if (type == "signal") {
        const auto& signal = msg["signal"];
        const auto from = msg["fromConnectionId"].toString();
        if (signal["kind"].toString() == "candidates" && from.isNotEmpty()) {
            std::vector<Endpoint> endpoints;
            if (auto* arr = signal["endpoints"].getArray()) {
                for (const auto& e : *arr) {
                    Endpoint ep{ e["ip"].toString(), static_cast<int>(e["port"]), e["kind"].toString() };
                    if (ep.isValid()) endpoints.push_back(ep);
                }
            }
            transport.addRemoteCandidates(from, endpoints);

            bool alreadySent;
            {
                const juce::ScopedLock sl(peerLock);
                alreadySent = candidatesSentTo.count(from) > 0;
            }
            if (!alreadySent) sendCandidatesTo(from);
        }
    } else if (type == "session_tempo") {
        sessionBpm.store(snap.bpm);
        suppressLinkUntilMs.store(juce::Time::getMillisecondCounterHiRes() + 500.0);
        link.setTempo(snap.bpm);
    } else if (type == "clip_state") {
        std::vector<SharedClip::Note> notes;
        if (auto* arr = msg["notes"].getArray()) {
            for (const auto& n : *arr) {
                notes.push_back({ n["id"].toString(), (int) n["step"], (int) n["length"], (int) n["pitch"],
                                  (int) n["velocity"], n["by"].toString(), n["byName"].toString() });
            }
        }
        sharedClip.replaceAll(std::move(notes));
    } else if (type == "clip_op") {
        const auto op = msg["op"].toString();
        if (op == "add" || op == "update") {
            const auto& n = msg["note"];
            sharedClip.upsert({ n["id"].toString(), (int) n["step"], (int) n["length"], (int) n["pitch"],
                                (int) n["velocity"], n["by"].toString(), n["byName"].toString() });
        } else if (op == "remove") {
            sharedClip.remove(msg["id"].toString());
        } else if (op == "clear") {
            sharedClip.clear();
        }
    } else if (type == "event_ack" || type == "event_rejected" || type == "crdt_event") {
        handleEventMessage(type, msg);
        if (type == "crdt_event" && msg["event"]["type"].toString().startsWith("credits_")) refreshCredits();
    } else if (type == "beatjam_state") {
        if (!(bool) msg["state"]["active"]) beatJamBuffer.requestFlush();
    } else if (type == "_disconnected") {
        transport.setRemotePeer({}, {});
        const juce::ScopedLock sl(peerLock);
        currentPeerId = {};
    }
}

void NetworkClient::choosePeer(const std::vector<PresenceEntry>& online, const juce::String& myConnectionId) {
    // MVP: one remote audio peer — the first other *plugin* in the room.
    juce::String peerId, peerName;
    for (const auto& p : online) {
        if (p.client == "plugin" && p.connectionId != myConnectionId) {
            peerId = p.connectionId;
            peerName = p.userName;
            break;
        }
    }

    bool changed;
    {
        const juce::ScopedLock sl(peerLock);
        changed = peerId != currentPeerId;
        currentPeerId = peerId;
    }
    transport.setRemotePeer(peerId, peerName);
    if (changed && peerId.isNotEmpty()) sendCandidatesTo(peerId);
}

void NetworkClient::sendCandidatesTo(const juce::String& connectionId) {
    const auto candidates = transport.getLocalCandidates();
    if (candidates.empty() || connectionId.isEmpty()) return;

    juce::Array<juce::var> endpoints;
    for (const auto& c : candidates)
        endpoints.add(makeObject({ {"ip", c.ip}, {"port", c.port}, {"kind", c.kind} }));

    const bool sent = signaling.send(makeObject({
        {"type", "signal"},
        {"targetConnectionId", connectionId},
        {"signal", makeObject({ {"kind", "candidates"}, {"endpoints", endpoints} })},
    }));
    if (sent) {
        const juce::ScopedLock sl(peerLock);
        candidatesSentTo.insert(connectionId);
    }
}

// ---------------------------------------------------------------------------
// Tempo + audio settings
// ---------------------------------------------------------------------------
void NetworkClient::proposeSessionTempo(double bpm) {
    if (bpm < 20.0 || bpm > 999.0) return;
    signaling.send(makeObject({ {"type", "tempo_sync"}, {"bpm", bpm} }));
}

void NetworkClient::timerCallback() {
    // Throttled forwarding of local Link tempo changes (dragging a tempo knob fires many callbacks)
    const double bpm = pendingLinkTempo.exchange(0.0);
    if (bpm > 0.0) proposeSessionTempo(bpm);

    watchParams();
    if (++timerTicks % 50 == 0) reportActivity(); // every 10 s (timer is 5 Hz)
    flushOutbox();
}

// ---------------------------------------------------------------------------
// Session event log
// ---------------------------------------------------------------------------
void NetworkClient::setActivityProvider(std::function<ActivityWindow()> provider) {
    activityProvider = std::move(provider);
}

void NetworkClient::setParamProvider(std::function<std::vector<std::pair<juce::String, juce::var>>()> provider) {
    paramProvider = std::move(provider);
}

void NetworkClient::logEvent(const juce::String& eventType, const juce::var& payload) {
    if (signaling.getSnapshot().sessionId.isEmpty()) return; // only log inside a session

    // 32 hex chars, no dashes: matches the server's id format and is globally unique
    const auto id = "plg_" + juce::Uuid().toString();
    auto msg = makeObject({
        {"type", "crdt_event"},
        {"id", id},
        {"eventType", eventType},
        {"payload", payload},
        {"clientTimestamp", (double) juce::Time::currentTimeMillis()},
    });

    {
        const juce::ScopedLock sl(eventLock);
        outbox.push_back({ id, msg, 0.0 });
        if (outbox.size() > 500) outbox.erase(outbox.begin()); // bounded while offline
    }
    juce::String me;
    {
        const juce::ScopedLock sl(authLock);
        me = currentUserName.upToFirstOccurrenceOf(" ", false, false);
    }
    addActivity(describeEvent(me.isNotEmpty() ? me : juce::String("You"), eventType, payload));
    flushOutbox();
}

void NetworkClient::flushOutbox() {
    if (!signaling.isConnected()) return;
    const double now = juce::Time::getMillisecondCounterHiRes();
    const juce::ScopedLock sl(eventLock);
    for (auto& e : outbox) {
        if (e.lastSentMs > 0.0 && now - e.lastSentMs < 5000.0) continue; // awaiting ack
        if (!signaling.send(e.message)) return;
        e.lastSentMs = now;
    }
}

void NetworkClient::handleEventMessage(const juce::String& type, const juce::var& msg) {
    if (type == "event_ack") {
        const auto id = msg["id"].toString();
        const juce::ScopedLock sl(eventLock);
        for (auto it = outbox.begin(); it != outbox.end(); ++it) {
            if (it->id == id) {
                outbox.erase(it);
                if (!msg["duplicate"]) ++eventsAcked;
                break;
            }
        }
    } else if (type == "event_rejected") {
        const auto id = msg["id"].toString();
        const bool retry = msg["retry"];
        const juce::ScopedLock sl(eventLock);
        for (auto it = outbox.begin(); it != outbox.end(); ++it) {
            if (it->id == id) {
                if (retry) it->lastSentMs = juce::Time::getMillisecondCounterHiRes(); // try again in 5 s
                else outbox.erase(it);
                break;
            }
        }
        if (!retry) lastEventError = msg["error"].toString();
    } else if (type == "crdt_event") {
        // Someone else's event (or a server event about anyone)
        const auto& e = msg["event"];
        addActivity(describeEvent(e["userName"].toString().upToFirstOccurrenceOf(" ", false, false),
                                  e["type"].toString(), e["payload"]));
    }
}

void NetworkClient::addActivity(const juce::String& line) {
    const juce::ScopedLock sl(eventLock);
    recentActivity.push_back(juce::Time::getCurrentTime().formatted("%H:%M  ") + line);
    while (recentActivity.size() > 6) recentActivity.pop_front();
}

juce::String NetworkClient::describeEvent(const juce::String& who, const juce::String& type, const juce::var& p) {
    if (type == "session_join")      return who + " joined (" + p["daw"].toString() + ")";
    if (type == "session_leave")     return who + " left";
    if (type == "tempo_change")      return who + " set tempo to " + juce::String((double) p["bpm"], 1) + " BPM";
    if (type == "audio_activity")    return who + " played " + juce::String((double) p["activeSeconds"], 0) + "s of audio";
    if (type == "midi_activity")     return who + " played " + p["notes"].toString() + " MIDI notes";
    if (type == "send_mute")         return who + ((bool) p["muted"] ? " muted" : " unmuted") + " their send";
    if (type == "param_change")      return who + " changed " + p["param"].toString() + " to " + p["value"].toString();
    if (type == "contribution_note") return who + ": \"" + p["text"].toString() + "\"";
    if (type == "beat_jam") {
        const auto action = p["action"].toString();
        if (action == "stop") return who + " stopped Beat Jam";
        return who + (action == "start" ? " started" : " steered") + " Beat Jam: " + p["prompt"].toString();
    }
    if (type == "mix_report")        return who + " ran Mix Doctor (score " + p["score"].toString() + ")";
    if (type == "credits_proposed")  return who + " asked for a split proposal";
    if (type == "credits_approved")  return who + " approved the split sheet";
    if (type == "credits_changes_requested") return who + " requested split changes";
    if (type == "credits_final")     return "Split sheet is FINAL";
    if (type == "clip_edit") {
        const auto a = p["action"].toString();
        if (a == "clear") return who + " cleared the shared clip";
        return who + (a == "add" ? " added " : " removed ") + juce::MidiMessage::getMidiNoteName((int) p["pitch"], true, true, 4)
             + " in the shared clip";
    }
    return who + " " + type;
}

void NetworkClient::reportActivity() {
    if (!activityProvider) return;
    const auto w = activityProvider(); // always drain, so counters don't pile up between sessions
    if (!signaling.isConnected()) return;

    const double window = juce::jmax(1.0, std::round(w.totalSeconds));
    if (w.activeSeconds >= 0.5) {
        logEvent("audio_activity", makeObject({
            {"activeSeconds", std::round(juce::jmin(w.activeSeconds, window) * 10.0) / 10.0},
            {"windowSeconds", window},
            {"peakDb", std::round(juce::jlimit(-160.0, 24.0, (double) w.peakDb) * 10.0) / 10.0},
        }));
    }
    if (w.midiNotes > 0) {
        logEvent("midi_activity", makeObject({
            {"notes", w.midiNotes},
            {"lowest", w.lowestNote},
            {"highest", w.highestNote},
            {"windowSeconds", window},
        }));
    }
}

void NetworkClient::watchParams() {
    if (!paramProvider) return;
    const double now = juce::Time::getMillisecondCounterHiRes();
    const bool inSession = signaling.isConnected();

    for (const auto& [name, value] : paramProvider()) {
        auto& w = watchedParams[name];
        if (!w.initialised) {
            w = { value, value, now, true };
            continue;
        }
        if (value == w.committed) {
            w.candidate = value;
            continue;
        }
        if (value != w.candidate) { // still moving: wait until it settles for 1 s
            w.candidate = value;
            w.candidateSinceMs = now;
            continue;
        }
        if (now - w.candidateSinceMs < 1000.0) continue;

        if (inSession) {
            if (name == "sendMuted")
                logEvent("send_mute", makeObject({ {"muted", (bool) value} }));
            else
                logEvent("param_change", makeObject({ {"param", name}, {"value", value}, {"previous", w.committed} }));
        }
        w.committed = value;
    }
}

void NetworkClient::setHostSampleRate(double rate) {
    transport.setHostSampleRate(rate);
}

void NetworkClient::setForceRelay(bool shouldForce) {
    forceRelay.store(shouldForce);
    transport.setForceRelay(shouldForce);
}

SessionInfo NetworkClient::getSessionInfo() const {
    SessionInfo info;
    {
        const juce::ScopedLock sl(authLock);
        info.isSignedIn = refreshToken.isNotEmpty();
        info.currentUserName = currentUserName.toStdString();
        info.currentUserId = currentUserId.toStdString();
        info.keychainWarning = keychainWarning.toStdString();
    }

    const auto snap = signaling.getSnapshot();
    info.sessionId = snap.sessionId.toStdString();
    info.sessionName = snap.sessionName.toStdString();
    info.inviteCode = snap.inviteCode.toStdString();
    info.keySignature = snap.keySignature.toStdString();
    info.sessionBpm = snap.bpm;
    info.lastTempoChangeBy = snap.lastTempoChangeBy.toStdString();
    info.signalingStatus = snap.status;
    info.lastError = snap.lastError.toStdString();
    info.online = snap.online;

    info.linkEnabled = link.isEnabled();
    info.linkPeers = info.linkEnabled ? link.numPeers() : 0;
    info.transport = transport.getStats();

    info.beatJam = snap.beatJam;
    info.beatJamBufferedSec = beatJamBuffer.getBufferedSeconds();
    info.beatJamPlaying = beatJamBuffer.isPlaying();
    {
        const juce::ScopedLock al(agentLock);
        info.agentBusy = agentBusy;
        info.agentStatus = agentStatus.toStdString();
        info.agentReport = agentReport.toStdString();
        juce::String me;
        {
            const juce::ScopedLock sl(authLock);
            me = currentUserId;
        }
        if (latestCredits.isObject() && latestCredits["status"].toString() == "pending" && me.isNotEmpty()) {
            bool listed = false;
            if (auto* arr = latestCredits["splits"].getArray())
                for (const auto& sp : *arr) listed = listed || sp["userId"].toString() == me;
            info.canApproveCredits = listed && !latestCredits["approvals"].hasProperty(juce::Identifier(me));
        }
    }

    const juce::ScopedLock sl(eventLock);
    info.eventsLogged = eventsAcked;
    info.eventsPending = (int) outbox.size();
    for (const auto& line : recentActivity) info.recentActivity.push_back(line.toStdString());
    info.lastEventError = lastEventError.toStdString();
    return info;
}

// ---------------------------------------------------------------------------
// AI agents
// ---------------------------------------------------------------------------
void NetworkClient::setAgentStatus(const juce::String& status) {
    const juce::ScopedLock sl(agentLock);
    agentStatus = status;
}

void NetworkClient::beatJamStart(const juce::String& prompt) {
    if (prompt.trim().isEmpty()) return;
    signaling.send(makeObject({ {"type", "beatjam_start"}, {"prompt", prompt.trim()} }));
}

void NetworkClient::beatJamSteer(const juce::String& prompt) {
    if (prompt.trim().isEmpty()) return;
    signaling.send(makeObject({ {"type", "beatjam_steer"}, {"prompt", prompt.trim()} }));
}

void NetworkClient::beatJamStop() {
    signaling.send(makeObject({ {"type", "beatjam_stop"} }));
}

juce::var NetworkClient::httpJson(const juce::String& path, const juce::MemoryBlock* body, const juce::String& contentType,
                                  const juce::String& bearer, int timeoutMs, int& statusCode) {
    statusCode = 0;
    juce::String headers;
    if (contentType.isNotEmpty()) headers << "Content-Type: " << contentType << "\r\n";
    if (bearer.isNotEmpty()) headers << "Authorization: Bearer " << bearer;

    juce::URL url(getServerUrl() + path);
    auto handling = juce::URL::ParameterHandling::inAddress;
    if (body != nullptr) {
        url = url.withPOSTData(*body);
        handling = juce::URL::ParameterHandling::inPostData;
    }
    auto stream = url.createInputStream(juce::URL::InputStreamOptions(handling)
                                            .withExtraHeaders(headers)
                                            .withConnectionTimeoutMs(timeoutMs)
                                            .withStatusCode(&statusCode));
    if (stream == nullptr) return {};
    return juce::JSON::parse(stream->readEntireStreamAsString());
}

static juce::String errorOf(const juce::var& resp, int status, const juce::String& server) {
    if (status == 0) return "Can't reach server at " + server;
    if (resp.isObject() && resp["error"].isString()) return resp["error"].toString();
    return "Server error (HTTP " + juce::String(status) + ")";
}

void NetworkClient::analyzeMix(juce::MemoryBlock wav, const juce::String& fileName) {
    const auto sessionId = signaling.getSnapshot().sessionId;
    if (sessionId.isEmpty()) return;
    {
        const juce::ScopedLock sl(agentLock);
        agentBusy = true;
        agentStatus = "Mix Doctor is listening to your mix (" + juce::String(wav.getSize() / 1e6, 1) + " MB)...";
    }
    httpPool.addJob([this, wav = std::move(wav), fileName, sessionId] {
        int status = 0;
        const auto token = getFreshSessionToken();
        const auto path = "/agents/mix-doctor?sessionId=" + juce::URL::addEscapeChars(sessionId, true)
                        + "&fileName=" + juce::URL::addEscapeChars(fileName, true);
        const auto resp = httpJson(path, &wav, "audio/wav", token, 130000, status);
        const juce::ScopedLock sl(agentLock);
        agentBusy = false;
        if (status == 201 && resp["report"].isObject()) {
            agentStatus = "Mix Doctor report ready (full report on the web dashboard)";
            showMixReport(resp["report"]);
        } else {
            agentStatus = "Mix Doctor failed: " + errorOf(resp, status, getServerUrl());
        }
    });
}

void NetworkClient::showMixReport(const juce::var& report) {
    // caller holds agentLock
    const auto& d = report["diagnosis"];
    const auto& m = report["metrics"];
    juce::String t;
    t << "MIX DOCTOR  -  score " << d["overallScore"].toString() << "/100\n" << d["summary"].toString() << "\n";
    if (m.isObject())
        t << "Measured: " << m["integratedLufs"].toString() << " LUFS, true peak " << m["truePeakDbfs"].toString()
          << " dBTP, stereo correlation " << m["stereoCorrelation"].toString() << "\n";
    const char* names[] = { "clipping", "loudness", "frequencyMasking", "stereo" };
    const char* labels[] = { "Clipping", "Loudness", "Masking", "Stereo" };
    for (int i = 0; i < 4; ++i) {
        const auto& c = d["checks"][names[i]];
        const auto st = c["status"].toString();
        t << "\n[" << (st == "ok" ? "OK" : st == "warning" ? "WARN" : "FIX") << "] " << labels[i] << ": " << c["finding"].toString();
        if (st != "ok") t << "\n      Fix: " << c["fix"].toString();
    }
    if (auto* issues = d["otherIssues"].getArray())
        for (const auto& is : *issues)
            t << "\n[" << is["severity"].toString().toUpperCase() << "] " << is["title"].toString() << " - Fix: " << is["fix"].toString();
    agentReport = t;
}

void NetworkClient::proposeCredits() {
    const auto sessionId = signaling.getSnapshot().sessionId;
    if (sessionId.isEmpty()) return;
    {
        const juce::ScopedLock sl(agentLock);
        agentBusy = true;
        agentStatus = "Credits Agent is reading the session log...";
    }
    httpPool.addJob([this, sessionId] {
        int status = 0;
        const auto body = juce::JSON::toString(makeObject({ {"sessionId", sessionId} }), true);
        juce::MemoryBlock mb(body.toRawUTF8(), body.getNumBytesAsUTF8());
        const auto resp = httpJson("/agents/credits/propose", &mb, "application/json", getFreshSessionToken(), 130000, status);
        const juce::ScopedLock sl(agentLock);
        agentBusy = false;
        if (status == 201 && resp["proposal"].isObject()) {
            agentStatus = "Split proposal ready - every collaborator must approve";
            showCredits(resp["proposal"]);
        } else {
            agentStatus = "Credits Agent failed: " + errorOf(resp, status, getServerUrl());
        }
    });
}

void NetworkClient::approveCredits() {
    juce::String id;
    {
        const juce::ScopedLock sl(agentLock);
        id = latestCredits["id"].toString();
    }
    const auto sessionId = signaling.getSnapshot().sessionId;
    if (id.isEmpty() || sessionId.isEmpty()) return;
    httpPool.addJob([this, id, sessionId] {
        int status = 0;
        const auto body = juce::JSON::toString(makeObject({ {"sessionId", sessionId} }), true);
        juce::MemoryBlock mb(body.toRawUTF8(), body.getNumBytesAsUTF8());
        const auto resp = httpJson("/agents/credits/" + id + "/approve", &mb, "application/json", getFreshSessionToken(), 30000, status);
        const juce::ScopedLock sl(agentLock);
        if (status == 200 && resp["proposal"].isObject()) {
            showCredits(resp["proposal"]);
            agentStatus = resp["proposal"]["status"].toString() == "final"
                              ? "Split sheet is FINAL - download the PDF from the web dashboard"
                              : "You approved - waiting for the others";
        } else {
            agentStatus = "Approve failed: " + errorOf(resp, status, getServerUrl());
        }
    });
}

void NetworkClient::refreshCredits() {
    const auto sessionId = signaling.getSnapshot().sessionId;
    if (sessionId.isEmpty()) return;
    httpPool.addJob([this, sessionId] {
        int status = 0;
        const auto resp = httpJson("/agents/reports?kind=credits&sessionId=" + juce::URL::addEscapeChars(sessionId, true),
                                   nullptr, {}, getFreshSessionToken(), 15000, status);
        if (status != 200) return;
        if (auto* arr = resp["reports"].getArray()) {
            for (const auto& r : *arr) {
                if (r["status"].toString() == "superseded") continue;
                const juce::ScopedLock sl(agentLock);
                if (!agentBusy) showCredits(r);
                return;
            }
        }
    });
}

void NetworkClient::showCredits(const juce::var& p) {
    // caller holds agentLock
    latestCredits = p;
    const auto status = p["status"].toString();
    juce::String t;
    t << "SPLIT SHEET  -  " << (status == "final" ? "FINAL (approved by everyone)"
                              : status == "pending" ? "awaiting approval"
                              : status == "changes_requested" ? "changes requested" : status) << "\n";
    if (auto* arr = p["splits"].getArray()) {
        for (const auto& sp : *arr) {
            const bool ok = p["approvals"].hasProperty(juce::Identifier(sp["userId"].toString()));
            t << (ok ? "  [approved] " : "  [ ] ") << sp["userName"].toString() << "  " << sp["percentage"].toString()
              << "%  -  " << sp["role"].toString() << "\n      " << sp["reasoning"].toString() << "\n";
        }
    }
    t << "\n" << p["aiDisclosure"].toString();
    agentReport = t;
}

// ---------------------------------------------------------------------------
// Shared MIDI clip — optimistic local edit, then sent to the server (which fans it out)
// ---------------------------------------------------------------------------
static juce::var noteVar(const SharedClip::Note& n) {
    return makeObject({ {"id", n.id}, {"step", n.step}, {"length", n.length}, {"pitch", n.pitch}, {"velocity", n.velocity} });
}

void NetworkClient::clipAdd(int step, int length, int pitch, int velocity) {
    SharedClip::Note n;
    n.id = "n" + juce::Uuid().toString().substring(0, 15);
    n.step = juce::jlimit(0, SharedClip::kSteps - 1, step);
    n.length = juce::jlimit(1, SharedClip::kSteps - n.step, length);
    n.pitch = juce::jlimit(24, 108, pitch);
    n.velocity = juce::jlimit(1, 127, velocity);
    {
        const juce::ScopedLock sl(authLock);
        n.byUid = currentUserId;
        n.byName = currentUserName;
    }
    sharedClip.upsert(n);
    signaling.send(makeObject({ {"type", "clip_op"}, {"op", "add"}, {"note", noteVar(n)} }));
}

void NetworkClient::clipUpdate(const SharedClip::Note& note) {
    sharedClip.upsert(note);
    signaling.send(makeObject({ {"type", "clip_op"}, {"op", "update"}, {"note", noteVar(note)} }));
}

void NetworkClient::clipRemove(const juce::String& id) {
    sharedClip.remove(id);
    signaling.send(makeObject({ {"type", "clip_op"}, {"op", "remove"}, {"id", id} }));
}

void NetworkClient::clipClear() {
    sharedClip.clear();
    signaling.send(makeObject({ {"type", "clip_op"}, {"op", "clear"} }));
}

} // namespace downbeat
