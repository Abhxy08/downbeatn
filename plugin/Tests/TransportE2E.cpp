// End-to-end test of the UDP audio transport on this machine:
//   transport A (48 kHz host) --> transport B (44.1 kHz host)
// 1) direct P2P path via host candidates (hole punching on LAN addresses)
// 2) optionally the relay path, if DOWNBEAT_TEST_RELAY_PORT / DOWNBEAT_TEST_RELAY_SECRET are set
//    (run `npm run dev:relay` first). Relay tokens are signed here exactly like the server does.

#include "AudioTransport.h"
#include "JitterBuffer.h"
#include "AudioFifo.h"
#include <juce_cryptography/juce_cryptography.h>
#include <cmath>
#include <iostream>
#include <thread>

using namespace downbeat;

static int g_failures = 0;
#define CHECK(cond)                                                                      \
    do {                                                                                 \
        if (!(cond)) {                                                                   \
            std::cerr << "    FAIL " << __LINE__ << "  " #cond "\n";                    \
            ++g_failures;                                                                \
        }                                                                                \
    } while (0)

/** HMAC-SHA256(secret, msg) hex, first 32 chars — same as server/src/services/relayToken.ts */
static juce::String relayToken(const juce::String& secret, const juce::String& session, const juce::String& conn, int64_t exp) {
    juce::MemoryBlock key(secret.toRawUTF8(), secret.getNumBytesAsUTF8());
    if (key.getSize() > 64) key = juce::SHA256(key).getRawData();
    key.ensureSize(64, true);
    juce::MemoryBlock ipad(64), opad(64);
    for (size_t i = 0; i < 64; ++i) {
        ipad[i] = (char) ((uint8_t) key[i] ^ 0x36);
        opad[i] = (char) ((uint8_t) key[i] ^ 0x5c);
    }
    const auto msg = session.toLowerCase() + ":" + conn.toLowerCase() + ":" + juce::String(exp);
    juce::MemoryBlock inner(ipad);
    inner.append(msg.toRawUTF8(), msg.getNumBytesAsUTF8());
    juce::MemoryBlock outer(opad);
    outer.append(juce::SHA256(inner).getRawData().getData(), 32);
    return juce::SHA256(outer).toHexString().substring(0, 32);
}

struct Side {
    AudioFifo tx{2, 48000};
    JitterBuffer rx{40};
    AudioTransport transport{tx, rx};
    juce::String id = juce::Uuid().toDashedString();
};

/** Streams `seconds` of a 440 Hz sine A->B in real time; returns RMS of what B played. */
static double stream(Side& a, Side& b, double seconds) {
    std::vector<float> l(480), r(480), outL(441), outR(441);
    double phase = 0.0, sumSq = 0.0;
    long n = 0;
    const int steps = (int) (seconds * 100);
    auto next = std::chrono::steady_clock::now();
    for (int step = 0; step < steps; ++step) {
        for (int i = 0; i < 480; ++i) {
            l[(size_t) i] = r[(size_t) i] = (float) (0.8 * std::sin(phase));
            phase += 2.0 * juce::MathConstants<double>::pi * 440.0 / 48000.0;
        }
        const float* in[2] = { l.data(), r.data() };
        a.tx.write(in, 480);                     // "audio thread" of A: 10 ms @ 48k
        b.rx.read(outL.data(), outR.data(), 441); // "audio thread" of B: 10 ms @ 44.1k
        if (step > steps / 2)
            for (float s : outL) { sumSq += (double) s * s; ++n; }
        next += std::chrono::milliseconds(10);
        std::this_thread::sleep_until(next);
    }
    return n > 0 ? std::sqrt(sumSq / (double) n) : 0.0;
}

int main() {
    const juce::String session = juce::Uuid().toDashedString();
    const auto relayPort = juce::SystemStats::getEnvironmentVariable("DOWNBEAT_TEST_RELAY_PORT", {}).getIntValue();
    const auto relaySecret = juce::SystemStats::getEnvironmentVariable("DOWNBEAT_TEST_RELAY_SECRET", {});
    const int64_t exp = juce::Time::currentTimeMillis() + 3600 * 1000;

    Side a, b;
    a.rx.prepare(48000.0, 480);
    b.rx.prepare(44100.0, 441);
    a.transport.setHostSampleRate(48000.0);
    b.transport.setHostSampleRate(44100.0);

    auto cfgFor = [&](Side& s) {
        TransportConfig c;
        c.sessionId = session;
        c.myConnectionId = s.id;
        c.stunServer = {}; // no internet needed for this test
        if (relayPort > 0) {
            c.relayHost = "127.0.0.1";
            c.relayPort = relayPort;
            c.relayExpiresAt = exp;
            c.relayToken = relayToken(relaySecret, session, s.id, exp);
        }
        return c;
    };
    a.transport.start(cfgFor(a));
    b.transport.start(cfgFor(b));
    std::this_thread::sleep_for(std::chrono::milliseconds(300));

    // What the WebSocket signalling would normally do:
    a.transport.setRemotePeer(b.id, "B");
    b.transport.setRemotePeer(a.id, "A");
    a.transport.addRemoteCandidates(b.id, b.transport.getLocalCandidates());
    b.transport.addRemoteCandidates(a.id, a.transport.getLocalCandidates());
    std::cout << "A candidates: " << a.transport.getLocalCandidates().size()
              << ", B candidates: " << b.transport.getLocalCandidates().size() << "\n";

    // ---- 1) direct P2P ----
    const double rmsDirect = stream(a, b, 3.0);
    auto sa = a.transport.getStats();
    auto sb = b.transport.getStats();
    auto jb = b.rx.getStats();
    std::cout << "[direct] A path=" << (int) sa.sendPath << " rtt=" << sa.rttMs << "ms sent=" << sa.packetsSent
              << " | B recv=" << jb.packetsReceived << " lost=" << jb.packetsLost << " late=" << jb.packetsLate
              << " underruns=" << jb.underruns << " buffered=" << jb.bufferedMs << "ms rms=" << rmsDirect << "\n";
    CHECK(sa.sendPath == AudioPath::Direct);
    CHECK(sb.directEstablished);
    CHECK(sa.rttMs >= 0.0f && sa.rttMs < 50.0f);
    CHECK(jb.packetsReceived > 1000);   // ~375 packets/s
    CHECK(jb.packetsLost == 0);
    CHECK(rmsDirect > 0.5 && rmsDirect < 0.65); // 0.8-amplitude sine -> RMS 0.566

    // ---- 2) relay ----
    if (relayPort > 0) {
        a.transport.setForceRelay(true);
        b.transport.setForceRelay(true);
        const uint64_t before = b.rx.getStats().packetsReceived;
        const double rmsRelay = stream(a, b, 3.0);
        sa = a.transport.getStats();
        jb = b.rx.getStats();
        std::cout << "[relay]  A path=" << (int) sa.sendPath << " relay=" << sa.relayStatus << " rtt=" << sa.rttMs
                  << "ms | B recv+=" << (jb.packetsReceived - before) << " lost=" << jb.packetsLost
                  << " rms=" << rmsRelay << "\n";
        CHECK(sa.relayStatus == "registered");
        CHECK(sa.sendPath == AudioPath::Relay);
        CHECK(jb.packetsReceived - before > 1000);
        CHECK(rmsRelay > 0.5 && rmsRelay < 0.65);
    } else {
        std::cout << "[relay]  skipped (set DOWNBEAT_TEST_RELAY_PORT and DOWNBEAT_TEST_RELAY_SECRET)\n";
    }

    a.transport.stop();
    b.transport.stop();
    if (g_failures) {
        std::cerr << g_failures << " check(s) failed\n";
        return 1;
    }
    std::cout << "Transport E2E passed\n";
    return 0;
}
