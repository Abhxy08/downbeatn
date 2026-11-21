#pragma once

#include <juce_core/juce_core.h>
#include "AudioFifo.h"
#include "AudioPacket.h"
#include "JitterBuffer.h"
#include "Resampler.h"
#include "Stun.h"
#include <atomic>
#include <functional>
#include <map>
#include <memory>
#include <vector>

namespace downbeat {

struct Endpoint {
    juce::String ip;
    int port{0};
    juce::String kind; // "host" (LAN) | "srflx" (public, from STUN)

    bool isValid() const { return ip.isNotEmpty() && port > 0 && port < 65536; }
    bool sameAddress(const juce::String& otherIp, int otherPort) const { return ip == otherIp && port == otherPort; }
    juce::String toString() const { return ip + ":" + juce::String(port); }
};

enum class AudioPath { None, Direct, Relay };

struct TransportConfig {
    juce::String sessionId;
    juce::String myConnectionId;
    juce::String relayHost;   // must be an IP address
    int relayPort{0};
    juce::String relayToken;
    int64_t relayExpiresAt{0};
    juce::String stunServer;  // "stun:host:port"
};

struct TransportStats {
    bool running{false};
    AudioPath sendPath{AudioPath::None};
    bool directEstablished{false};
    juce::String directEndpoint;
    juce::String relayStatus;      // "registered", "unreachable", "token rejected", ...
    juce::String publicEndpoint;   // from STUN
    juce::String peerName;
    bool hasPeer{false};
    bool receivingAudio{false};
    float rttMs{-1.0f};
    uint64_t packetsSent{0};
    uint64_t packetsReceived{0};
    float sendKbps{0.0f};
};

/**
 * UDP audio transport for one session (one remote audio peer).
 *
 * Runs its own thread: reads host-rate audio from `txFifo` (filled by the audio
 * thread), resamples to 48 kHz, packs 128-frame 24-bit packets and sends them
 * directly to the peer (after STUN + UDP hole punching) or via the relay.
 * Incoming audio is pushed into the peer's JitterBuffer.
 *
 * All public methods are thread-safe (but none may be called from the audio thread).
 */
class AudioTransport : private juce::Thread {
public:
    AudioTransport(AudioFifo& txFifo, JitterBuffer& rxBuffer);
    ~AudioTransport() override;

    void start(const TransportConfig& config);
    void stop();
    bool isRunning() const { return isThreadRunning(); }

    /** connectionId of the remote plugin we exchange audio with ("" = none). */
    void setRemotePeer(const juce::String& connectionId, const juce::String& displayName);
    void addRemoteCandidates(const juce::String& connectionId, const std::vector<Endpoint>& candidates);
    void setForceRelay(bool shouldForce);
    void setHostSampleRate(double rate);

    std::vector<Endpoint> getLocalCandidates() const;
    TransportStats getStats() const;

    /** Called on the transport thread whenever our candidate list changes (send it to the peer). */
    std::function<void(const std::vector<Endpoint>&)> onLocalCandidatesChanged;

private:
    void run() override;

    void handleDatagram(const uint8_t* data, int len, const juce::String& fromIp, int fromPort, double nowMs);
    void serviceStun(double nowMs);
    void serviceRelay(double nowMs);
    void serviceDirect(double nowMs);
    void servicePing(double nowMs);
    void pumpOutgoingAudio();
    bool sendToPeer(const uint8_t* data, int len);
    void sendTo(const juce::String& ip, int port, const uint8_t* data, int len);
    void publishCandidates();
    void syncConfig();
    static uint64_t nowMicros();

    AudioFifo& txFifo;
    JitterBuffer& rxBuffer;
    std::atomic<double> hostRate{48000.0};
    std::atomic<bool> forceRelay{false};

    // --- config shared with other threads ---
    mutable juce::CriticalSection configLock;
    TransportConfig pendingConfig;
    juce::String pendingPeerId, pendingPeerName;
    std::map<juce::String, std::vector<Endpoint>> remoteCandidates; // by connectionId
    std::atomic<int> configVersion{0};
    std::vector<Endpoint> localCandidates;

    // --- transport-thread state ---
    std::unique_ptr<juce::DatagramSocket> socket;
    int seenConfigVersion{-1};
    TransportConfig cfg;
    wire::Uuid sessionUuid, myUuid, peerUuid;
    juce::String peerId;
    std::vector<Endpoint> peerCandidates;

    stun::TransactionId stunTx{};
    juce::String stunHost;
    int stunPort{0};
    int stunAttempts{0};
    double nextStunMs{0};
    bool stunDone{false};

    bool relayRegistered{false};
    int relayHelloAttempts{0};
    double nextRelayMs{0};

    Endpoint directEndpoint;
    bool directEstablished{false};
    double lastDirectRxMs{0};
    double probeUntilMs{0};
    double nextProbeMs{0};

    double nextPingMs{0};
    double lastAudioRxMs{0};
    double smoothedRtt{-1.0};

    uint32_t txSeq{0};
    double streamedHostRate{0};
    StreamingResampler txResampler;
    std::vector<float> txHostL, txHostR, tx48L, tx48R;
    int tx48Count{0};
    std::vector<float> rxL, rxR;
    uint8_t txPacket[wire::kMaxPacketSize]{};
    uint8_t rxPacket[2048]{};

    // --- stats (written on transport thread, read anywhere) ---
    mutable juce::CriticalSection statsLock;
    TransportStats stats;
    std::atomic<uint64_t> packetsSent{0}, packetsReceived{0}, bytesSent{0};
    double kbpsWindowStartMs{0};
    uint64_t kbpsWindowBytes{0};

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(AudioTransport)
};

} // namespace downbeat
