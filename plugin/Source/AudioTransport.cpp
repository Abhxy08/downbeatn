#include "AudioTransport.h"
#include <cstring>

namespace downbeat {

namespace {
constexpr int kMaxHostChunk = 4096;          // host-rate frames read from the TX FIFO at once
constexpr int kTx48Capacity = 16384;         // 48k accumulation buffer
constexpr double kDirectTimeoutMs = 3000.0;  // no direct packets for this long -> fall back to relay
constexpr double kProbeWindowMs = 6000.0;
constexpr double kReprobeIntervalMs = 10000.0;
constexpr double kPingIntervalMs = 500.0;
constexpr double kRelayRefreshMs = 10000.0;  // HELLO doubles as keepalive (and survives relay restarts)
} // namespace

AudioTransport::AudioTransport(AudioFifo& tx, JitterBuffer& rx)
    : juce::Thread("DownBeatAudioNet"),
      txFifo(tx),
      rxBuffer(rx)
{
    txHostL.assign(kMaxHostChunk, 0.0f);
    txHostR.assign(kMaxHostChunk, 0.0f);
    tx48L.assign(kTx48Capacity, 0.0f);
    tx48R.assign(kTx48Capacity, 0.0f);
    rxL.assign(wire::kMaxFramesPerPacket, 0.0f);
    rxR.assign(wire::kMaxFramesPerPacket, 0.0f);
    txResampler.prepare(kMaxHostChunk);
}

AudioTransport::~AudioTransport() {
    stop();
}

// ---------------------------------------------------------------------------
// Public API (any non-audio thread)
// ---------------------------------------------------------------------------
void AudioTransport::start(const TransportConfig& config) {
    stop();
    {
        const juce::ScopedLock sl(configLock);
        pendingConfig = config;
        remoteCandidates.clear();
        localCandidates.clear();
        ++configVersion;
    }
    startThread(juce::Thread::Priority::high);
}

void AudioTransport::stop() {
    if (isThreadRunning()) {
        signalThreadShouldExit();
        stopThread(2000);
    }
}

void AudioTransport::setRemotePeer(const juce::String& connectionId, const juce::String& displayName) {
    const juce::ScopedLock sl(configLock);
    if (pendingPeerId == connectionId && pendingPeerName == displayName) return;
    pendingPeerId = connectionId;
    pendingPeerName = displayName;
    ++configVersion;
}

void AudioTransport::addRemoteCandidates(const juce::String& connectionId, const std::vector<Endpoint>& candidates) {
    const juce::ScopedLock sl(configLock);
    remoteCandidates[connectionId] = candidates;
    ++configVersion;
}

void AudioTransport::setForceRelay(bool shouldForce) { forceRelay.store(shouldForce); }
void AudioTransport::setHostSampleRate(double rate) { if (rate > 0.0) hostRate.store(rate); }

std::vector<Endpoint> AudioTransport::getLocalCandidates() const {
    const juce::ScopedLock sl(configLock);
    return localCandidates;
}

TransportStats AudioTransport::getStats() const {
    TransportStats s;
    {
        const juce::ScopedLock sl(statsLock);
        s = stats;
    }
    s.packetsSent = packetsSent.load();
    s.packetsReceived = packetsReceived.load();
    return s;
}

uint64_t AudioTransport::nowMicros() {
    return (uint64_t) (juce::Time::getHighResolutionTicks() * 1.0e6
                       / (double) juce::Time::getHighResolutionTicksPerSecond());
}

// ---------------------------------------------------------------------------
// Transport thread
// ---------------------------------------------------------------------------
void AudioTransport::run() {
    socket = std::make_unique<juce::DatagramSocket>(false);
    if (!socket->bindToPort(0)) {
        const juce::ScopedLock sl(statsLock);
        stats.relayStatus = "could not open UDP socket";
        return;
    }
    const int localPort = socket->getBoundPort();

    // Fresh per-session state
    seenConfigVersion = -1;
    peerId = {};
    peerCandidates.clear();
    stunDone = false;
    stunAttempts = 0;
    nextStunMs = nextRelayMs = nextProbeMs = nextPingMs = 0;
    relayRegistered = false;
    relayHelloAttempts = 0;
    directEstablished = false;
    directEndpoint = {};
    probeUntilMs = 0;
    smoothedRtt = -1.0;
    lastAudioRxMs = 0;
    txSeq = 0;
    tx48Count = 0;
    streamedHostRate = 0;
    kbpsWindowStartMs = juce::Time::getMillisecondCounterHiRes();
    kbpsWindowBytes = 0;
    packetsSent = packetsReceived = bytesSent = 0;
    juce::Random rng;
    for (auto& b : stunTx) b = (uint8_t) rng.nextInt(256);
    {
        const juce::ScopedLock sl(statsLock);
        stats = {};
        stats.running = true;
        stats.relayStatus = "connecting...";
    }

    // Discard audio queued while no session was running (we're the FIFO's only reader).
    {
        float* dst[2] = { txHostL.data(), txHostR.data() };
        while (txFifo.getNumReady() > 0) txFifo.read(dst, juce::jmin(txFifo.getNumReady(), kMaxHostChunk));
    }

    syncConfig();
    stun::parseServer(cfg.stunServer, stunHost, stunPort);

    // Host (LAN) candidates: every local IPv4 address with our socket's port.
    {
        const juce::ScopedLock sl(configLock);
        for (auto& addr : juce::IPAddress::getAllAddresses(false)) {
            const auto ip = addr.toString();
            if (ip.startsWith("127.") || ip == "0.0.0.0") continue;
            localCandidates.push_back({ ip, localPort, "host" });
        }
    }
    publishCandidates();

    double nextStatsMs = 0;
    while (!threadShouldExit()) {
        socket->waitUntilReady(true, 1);

        double now = juce::Time::getMillisecondCounterHiRes();
        for (int i = 0; i < 128; ++i) {
            juce::String fromIp;
            int fromPort = 0;
            const int n = socket->read(rxPacket, (int) sizeof(rxPacket), false, fromIp, fromPort);
            if (n <= 0) break;
            handleDatagram(rxPacket, n, fromIp, fromPort, now);
        }

        now = juce::Time::getMillisecondCounterHiRes();
        syncConfig();
        serviceStun(now);
        serviceRelay(now);
        serviceDirect(now);
        servicePing(now);
        pumpOutgoingAudio();

        if (now >= nextStatsMs) {
            nextStatsMs = now + 100.0;
            const bool direct = directEstablished && !forceRelay.load();
            const juce::ScopedLock sl(statsLock);
            stats.sendPath = peerId.isEmpty() ? AudioPath::None
                           : direct ? AudioPath::Direct
                           : relayRegistered ? AudioPath::Relay : AudioPath::None;
            stats.directEstablished = directEstablished;
            stats.directEndpoint = directEstablished ? directEndpoint.toString() : juce::String();
            stats.hasPeer = peerId.isNotEmpty();
            stats.receivingAudio = lastAudioRxMs > 0 && now - lastAudioRxMs < 500.0;
            stats.rttMs = (float) smoothedRtt;
            if (now - kbpsWindowStartMs >= 1000.0) {
                const uint64_t total = bytesSent.load();
                stats.sendKbps = (float) ((total - kbpsWindowBytes) * 8.0 / (now - kbpsWindowStartMs));
                kbpsWindowBytes = total;
                kbpsWindowStartMs = now;
            }
        }
    }

    // Leave the relay politely
    if (relayRegistered) {
        wire::writeHeader(txPacket, wire::PacketType::Bye, sessionUuid, myUuid);
        sendTo(cfg.relayHost, cfg.relayPort, txPacket, wire::kHeaderSize);
    }
    socket->shutdown();
    socket.reset();
    const juce::ScopedLock sl(statsLock);
    stats = {};
}

void AudioTransport::syncConfig() {
    const int version = configVersion.load();
    if (version == seenConfigVersion) return;
    seenConfigVersion = version;

    juce::String newPeerId, newPeerName;
    std::vector<Endpoint> newCandidates;
    {
        const juce::ScopedLock sl(configLock);
        cfg = pendingConfig;
        newPeerId = pendingPeerId;
        newPeerName = pendingPeerName;
        auto it = remoteCandidates.find(newPeerId);
        if (it != remoteCandidates.end()) newCandidates = it->second;
    }
    wire::Uuid::parse(cfg.sessionId, sessionUuid);
    wire::Uuid::parse(cfg.myConnectionId, myUuid);

    const double now = juce::Time::getMillisecondCounterHiRes();
    if (newPeerId != peerId) {
        peerId = newPeerId;
        peerUuid = {};
        if (peerId.isNotEmpty()) wire::Uuid::parse(peerId, peerUuid);
        directEstablished = false;
        directEndpoint = {};
        smoothedRtt = -1.0;
        lastAudioRxMs = 0;
        rxBuffer.resetStream();
        const juce::ScopedLock sl(statsLock);
        stats.peerName = newPeerName;
    }

    bool candidatesChanged = newCandidates.size() != peerCandidates.size();
    for (size_t i = 0; !candidatesChanged && i < newCandidates.size(); ++i)
        candidatesChanged = !newCandidates[i].sameAddress(peerCandidates[i].ip, peerCandidates[i].port);
    if (candidatesChanged) {
        peerCandidates = newCandidates;
        probeUntilMs = now + kProbeWindowMs; // (re)start hole punching
        nextProbeMs = 0;
    }
}

void AudioTransport::publishCandidates() {
    if (onLocalCandidatesChanged) onLocalCandidatesChanged(getLocalCandidates());
}

void AudioTransport::sendTo(const juce::String& ip, int port, const uint8_t* data, int len) {
    if (socket == nullptr || ip.isEmpty() || port <= 0) return;
    const int n = socket->write(ip, port, data, len);
    if (n > 0) bytesSent.fetch_add((uint64_t) n);
}

bool AudioTransport::sendToPeer(const uint8_t* data, int len) {
    if (peerId.isEmpty()) return false;
    if (directEstablished && !forceRelay.load()) {
        sendTo(directEndpoint.ip, directEndpoint.port, data, len);
        return true;
    }
    if (relayRegistered) {
        sendTo(cfg.relayHost, cfg.relayPort, data, len);
        return true;
    }
    return false;
}

void AudioTransport::handleDatagram(const uint8_t* data, int len, const juce::String& fromIp, int fromPort, double nowMs) {
    // STUN response (our public address)
    if (stun::looksLikeStun(data, len)) {
        juce::String ip;
        int port = 0;
        if (!stunDone && stun::parseBindingResponse(data, len, stunTx, ip, port)) {
            stunDone = true;
            bool isNew = true;
            {
                const juce::ScopedLock sl(configLock);
                for (auto& c : localCandidates) if (c.sameAddress(ip, port)) isNew = false;
                if (isNew) localCandidates.push_back({ ip, port, "srflx" });
            }
            {
                const juce::ScopedLock sl(statsLock);
                stats.publicEndpoint = ip + ":" + juce::String(port);
            }
            if (isNew) publishCandidates();
        }
        return;
    }

    wire::Header h;
    if (!wire::parseHeader(data, len, h) || h.session != sessionUuid) return;

    const bool fromRelay = fromIp == cfg.relayHost && fromPort == cfg.relayPort;

    // The relay's HELLO_ACK echoes *our* sender id; every other packet from ourselves is ignored.
    if (h.sender == myUuid && h.type != wire::PacketType::HelloAck) return;
    const bool fromPeer = !peerUuid.isZero() && h.sender == peerUuid;

    auto markDirect = [&] {
        if (!fromPeer || fromRelay) return;
        if (!directEstablished || !directEndpoint.sameAddress(fromIp, fromPort))
            directEndpoint = { fromIp, fromPort, "direct" };
        directEstablished = true;
        lastDirectRxMs = nowMs;
    };

    switch (h.type) {
        case wire::PacketType::HelloAck: {
            if (!fromRelay || len < wire::kHeaderSize + 1) return;
            const auto status = static_cast<wire::HelloStatus>(data[wire::kHeaderSize]);
            relayRegistered = status == wire::HelloStatus::Ok;
            relayHelloAttempts = 0;
            const juce::ScopedLock sl(statsLock);
            stats.relayStatus = status == wire::HelloStatus::Ok ? "registered"
                              : status == wire::HelloStatus::Expired ? "token expired (rejoin session)"
                              : "token rejected (relay secret mismatch?)";
            return;
        }
        case wire::PacketType::Probe: {
            if (!fromPeer || fromRelay) return;
            wire::writeHeader(txPacket, wire::PacketType::ProbeAck, sessionUuid, myUuid);
            sendTo(fromIp, fromPort, txPacket, wire::kHeaderSize);
            markDirect();
            return;
        }
        case wire::PacketType::ProbeAck:
            markDirect();
            return;
        case wire::PacketType::Ping: {
            uint64_t t = 0;
            if (!fromPeer || !wire::decodeTimestamp(data, len, t)) return;
            const int n = wire::encodeTimestampPacket(txPacket, wire::PacketType::Pong, sessionUuid, myUuid, t);
            sendTo(fromIp, fromPort, txPacket, n); // reply the way it came (direct or via relay)
            markDirect();
            return;
        }
        case wire::PacketType::Pong: {
            uint64_t t = 0;
            if (!fromPeer || !wire::decodeTimestamp(data, len, t)) return;
            const double rtt = (double) (nowMicros() - t) / 1000.0;
            if (rtt >= 0.0 && rtt < 5000.0)
                smoothedRtt = smoothedRtt < 0.0 ? rtt : smoothedRtt + (rtt - smoothedRtt) * 0.2;
            markDirect();
            return;
        }
        case wire::PacketType::Audio: {
            if (!fromPeer) return;
            uint32_t seq = 0;
            int frames = 0;
            if (!wire::decodeAudio(data, len, seq, rxL.data(), rxR.data(), (int) rxL.size(), frames)) return;
            rxBuffer.pushPacket(seq, rxL.data(), rxR.data(), frames, nowMs);
            packetsReceived.fetch_add(1);
            lastAudioRxMs = nowMs;
            markDirect();
            return;
        }
        default:
            return;
    }
}

void AudioTransport::serviceStun(double nowMs) {
    if (stunDone || stunHost.isEmpty() || nowMs < nextStunMs) return;
    if (stunAttempts >= 5) {
        if (stunAttempts == 5) {
            ++stunAttempts;
            const juce::ScopedLock sl(statsLock);
            stats.publicEndpoint = "unavailable (STUN blocked?)";
        }
        return;
    }
    uint8_t req[stun::kHeaderSize];
    stun::buildBindingRequest(req, stunTx);
    sendTo(stunHost, stunPort, req, (int) sizeof(req));
    ++stunAttempts;
    nextStunMs = nowMs + 1000.0;
}

void AudioTransport::serviceRelay(double nowMs) {
    if (cfg.relayHost.isEmpty() || cfg.relayPort <= 0 || cfg.relayToken.isEmpty()) {
        const juce::ScopedLock sl(statsLock);
        stats.relayStatus = "not configured";
        return;
    }
    if (nowMs < nextRelayMs) return;

    const int n = wire::encodeHello(txPacket, sessionUuid, myUuid, cfg.relayExpiresAt, cfg.relayToken);
    sendTo(cfg.relayHost, cfg.relayPort, txPacket, n);

    if (relayRegistered) {
        nextRelayMs = nowMs + kRelayRefreshMs;
    } else {
        ++relayHelloAttempts;
        nextRelayMs = nowMs + (relayHelloAttempts < 5 ? 1000.0 : 5000.0);
        if (relayHelloAttempts == 3) {
            const juce::ScopedLock sl(statsLock);
            stats.relayStatus = "unreachable at " + cfg.relayHost + ":" + juce::String(cfg.relayPort);
        }
    }
}

void AudioTransport::serviceDirect(double nowMs) {
    if (peerId.isEmpty()) return;

    if (directEstablished && nowMs - lastDirectRxMs > kDirectTimeoutMs) {
        directEstablished = false; // path died (NAT rebinding, network change) -> relay until re-punched
        probeUntilMs = nowMs + kProbeWindowMs;
    }
    if (directEstablished || peerCandidates.empty()) return;

    if (nowMs > probeUntilMs + kReprobeIntervalMs) probeUntilMs = nowMs + 2000.0; // periodic retry
    if (nowMs > probeUntilMs || nowMs < nextProbeMs) return;

    wire::writeHeader(txPacket, wire::PacketType::Probe, sessionUuid, myUuid);
    for (auto& c : peerCandidates) sendTo(c.ip, c.port, txPacket, wire::kHeaderSize);
    nextProbeMs = nowMs + 100.0;
}

void AudioTransport::servicePing(double nowMs) {
    if (peerId.isEmpty() || nowMs < nextPingMs) return;
    nextPingMs = nowMs + kPingIntervalMs;
    const int n = wire::encodeTimestampPacket(txPacket, wire::PacketType::Ping, sessionUuid, myUuid, nowMicros());
    sendToPeer(txPacket, n);
}

void AudioTransport::pumpOutgoingAudio() {
    const double host = hostRate.load();
    if (host != streamedHostRate) {
        streamedHostRate = host;
        txResampler.reset();
        tx48Count = 0;
    }

    const bool canSend = peerId.isNotEmpty() && ((directEstablished && !forceRelay.load()) || relayRegistered);
    int ready = txFifo.getNumReady();

    while (ready > 0) {
        const int n = juce::jmin(ready, kMaxHostChunk);
        float* dst[2] = { txHostL.data(), txHostR.data() };
        txFifo.read(dst, n);
        ready -= n;
        if (!canSend) continue; // nobody to send to: just keep the FIFO drained

        const int space = kTx48Capacity - tx48Count;
        if (std::abs(host - wire::kStreamSampleRate) < 0.5) {
            const int m = juce::jmin(n, space);
            std::memcpy(tx48L.data() + tx48Count, txHostL.data(), sizeof(float) * (size_t) m);
            std::memcpy(tx48R.data() + tx48Count, txHostR.data(), sizeof(float) * (size_t) m);
            tx48Count += m;
        } else {
            tx48Count += txResampler.process(txHostL.data(), txHostR.data(), n,
                                             tx48L.data() + tx48Count, tx48R.data() + tx48Count, space,
                                             host / wire::kStreamSampleRate);
        }

        int offset = 0;
        while (tx48Count - offset >= wire::kFramesPerPacket) {
            const int bytes = wire::encodeAudio(txPacket, (int) sizeof(txPacket), sessionUuid, myUuid, txSeq++,
                                                tx48L.data() + offset, tx48R.data() + offset, wire::kFramesPerPacket);
            if (sendToPeer(txPacket, bytes)) packetsSent.fetch_add(1);
            offset += wire::kFramesPerPacket;
        }
        if (offset > 0) {
            tx48Count -= offset;
            std::memmove(tx48L.data(), tx48L.data() + offset, sizeof(float) * (size_t) tx48Count);
            std::memmove(tx48R.data(), tx48R.data() + offset, sizeof(float) * (size_t) tx48Count);
        }
    }
}

} // namespace downbeat
