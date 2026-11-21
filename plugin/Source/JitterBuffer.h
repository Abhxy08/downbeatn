#pragma once

#include <juce_core/juce_core.h>
#include <juce_audio_basics/juce_audio_basics.h>
#include "AudioFifo.h"
#include "Resampler.h"
#include <atomic>
#include <cstdint>
#include <memory>
#include <vector>

namespace downbeat {

struct JitterBufferStats {
    uint64_t packetsReceived{0};
    uint64_t packetsLate{0};        // arrived after their slot was already played/concealed
    uint64_t packetsLost{0};        // never arrived -> concealed
    uint64_t underruns{0};          // audio thread ran dry and had to re-buffer
    uint64_t overflowDrops{0};      // packets dropped because the buffer was far too full
    float arrivalJitterMs{0.0f};    // RFC 3550 inter-arrival jitter
    float bufferedMs{0.0f};         // audio currently queued for playback
    int targetMs{40};
    bool playing{false};            // false while (re)buffering
};

/**
 * Receive-side jitter buffer for one remote peer.
 *
 *  network thread:  pushPacket()  -> reorder -> conceal gaps -> resample 48k->host (+drift trim) -> FIFO
 *  audio thread:    read()        <- lock-free FIFO, waits until `target` ms are buffered before playing
 *
 * Only pushPacket() may be called from the network thread and only read() from the audio thread.
 * prepare() must not overlap read() (hosts guarantee this for prepareToPlay); it safely
 * excludes concurrent pushPacket() calls itself.
 */
class JitterBuffer {
public:
    static constexpr int kStreamRate = 48000;
    static constexpr int kMaxPacketFrames = 256;
    static constexpr int kReorderSlots = 64;
    static constexpr int kReorderWindow = 3; // packets we wait for a missing one before concealing it

    explicit JitterBuffer(int targetLatencyMs = 40);
    ~JitterBuffer();

    /** Allocates everything. Call from prepareToPlay (not real-time). */
    void prepare(double hostSampleRate, int maxBlockSize);

    void setTargetLatencyMs(int ms) noexcept;
    int getTargetLatencyMs() const noexcept { return targetMs.load(); }

    /** Network thread. `arrivalMs` = local monotonic arrival time (for jitter stats). */
    void pushPacket(uint32_t sequence, const float* left, const float* right, int frames, double arrivalMs);

    /** Network thread: forget reorder state (e.g. the remote peer changed). */
    void resetStream();

    /** Audio thread. Always fills exactly numSamples (silence while buffering). Never blocks or allocates. */
    void read(float* left, float* right, int numSamples) noexcept;

    JitterBufferStats getStats() const;
    double getHostSampleRate() const noexcept { return hostRate.load(); }

private:
    struct Slot {
        uint32_t seq{0};
        int frames{0};
        bool valid{false};
        std::vector<float> l, r;
    };

    void emit(const float* l, const float* r, int frames);
    void emitConcealment(int frames);
    void releaseInOrder();

    // --- configuration / shared ---
    std::atomic<int> targetMs;
    std::atomic<double> hostRate{0.0};
    std::atomic<bool> accepting{false};
    std::atomic<int> pushesInFlight{0};

    // --- network-thread state ---
    std::vector<Slot> slots;
    bool streamStarted{false};
    uint32_t expectedSeq{0};
    uint32_t highestSeq{0};
    std::vector<float> lastL, lastR;   // last emitted packet, for concealment
    int lastFrames{0};
    std::vector<float> concealL, concealR;
    std::vector<float> rsOutL, rsOutR;
    StreamingResampler resampler;
    double smoothedLevel{0.0};
    double lastArrivalMs{-1.0};
    uint32_t lastArrivalSeq{0};
    double jitterMs{0.0};

    // --- audio-thread state ---
    bool playing{false};

    const std::unique_ptr<AudioFifo> fifo;

    // --- stats ---
    std::atomic<uint64_t> statReceived{0}, statLate{0}, statLost{0}, statUnderruns{0}, statOverflow{0};
    std::atomic<float> statJitter{0.0f};
    std::atomic<bool> statPlaying{false};

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(JitterBuffer)
};

} // namespace downbeat
