#pragma once

#include <juce_core/juce_core.h>
#include "AudioFifo.h"
#include "Resampler.h"
#include <atomic>
#include <cstring>
#include <memory>
#include <thread>
#include <vector>

namespace downbeat {

/**
 * Receive buffer for the Beat Jam (Lyria RealTime) stream.
 *  socket thread: pushPcm16()  48 kHz int16 stereo -> float -> resample to host rate -> lock-free FIFO
 *  audio thread : read()       never blocks/allocates; plays once ~0.5 s is buffered
 * Lyria delivers audio in bursts, so the buffer is deep (several seconds); latency doesn't
 * matter for a generated backing track.
 */
class BeatJamBuffer {
public:
    static constexpr int kStreamRate = 48000;
    static constexpr int kSlice = 2048;

    BeatJamBuffer() : fifo(std::make_unique<AudioFifo>(2, 96000 * 8 + 1)) {
        inL.assign(kSlice, 0.0f);
        inR.assign(kSlice, 0.0f);
        resampler.prepare(kSlice);
        outL.assign((size_t) StreamingResampler::maxOutputFor(kSlice, 0.2), 0.0f);
        outR.assign(outL.size(), 0.0f);
    }

    ~BeatJamBuffer() {
        accepting.store(false);
        while (pushesInFlight.load() != 0) std::this_thread::yield();
    }

    /** prepareToPlay (not real-time). */
    void prepare(double hostSampleRate) {
        accepting.store(false);
        while (pushesInFlight.load() != 0) std::this_thread::yield();
        hostRate.store(hostSampleRate);
        resampler.reset();
        fifo->reset();
        playing = false;
        accepting.store(true);
    }

    /** Socket thread: raw little-endian int16 interleaved stereo at 48 kHz. */
    void pushPcm16(const uint8_t* data, size_t bytes) {
        pushesInFlight.fetch_add(1);
        if (!accepting.load()) { pushesInFlight.fetch_sub(1); return; }

        const double ratio = (double) kStreamRate / hostRate.load();
        size_t frames = bytes / 4;
        const uint8_t* p = data;
        while (frames > 0) {
            const int n = (int) std::min<size_t>(frames, kSlice);
            for (int i = 0; i < n; ++i, p += 4) {
                inL[(size_t) i] = (float) (int16_t) (p[0] | (p[1] << 8)) / 32768.0f;
                inR[(size_t) i] = (float) (int16_t) (p[2] | (p[3] << 8)) / 32768.0f;
            }
            const int produced = resampler.process(inL.data(), inR.data(), n, outL.data(), outR.data(), (int) outL.size(), ratio);
            const float* outs[2] = { outL.data(), outR.data() };
            if (fifo->getFreeSpace() < produced) dropped.fetch_add(1);
            else fifo->write(outs, produced);
            frames -= (size_t) n;
        }
        received.fetch_add(bytes);
        pushesInFlight.fetch_sub(1);
    }

    /** Any thread: discard buffered audio at the next read (e.g. the jam stopped). */
    void requestFlush() noexcept { flushRequested.store(true); }

    /** Audio thread. Fills numSamples (silence while buffering). */
    void read(float* left, float* right, int numSamples) noexcept {
        if (flushRequested.exchange(false)) {
            float* dst[2] = { left, right };
            while (fifo->getNumReady() > 0) fifo->read(dst, std::min(numSamples, fifo->getNumReady()));
            playing = false;
        }
        const int ready = fifo->getNumReady();
        if (!playing && ready >= (int) (hostRate.load() * 0.5)) playing = true;

        int got = 0;
        if (playing) {
            float* dst[2] = { left, right };
            got = fifo->read(dst, numSamples);
            if (got < numSamples) playing = false; // re-buffer
        }
        if (got < numSamples) {
            std::memset(left + got, 0, sizeof(float) * (size_t) (numSamples - got));
            std::memset(right + got, 0, sizeof(float) * (size_t) (numSamples - got));
        }
        isPlayingFlag.store(playing);
    }

    float getBufferedSeconds() const noexcept {
        const double r = hostRate.load();
        return r > 0 ? (float) (fifo->getNumReady() / r) : 0.0f;
    }
    bool isPlaying() const noexcept { return isPlayingFlag.load(); }
    uint64_t getBytesReceived() const noexcept { return received.load(); }

private:
    const std::unique_ptr<AudioFifo> fifo;
    StreamingResampler resampler;
    std::vector<float> inL, inR, outL, outR;
    std::atomic<double> hostRate{48000.0};
    std::atomic<bool> accepting{false}, flushRequested{false}, isPlayingFlag{false};
    std::atomic<int> pushesInFlight{0};
    std::atomic<uint64_t> received{0}, dropped{0};
    bool playing{false}; // audio thread only

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(BeatJamBuffer)
};

} // namespace downbeat
