#pragma once

#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include "Activity.h"
#include "AudioFifo.h"
#include "AudioTransport.h"
#include "BeatJamBuffer.h"
#include "SharedClip.h"
#include "JitterBuffer.h"
#include "LinkSync.h"
#include "SignalingClient.h"
#include <atomic>
#include <deque>
#include <map>
#include <functional>
#include <memory>
#include <set>
#include <string>
#include <vector>

namespace downbeat {

enum class ConnectionState {
    Disconnected,
    Pairing,
    ConnectedSignaling,
    StreamingP2P,
    StreamingRelay,
    Error
};

struct SessionInfo {
    // Auth
    bool isSignedIn{false};
    std::string currentUserName;
    std::string currentUserId;
    std::string keychainWarning;

    // Session (empty sessionId = not in a session)
    std::string sessionId;
    std::string sessionName;
    std::string inviteCode;
    std::string keySignature;
    double sessionBpm{120.0};
    std::string lastTempoChangeBy;
    SignalingStatus signalingStatus{SignalingStatus::Idle};
    std::string lastError;
    std::vector<PresenceEntry> online;

    // Tempo (Ableton Link)
    bool linkEnabled{false};
    std::size_t linkPeers{0};

    // Audio
    TransportStats transport;

    // AI agents
    BeatJamInfo beatJam;
    float beatJamBufferedSec{0.0f};
    bool beatJamPlaying{false};
    bool agentBusy{false};
    std::string agentStatus;   // one line: what the agents are doing / last error
    std::string agentReport;   // multi-line text of the latest Mix Doctor / Credits result
    bool canApproveCredits{false};

    // Event log
    int eventsLogged{0};
    int eventsPending{0};
    std::vector<std::string> recentActivity; // newest last
    std::string lastEventError;
};

/**
 * Everything network-related for one plugin instance: auth/pairing, sessions,
 * WebSocket signalling, UDP audio transport and Ableton Link tempo bridging.
 * Nothing here runs on (or blocks) the audio thread.
 */
class NetworkClient : private juce::Timer {
public:
    NetworkClient(AudioFifo& txFifo, JitterBuffer& rxJitterBuffer, BeatJamBuffer& beatJamBuffer, SharedClip& sharedClip);
    ~NetworkClient() override;

    void setServerUrl(const juce::String& url);
    juce::String getServerUrl() const;

    // Auth & Pairing
    void startPairing(std::function<void(bool success, const juce::String& code, const juce::String& pairUrl)> callback);
    void pollPairingStatus(std::function<void(bool confirmed, const juce::String& userEmail)> callback);
    bool tryRestoreSavedAuth();
    void signOut();
    bool isSignedIn() const;

    /** Blocking. Returns a valid short-lived session token, refreshing if needed. Never call on the message/audio thread. */
    juce::String getFreshSessionToken(bool forceRefresh = false);

    // Session Management — callbacks run on the message thread
    using SessionCallback = std::function<void(bool success, const juce::String& error)>;
    void createSession(const juce::String& name, double bpm, SessionCallback callback);
    void joinSessionByInviteCode(const juce::String& inviteCode, SessionCallback callback);
    void leaveSession(); // message thread only

    // Tempo: ask every collaborator to switch to this tempo (e.g. "use my DAW tempo")
    void proposeSessionTempo(double bpm);

    // Audio
    void setHostSampleRate(double rate);
    void setForceRelay(bool shouldForce);
    bool isForceRelay() const { return forceRelay.load(); }

    SessionInfo getSessionInfo() const;

    // ----- Session event log -----
    /** Queues an event for the session log (resent until the server acks it). Any non-audio thread. */
    void logEvent(const juce::String& eventType, const juce::var& payload);
    /** Supplies activity counters (called every 10 s on the message thread). */
    void setActivityProvider(std::function<ActivityWindow()> provider);
    /** Supplies current values of watched plugin settings (polled on the message thread). */
    void setParamProvider(std::function<std::vector<std::pair<juce::String, juce::var>>()> provider);

    // ----- Shared MIDI clip (message thread) -----
    void clipAdd(int step, int length, int pitch, int velocity);
    void clipUpdate(const SharedClip::Note& note);
    void clipRemove(const juce::String& id);
    void clipClear();
    /** Session tempo for the audio thread (lock-free). */
    double getSessionBpm() const noexcept { return sessionBpm.load(); }

    // ----- AI agents -----
    void beatJamStart(const juce::String& prompt);
    void beatJamSteer(const juce::String& prompt);
    void beatJamStop();
    /** Uploads a captured WAV to Mix Doctor (async; result appears in SessionInfo::agentReport). */
    void analyzeMix(juce::MemoryBlock wav, const juce::String& fileName);
    void proposeCredits();
    void approveCredits();
    void refreshCredits();
    void setAgentStatus(const juce::String& status);

private:
    juce::var httpJson(const juce::String& path, const juce::MemoryBlock* body, const juce::String& contentType,
                       const juce::String& bearer, int timeoutMs, int& statusCode);
    void showCredits(const juce::var& proposal);
    void showMixReport(const juce::var& report);

    struct PendingEvent {
        juce::String id;
        juce::var message;
        double lastSentMs{0.0};
    };
    struct WatchedParam {
        juce::var committed;
        juce::var candidate;
        double candidateSinceMs{0.0};
        bool initialised{false};
    };

    void flushOutbox();
    void handleEventMessage(const juce::String& type, const juce::var& msg);
    void addActivity(const juce::String& line);
    void reportActivity();
    void watchParams();
    static juce::String describeEvent(const juce::String& who, const juce::String& type, const juce::var& payload);

    void timerCallback() override;

    /** POSTs JSON with optional bearer token. Returns parsed body (or void var), sets statusCode. */
    juce::var postJson(const juce::String& path, const juce::var& body, const juce::String& bearer, int& statusCode);
    void handleSessionResponse(const juce::var& resp, int status, SessionCallback callback);
    void connectSignaling(const juce::String& sessionId);
    juce::String getWebSocketUrl() const;
    static juce::String detectHostName();

    // Signalling events (socket thread)
    void onSignalingMessage(const juce::var& msg);
    void choosePeer(const std::vector<PresenceEntry>& online, const juce::String& myConnectionId);
    void sendCandidatesTo(const juce::String& connectionId);

    AudioFifo& txFifo;
    JitterBuffer& rxJitterBuffer;
    BeatJamBuffer& beatJamBuffer;
    SharedClip& sharedClip;
    std::atomic<double> sessionBpm{120.0};

    // AI agent results (any thread -> UI)
    mutable juce::CriticalSection agentLock;
    bool agentBusy{false};
    juce::String agentStatus;
    juce::String agentReport;
    juce::var latestCredits;

    std::atomic<ConnectionState> state{ConnectionState::Disconnected};
    std::atomic<bool> pairingPollInFlight{false};
    std::atomic<bool> forceRelay{false};

    mutable juce::CriticalSection authLock; // guards every juce::String below
    juce::String serverBaseUrl{"http://localhost:8088"};
    juce::String currentPairingId;
    juce::String currentPairingCode;
    juce::String refreshToken;
    juce::String sessionToken;
    juce::int64 sessionTokenIssuedMs{0};
    juce::String currentUserName;
    juce::String currentUserId;
    juce::String keychainWarning;

    // Peer selection / candidate exchange (socket + transport threads)
    juce::CriticalSection peerLock;
    juce::String currentPeerId;
    std::set<juce::String> candidatesSentTo;

    // Link tempo bridge
    std::atomic<double> pendingLinkTempo{0.0};       // set on Link thread, sent by timer
    std::atomic<double> suppressLinkUntilMs{0.0};    // ignore Link echoes right after joining

    // Event log (message thread + socket thread)
    mutable juce::CriticalSection eventLock;
    std::vector<PendingEvent> outbox;
    std::deque<juce::String> recentActivity;
    int eventsAcked{0};
    juce::String lastEventError;
    std::function<ActivityWindow()> activityProvider;
    std::function<std::vector<std::pair<juce::String, juce::var>>()> paramProvider;
    std::map<juce::String, WatchedParam> watchedParams; // message thread only
    int timerTicks{0};

    // Declaration order = construction order; destruction is reversed.
    LinkSync link;
    AudioTransport transport;
    SignalingClient signaling; // connect/disconnect only on the message thread
    std::shared_ptr<bool> alive{std::make_shared<bool>(true)};

    // HTTP work runs here. Declared last so it is destroyed first:
    // its destructor waits for in-flight jobs that capture `this`.
    juce::ThreadPool httpPool{2};

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(NetworkClient)
};

} // namespace downbeat
