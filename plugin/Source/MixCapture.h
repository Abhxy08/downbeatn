#pragma once

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_events/juce_events.h>
#include "AudioFifo.h"
#include <atomic>
#include <functional>

namespace downbeat {

/**
 * Records what passes through the plugin (put DownBeat on the master bus to capture the
 * whole mix) for Mix Doctor. The audio thread only writes into a lock-free FIFO while
 * armed; a message-thread timer drains it and encodes a 24-bit WAV when done.
 */
class MixCapture : private juce::Timer {
public:
    MixCapture() : fifo(2, 192000 * 2 + 1) {}
    ~MixCapture() override { stopTimer(); }

    /** prepareToPlay (not real-time). */
    void prepare(double sampleRate) {
        cancel();
        rate.store(sampleRate);
    }

    /** Message thread. Calls onFinished(wavData) when `seconds` of audio have been captured. */
    void start(double seconds, std::function<void(juce::MemoryBlock wav, double seconds)> onFinished) {
        cancel();
        targetSeconds = seconds;
        finished = std::move(onFinished);
        captured.setSize(2, (int) (seconds * rate.load()) + 1, false, true, false);
        capturedFrames = 0;
        armed.store(true);
        startTimerHz(20);
    }

    void cancel() {
        armed.store(false);
        stopTimer();
        drain(true);
        capturedFrames = 0;
        finished = nullptr;
    }

    /** Audio thread: lock-free, no allocation. */
    void push(const float* l, const float* r, int n) noexcept {
        if (!armed.load(std::memory_order_relaxed)) return;
        const float* ch[2] = { l, r != nullptr ? r : l };
        fifo.write(ch, n);
    }

    bool isCapturing() const noexcept { return armed.load(); }
    /** Peak of the last capture (message thread, valid inside/after onFinished). */
    float capturedPeak() const { return capturedFrames > 0 ? captured.getMagnitude(0, capturedFrames) : 0.0f; }
    double progress() const noexcept { return targetSeconds > 0 ? capturedSeconds() / targetSeconds : 0.0; }
    double capturedSeconds() const noexcept { return capturedFrames / juce::jmax(1.0, rate.load()); }

private:
    void timerCallback() override {
        drain(false);
        if (capturedFrames >= captured.getNumSamples() - 1) {
            armed.store(false);
            stopTimer();
            drain(true);
            if (finished) {
                auto cb = std::move(finished);
                finished = nullptr;
                cb(encodeWav(), capturedSeconds());
            }
        }
    }

    void drain(bool discard) {
        float tmpL[1024], tmpR[1024];
        float* dst[2] = { tmpL, tmpR };
        while (fifo.getNumReady() > 0) {
            const int n = fifo.read(dst, juce::jmin(1024, fifo.getNumReady()));
            if (discard) continue;
            const int room = juce::jmin(n, captured.getNumSamples() - capturedFrames);
            if (room <= 0) continue;
            captured.copyFrom(0, capturedFrames, tmpL, room);
            captured.copyFrom(1, capturedFrames, tmpR, room);
            capturedFrames += room;
        }
    }

    juce::MemoryBlock encodeWav() {
        juce::MemoryBlock block;
        {
            auto stream = std::make_unique<juce::MemoryOutputStream>(block, false);
            juce::WavAudioFormat wav;
            std::unique_ptr<juce::AudioFormatWriter> writer(
                wav.createWriterFor(stream.get(), rate.load(), 2, 24, {}, 0));
            if (writer != nullptr) {
                stream.release(); // owned by the writer now
                writer->writeFromAudioSampleBuffer(captured, 0, capturedFrames);
            }
        }
        return block;
    }

    AudioFifo fifo;
    std::atomic<bool> armed{false};
    std::atomic<double> rate{48000.0};
    juce::AudioBuffer<float> captured;
    int capturedFrames{0};
    double targetSeconds{0.0};
    std::function<void(juce::MemoryBlock, double)> finished;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MixCapture)
};

} // namespace downbeat
