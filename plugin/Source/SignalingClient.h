#pragma once

#include <juce_core/juce_core.h>
#include <atomic>
#include <functional>
#include <memory>
#include <vector>

namespace ix { class WebSocket; }

namespace downbeat {

struct PresenceEntry {
    juce::String connectionId;
    juce::String userId;
    juce::String userName;
    juce::String client;   // "plugin" | "web"
    juce::String daw;
};

enum class SignalingStatus { Idle, Connecting, Connected, Reconnecting, Failed };

struct RelayInfo {
    juce::String host;
    int port{0};
    juce::String token;
    int64_t expiresAt{0};
};

struct BeatJamInfo {
    bool active{false};
    juce::String status;          // idle | connecting | playing | error
    juce::String startedBy;
    juce::StringArray prompts;    // base prompt first, then steering prompts
    int bpm{0};
    juce::String error;
};

struct SessionSnapshot {
    SignalingStatus status{SignalingStatus::Idle};
    juce::String sessionId;
    juce::String connectionId;   // our id in the room (also our audio sender id)
    juce::String sessionName;
    juce::String inviteCode;
    juce::String keySignature;
    double bpm{120.0};
    juce::String lastTempoChangeBy;
    RelayInfo relay;
    juce::String stunServer;
    std::vector<PresenceEntry> online;
    BeatJamInfo beatJam;
    juce::String lastError;
};

/**
 * WebSocket connection to the DownBeat backend (/ws) for one session.
 * Runs on IXWebSocket's own thread — never touches the audio thread.
 * Auto-reconnects; on every (re)connect it re-authenticates and re-joins.
 */
class SignalingClient {
public:
    /** Must return a currently valid session token (may block to refresh). */
    using TokenProvider = std::function<juce::String(bool forceRefresh)>;

    explicit SignalingClient(TokenProvider tokenProvider);
    ~SignalingClient();

    /** Message thread only. */
    void connect(const juce::String& wsUrl, const juce::String& sessionId, const juce::String& dawName);
    /** Message thread only. Blocks until the socket thread has stopped. */
    void disconnect();

    /** Sends a JSON message if connected. Safe from any non-audio thread. */
    bool send(const juce::var& message);

    SessionSnapshot getSnapshot() const;
    bool isConnected() const;

    /**
     * Called on the socket thread for every server message *after* the snapshot was
     * updated (session_joined, presence, signal, session_tempo, ...). Set before connect().
     */
    std::function<void(const juce::var& message)> onMessage;

    /** Called on the socket thread for binary frames (Beat Jam PCM). Set before connect(). */
    std::function<void(const std::string& data)> onBinary;

private:
    void handleOpen();
    void handleText(ix::WebSocket& ws, const std::string& text);
    void setStatus(SignalingStatus s, const juce::String& error = {});

    TokenProvider tokenProvider;

    juce::CriticalSection socketLock; // guards `socket` pointer (not held while stopping it)
    std::unique_ptr<ix::WebSocket> socket;

    mutable juce::CriticalSection lock; // guards snapshot + dawName
    SessionSnapshot snapshot;
    juce::String dawName;
    std::atomic<bool> forceTokenRefresh{false};

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(SignalingClient)
};

} // namespace downbeat
