// Unit tests for the real-time audio core: lock-free FIFO, jitter buffer,
// resampler, UDP wire format and STUN parsing.
// Uses a CHECK macro (not assert) so tests also run in Release builds.

#include "JitterBuffer.h"
#include "AudioFifo.h"
#include "AudioPacket.h"
#include "Resampler.h"
#include "Stun.h"
#include "ClipPlayer.h"

#include <cmath>
#include <cstring>
#include <functional>
#include <iostream>
#include <vector>

using namespace downbeat;

static int g_failures = 0;
#define CHECK(cond)                                                                       \
    do {                                                                                  \
        if (!(cond)) {                                                                    \
            std::cerr << "    FAIL " << __FILE__ << ":" << __LINE__ << "  " #cond "\n";  \
            ++g_failures;                                                                 \
        }                                                                                 \
    } while (0)

static void run(const char* name, const std::function<void()>& fn) {
    const int before = g_failures;
    fn();
    std::cout << (g_failures == before ? "[PASS] " : "[FAIL] ") << name << "\n";
}

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------
constexpr int kFrames = 128;

/** Packet `seq` contains a constant value seq+1 (so we can identify it in the output). */
static void pushConst(JitterBuffer& jb, uint32_t seq, double arrivalMs = 0.0) {
    std::vector<float> l(kFrames, 0.001f * (float) (seq + 1)), r(kFrames, -0.001f * (float) (seq + 1));
    jb.pushPacket(seq, l.data(), r.data(), kFrames, arrivalMs);
}

/** Reads n samples from the jitter buffer in host-sized blocks. */
static std::vector<float> readN(JitterBuffer& jb, int n, int block = 64) {
    std::vector<float> outL((size_t) n), outR((size_t) n);
    for (int i = 0; i < n; i += block) {
        const int m = std::min(block, n - i);
        jb.read(outL.data() + i, outR.data() + i, m);
    }
    return outL;
}

// ----------------------------------------------------------------------------
// AudioFifo
// ----------------------------------------------------------------------------
static void testFifo() {
    AudioFifo fifo(2, 1024);
    CHECK(fifo.getFreeSpace() == 1023); // AbstractFifo keeps one slot free

    std::vector<float> l(300), r(300);
    for (int i = 0; i < 300; ++i) { l[(size_t) i] = (float) i; r[(size_t) i] = (float) -i; }
    const float* in[2] = { l.data(), r.data() };

    // wrap around the ring several times
    for (int round = 0; round < 10; ++round) {
        CHECK(fifo.write(in, 300) == 300);
        std::vector<float> ol(300), orr(300);
        float* out[2] = { ol.data(), orr.data() };
        CHECK(fifo.read(out, 300) == 300);
        for (int i = 0; i < 300; ++i) {
            CHECK(ol[(size_t) i] == (float) i);
            CHECK(orr[(size_t) i] == (float) -i);
        }
    }
    // overflow is truncated, never overwrites
    for (int i = 0; i < 5; ++i) fifo.write(in, 300);
    CHECK(fifo.getNumReady() == 1023);
}

// ----------------------------------------------------------------------------
// Jitter buffer
// ----------------------------------------------------------------------------
static void testJitterPrimesThenPlays() {
    JitterBuffer jb(20); // 20 ms @ 48k = 960 samples
    jb.prepare(48000.0, 512);

    // Before enough is buffered: silence.
    for (uint32_t s = 0; s < 4; ++s) pushConst(jb, s); // 512 samples < 960
    auto out = readN(jb, 64);
    CHECK(out[0] == 0.0f);
    CHECK(!jb.getStats().playing);

    for (uint32_t s = 4; s < 12; ++s) pushConst(jb, s); // 1536 samples >= 960
    out = readN(jb, 64);
    CHECK(jb.getStats().playing);
    // Audio is non-silent once playing (exact values are smoothed by the resampler's history)
    CHECK(std::abs(out[40]) > 0.0f);
}

static void testJitterInOrderContent() {
    JitterBuffer jb(10);
    jb.prepare(48000.0, 128);
    for (uint32_t s = 0; s < 20; ++s) pushConst(jb, s);
    auto out = readN(jb, 20 * kFrames - 8, 128);
    // After the 3-sample resampler warm-up, packet k is at [k*128 .. k*128+127] (+ small delay)
    CHECK(std::abs(out[5 * kFrames + 64] - 0.006f) < 1e-4f);
    CHECK(std::abs(out[10 * kFrames + 64] - 0.011f) < 1e-4f);
    auto st = jb.getStats();
    CHECK(st.packetsLost == 0);
    CHECK(st.packetsLate == 0);
}

static void testJitterReorders() {
    JitterBuffer jb(10);
    jb.prepare(48000.0, 128);
    // 0,1,3,2,4,5... (2 and 3 swapped) must play back in order with no loss
    const uint32_t order[] = { 0, 1, 3, 2, 4, 5, 6, 7, 8, 9, 10, 11 };
    for (auto s : order) pushConst(jb, s);
    auto out = readN(jb, 11 * kFrames, 128);
    CHECK(std::abs(out[2 * kFrames + 64] - 0.003f) < 1e-4f);
    CHECK(std::abs(out[3 * kFrames + 64] - 0.004f) < 1e-4f);
    CHECK(jb.getStats().packetsLost == 0);
}

static void testJitterConcealsLoss() {
    JitterBuffer jb(10);
    jb.prepare(48000.0, 128);
    for (uint32_t s = 0; s < 20; ++s)
        if (s != 5) pushConst(jb, s);
    auto st = jb.getStats();
    CHECK(st.packetsLost == 1);
    auto out = readN(jb, 18 * kFrames, 128);
    // The concealed slot fades the previous packet (0.005) out — never louder than it
    const float mid = out[5 * kFrames + 64];
    CHECK(std::abs(mid) < 0.005f);
    // and playback continues with packet 6 afterwards
    CHECK(std::abs(out[6 * kFrames + 64] - 0.007f) < 1e-4f);
}

static void testJitterDropsLatePackets() {
    JitterBuffer jb(10);
    jb.prepare(48000.0, 128);
    for (uint32_t s = 0; s < 10; ++s)
        if (s != 3) pushConst(jb, s);   // 3 is concealed once 6 arrives
    pushConst(jb, 3);                     // arrives too late
    CHECK(jb.getStats().packetsLate == 1);
    CHECK(jb.getStats().packetsLost == 1);
}

static void testJitterSenderRestart() {
    JitterBuffer jb(10);
    jb.prepare(48000.0, 128);
    for (uint32_t s = 1000; s < 1010; ++s) pushConst(jb, s);
    // sender restarted its sequence at 0: must be accepted, not treated as "late"
    for (uint32_t s = 0; s < 5; ++s) pushConst(jb, s);
    CHECK(jb.getStats().packetsLate == 0);
}

static void testJitterUnderrunRebuffers() {
    JitterBuffer jb(10); // 480 samples
    jb.prepare(48000.0, 128);
    for (uint32_t s = 0; s < 6; ++s) pushConst(jb, s); // 768 samples
    readN(jb, 1024, 128);                               // drains past the end
    auto st = jb.getStats();
    CHECK(st.underruns == 1);
    CHECK(!st.playing);
    // refills and plays again only after the target is re-buffered
    for (uint32_t s = 6; s < 9; ++s) pushConst(jb, s);  // 384 < 480
    auto out = readN(jb, 128, 128);
    CHECK(out[64] == 0.0f);
    for (uint32_t s = 9; s < 12; ++s) pushConst(jb, s);
    out = readN(jb, 128, 128);
    CHECK(out[64] != 0.0f);
}

static void testJitterResamplesToHostRate() {
    JitterBuffer jb(10);
    jb.prepare(44100.0, 128);
    for (uint32_t s = 0; s < 375; ++s) pushConst(jb, s); // 1 s @ 48k
    const float buffered = jb.getStats().bufferedMs;
    // ~1 s of 48k audio becomes ~1 s of 44.1k audio (minus overflow protection)
    CHECK(buffered > 50.0f);
    CHECK(jb.getStats().packetsLost == 0);
}

static void testJitterDriftConverges() {
    // Sender clock 0.1 % fast: without drift trim the buffer would grow ~1 ms every second.
    JitterBuffer jb(40);
    jb.prepare(48000.0, 480);
    std::vector<float> l(kFrames, 0.1f), r(kFrames, 0.1f), ol(480), orr(480);
    uint32_t seq = 0;
    double sent = 0.0, consumed = 0.0;
    for (int ms = 0; ms < 120000; ms += 10) {            // simulate 120 s in 10 ms audio callbacks
        const double sendRate = 48000.0 * 1.001;
        while (sent < (ms + 10) * sendRate / 1000.0) {
            jb.pushPacket(seq++, l.data(), r.data(), kFrames, ms);
            sent += kFrames;
        }
        jb.read(ol.data(), orr.data(), 480);
        consumed += 480;
    }
    const auto st = jb.getStats();
    CHECK(st.bufferedMs < 80.0f);   // stays near target instead of +120 ms
    CHECK(st.bufferedMs > 20.0f);
    CHECK(st.overflowDrops == 0);
}

static void testJitterArrivalJitter() {
    JitterBuffer jb(40);
    jb.prepare(48000.0, 128);
    const double spacing = 128 * 1000.0 / 48000.0;
    for (uint32_t s = 0; s < 200; ++s) pushConst(jb, s, s * spacing);           // perfect spacing
    CHECK(jb.getStats().arrivalJitterMs < 0.01f);
    for (uint32_t s = 200; s < 400; ++s) pushConst(jb, s, s * spacing + (s % 2 ? 5.0 : 0.0));
    CHECK(jb.getStats().arrivalJitterMs > 2.0f);
}

// ----------------------------------------------------------------------------
// Resampler
// ----------------------------------------------------------------------------
static void testResamplerRatio() {
    StreamingResampler rs;
    rs.prepare(128);
    std::vector<float> inL(128), inR(128), outL(512), outR(512);
    long produced = 0;
    for (int b = 0; b < 375; ++b) {                         // 1 s @ 48k in 128-frame blocks
        for (int i = 0; i < 128; ++i) {
            const double t = (b * 128 + i) / 48000.0;
            inL[(size_t) i] = inR[(size_t) i] = (float) std::sin(2.0 * juce::MathConstants<double>::pi * 440.0 * t);
        }
        produced += rs.process(inL.data(), inR.data(), 128, outL.data(), outR.data(), 512, 48000.0 / 44100.0);
    }
    CHECK(std::abs(produced - 44100) <= 3);
    // Output is still a clean 440 Hz sine: peak close to 1
    float peak = 0.0f;
    for (int i = 0; i < 100; ++i) peak = std::max(peak, std::abs(outL[(size_t) i]));
    CHECK(peak > 0.95f && peak < 1.05f);
}

// ----------------------------------------------------------------------------
// Wire format
// ----------------------------------------------------------------------------
static void testWireAudioRoundTrip() {
    wire::Uuid session, sender;
    CHECK(wire::Uuid::parse("c2a0c45f-635e-446e-8af0-de4dda6c07be", session));
    CHECK(wire::Uuid::parse("0123456789abcdef0123456789ABCDEF", sender));
    CHECK(session.toString() == "c2a0c45f-635e-446e-8af0-de4dda6c07be");
    wire::Uuid bad;
    CHECK(!wire::Uuid::parse("not-a-uuid", bad));

    std::vector<float> l(128), r(128);
    for (int i = 0; i < 128; ++i) { l[(size_t) i] = std::sin(i * 0.1f) * 0.9f; r[(size_t) i] = -l[(size_t) i]; }
    l[0] = 1.5f;   // clipped to +1
    r[0] = -1.5f;  // clipped to -1

    uint8_t buf[wire::kMaxPacketSize];
    const int n = wire::encodeAudio(buf, sizeof(buf), session, sender, 0xDEADBEEF, l.data(), r.data(), 128);
    CHECK(n == wire::kHeaderSize + wire::kAudioMetaSize + 128 * 6);
    CHECK(n <= 1472); // fits in one unfragmented IPv4 UDP datagram

    wire::Header h;
    CHECK(wire::parseHeader(buf, n, h));
    CHECK(h.type == wire::PacketType::Audio);
    CHECK(h.session == session);
    CHECK(h.sender == sender);

    std::vector<float> dl(256), dr(256);
    uint32_t seq = 0;
    int frames = 0;
    CHECK(wire::decodeAudio(buf, n, seq, dl.data(), dr.data(), 256, frames));
    CHECK(seq == 0xDEADBEEF);
    CHECK(frames == 128);
    CHECK(std::abs(dl[0] - 1.0f) < 1e-6f);
    CHECK(std::abs(dr[0] + 1.0f) < 1e-6f);
    for (int i = 1; i < 128; ++i) {
        CHECK(std::abs(dl[(size_t) i] - l[(size_t) i]) < 2.0f / 8388607.0f); // 24-bit precision
        CHECK(std::abs(dr[(size_t) i] - r[(size_t) i]) < 2.0f / 8388607.0f);
    }

    // truncated packet / wrong magic rejected
    CHECK(!wire::decodeAudio(buf, n - 10, seq, dl.data(), dr.data(), 256, frames));
    buf[0] = 'X';
    CHECK(!wire::parseHeader(buf, n, h));
}

static void testWireHelloAndPing() {
    wire::Uuid s, c;
    wire::Uuid::parse("11111111-2222-3333-4444-555555555555", s);
    wire::Uuid::parse("66666666-7777-8888-9999-aaaaaaaaaaaa", c);
    uint8_t buf[128];
    const int n = wire::encodeHello(buf, s, c, 1795168363577LL, "00112233445566778899aabbccddeeff");
    CHECK(n == 64);
    CHECK(wire::getU64(buf + 40) == 1795168363577ULL);
    CHECK(buf[48] == 0x00 && buf[49] == 0x11 && buf[63] == 0xff);

    const int p = wire::encodeTimestampPacket(buf, wire::PacketType::Ping, s, c, 123456789012345ULL);
    uint64_t t = 0;
    CHECK(wire::decodeTimestamp(buf, p, t));
    CHECK(t == 123456789012345ULL);
}

// ----------------------------------------------------------------------------
// STUN
// ----------------------------------------------------------------------------
static void testStun() {
    stun::TransactionId tx{};
    for (int i = 0; i < 12; ++i) tx[(size_t) i] = (uint8_t) (i * 7);

    uint8_t req[20];
    stun::buildBindingRequest(req, tx);
    CHECK(req[0] == 0x00 && req[1] == 0x01);
    CHECK(stun::looksLikeStun(req, 20));

    // Binding success with XOR-MAPPED-ADDRESS = 203.0.113.5:54321
    uint8_t resp[32] = { 0x01, 0x01, 0x00, 0x0C, 0x21, 0x12, 0xA4, 0x42 };
    std::memcpy(resp + 8, tx.data(), 12);
    resp[20] = 0x00; resp[21] = 0x20; resp[22] = 0x00; resp[23] = 0x08; // attr type/len
    resp[24] = 0x00; resp[25] = 0x01;                                    // family IPv4
    const uint16_t xport = 54321 ^ 0x2112;
    resp[26] = uint8_t(xport >> 8); resp[27] = uint8_t(xport);
    const uint32_t ip = (203u << 24) | (0u << 16) | (113u << 8) | 5u;
    const uint32_t xip = ip ^ 0x2112A442u;
    resp[28] = uint8_t(xip >> 24); resp[29] = uint8_t(xip >> 16); resp[30] = uint8_t(xip >> 8); resp[31] = uint8_t(xip);

    juce::String outIp;
    int outPort = 0;
    CHECK(stun::parseBindingResponse(resp, 32, tx, outIp, outPort));
    CHECK(outIp == "203.0.113.5");
    CHECK(outPort == 54321);

    // wrong transaction id is ignored
    stun::TransactionId other = tx;
    other[0] ^= 0xFF;
    CHECK(!stun::parseBindingResponse(resp, 32, other, outIp, outPort));

    // DownBeat packets are never mistaken for STUN
    uint8_t dwbt[64] = { 0x44, 0x57, 0x42, 0x54 };
    CHECK(!stun::looksLikeStun(dwbt, 64));

    juce::String host;
    int port = 0;
    stun::parseServer("stun:stun.l.google.com:19302", host, port);
    CHECK(host == "stun.l.google.com" && port == 19302);
    stun::parseServer("stun.example.org", host, port);
    CHECK(host == "stun.example.org" && port == 3478);
}

// ----------------------------------------------------------------------------
// Shared clip player
// ----------------------------------------------------------------------------
struct Ev { bool on; int pitch; int sample; };

static std::vector<Ev> render(ClipPlayer& p, int blocks, int block, bool playing, double startPpq, double bpm, double rate) {
    std::vector<Ev> out;
    juce::MidiBuffer mb;
    double ppq = startPpq;
    for (int b = 0; b < blocks; ++b) {
        mb.clear();
        p.process(mb, block, playing, ppq, bpm, false);
        for (const auto meta : mb) {
            const auto m = meta.getMessage();
            if (m.isNoteOn()) out.push_back({ true, m.getNoteNumber(), b * block + meta.samplePosition });
            else if (m.isNoteOff()) out.push_back({ false, m.getNoteNumber(), b * block + meta.samplePosition });
        }
        ppq += block * bpm / 60.0 / rate;
    }
    return out;
}

static void testClipTiming() {
    SharedClip clip;
    // step 4 = beat 1; length 2 steps = half a beat
    clip.replaceAll({ { "a", 4, 2, 60, 100, "u", "U" }, { "b", 0, 1, 64, 90, "u", "U" } });
    ClipPlayer p(clip);
    p.prepare(48000.0);
    // 120 BPM @ 48k: one beat = 24000 samples. Render 1.25 beats in 128-sample blocks.
    const auto ev = render(p, 320, 128, true, 0.0, 120.0, 48000.0); // 1.7 beats @ 120 BPM, 48k (1 beat = 24000 samples)
    auto find = [&](bool on, int pitch) { for (auto& e : ev) if (e.on == on && e.pitch == pitch) return e.sample; return -1; };
    CHECK(find(true, 64) == 0);
    CHECK(std::abs(find(false, 64) - 6000) <= 1);   // 1 step = quarter beat
    CHECK(std::abs(find(true, 60) - 24000) <= 1);
    CHECK(std::abs(find(false, 60) - 36000) <= 1);
}

static void testClipLoopsAndStops() {
    SharedClip clip;
    clip.replaceAll({ { "a", 0, 1, 60, 100, "u", "U" } });
    ClipPlayer p(clip);
    p.prepare(48000.0);
    // Start just before the end of bar 4 (beat 15.9): the note must fire again at beat 16 (= loop start)
    const double start = 15.9;
    const auto ev = render(p, 100, 64, true, start, 120.0, 48000.0);
    int ons = 0;
    for (auto& e : ev) ons += e.on ? 1 : 0;
    CHECK(ons == 1);
    CHECK(ev.size() >= 1 && ev[0].on && std::abs(ev[0].sample - (int) std::round(0.1 * 24000)) <= 1);

    // Stop while the note is sounding -> immediate note-off
    SharedClip c2;
    c2.replaceAll({ { "long", 0, 32, 48, 100, "u", "U" } });
    ClipPlayer p2(c2);
    p2.prepare(48000.0);
    render(p2, 10, 128, true, 0.0, 120.0, 48000.0);
    juce::MidiBuffer mb;
    p2.process(mb, 128, false, 0.0, 120.0, false);
    bool off = false;
    for (const auto meta : mb) off = off || meta.getMessage().isNoteOff();
    CHECK(off);
}

static void testClipEditReleasesNotes() {
    SharedClip clip;
    clip.replaceAll({ { "a", 0, 16, 72, 100, "u", "U" } });
    ClipPlayer p(clip);
    p.prepare(48000.0);
    juce::MidiBuffer mb;
    p.process(mb, 256, true, 0.0, 120.0, false);   // note on
    clip.remove("a");                               // collaborator deletes it mid-note
    mb.clear();
    p.process(mb, 256, true, 256 * 120.0 / 60.0 / 48000.0, 120.0, false);
    bool off = false;
    for (const auto meta : mb) off = off || (meta.getMessage().isNoteOff() && meta.getMessage().getNoteNumber() == 72);
    CHECK(off);                                     // never a stuck note
}

static void testClipSnapshotPacking() {
    for (int step : { 0, 63 })
        for (int len : { 1, 64 })
            for (int pitch : { 24, 108 }) {
                const auto n = SharedClip::unpack(SharedClip::pack(step, len, pitch, 127));
                CHECK(n.step == step && n.length == len && n.pitch == pitch && n.velocity == 127);
            }
}

int main() {
    std::cout << "DownBeat audio core tests\n";
    run("AudioFifo write/read/wrap/overflow", testFifo);
    run("JitterBuffer primes to target before playing", testJitterPrimesThenPlays);
    run("JitterBuffer in-order content", testJitterInOrderContent);
    run("JitterBuffer reorders out-of-order packets", testJitterReorders);
    run("JitterBuffer conceals a lost packet", testJitterConcealsLoss);
    run("JitterBuffer drops late packets", testJitterDropsLatePackets);
    run("JitterBuffer handles sender sequence restart", testJitterSenderRestart);
    run("JitterBuffer underrun re-buffers to target", testJitterUnderrunRebuffers);
    run("JitterBuffer resamples 48k -> 44.1k host", testJitterResamplesToHostRate);
    run("JitterBuffer clock-drift trim keeps latency stable", testJitterDriftConverges);
    run("JitterBuffer measures arrival jitter", testJitterArrivalJitter);
    run("Resampler 48k -> 44.1k length and quality", testResamplerRatio);
    run("Wire format audio round-trip (24-bit)", testWireAudioRoundTrip);
    run("Wire format HELLO + PING", testWireHelloAndPing);
    run("STUN binding request/response", testStun);
    run("Shared clip: sample-accurate note timing", testClipTiming);
    run("Shared clip: loops every 4 bars, releases on stop", testClipLoopsAndStops);
    run("Shared clip: deleting a sounding note releases it", testClipEditReleasesNotes);
    run("Shared clip: lock-free note packing", testClipSnapshotPacking);

    if (g_failures > 0) {
        std::cerr << g_failures << " check(s) failed\n";
        return 1;
    }
    std::cout << "All tests passed\n";
    return 0;
}
