#pragma once

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>
#include <vector>
#include <cstring>

namespace downbeat {

/**
 * Lock-free Audio Ring Buffer using juce::AbstractFifo.
 * Strictly adheres to real-time audio thread constraints:
 * - Zero allocations on push/pop.
 * - Zero mutexes/locks.
 * Transfers 48kHz 24-bit PCM float samples between real-time audio thread
 * and asynchronous network worker threads.
 */
class AudioFifo {
public:
    AudioFifo(int numChannels, int capacityInSamples)
        : channels(numChannels),
          capacity(capacityInSamples),
          fifo(capacityInSamples)
    {
        buffer.setSize(numChannels, capacityInSamples);
        buffer.clear();
    }

    void reset() {
        fifo.reset();
        buffer.clear();
    }

    int getNumChannels() const noexcept { return channels; }
    int getCapacity() const noexcept { return capacity; }
    int getNumReady() const noexcept { return fifo.getNumReady(); }
    int getFreeSpace() const noexcept { return fifo.getFreeSpace(); }

    /**
     * Real-time audio safe write into FIFO (e.g. from DAW input to transmit buffer)
     */
    int write(const float* const* channelData, int numSamples) noexcept {
        const int samplesToWrite = juce::jmin(numSamples, fifo.getFreeSpace());
        if (samplesToWrite <= 0) return 0;

        int startIndex1, blockSize1, startIndex2, blockSize2;
        fifo.prepareToWrite(samplesToWrite, startIndex1, blockSize1, startIndex2, blockSize2);

        if (blockSize1 > 0) {
            for (int ch = 0; ch < channels; ++ch) {
                if (channelData[ch] != nullptr) {
                    buffer.copyFrom(ch, startIndex1, channelData[ch], blockSize1);
                }
            }
        }

        if (blockSize2 > 0) {
            for (int ch = 0; ch < channels; ++ch) {
                if (channelData[ch] != nullptr) {
                    buffer.copyFrom(ch, startIndex2, channelData[ch] + blockSize1, blockSize2);
                }
            }
        }

        fifo.finishedWrite(samplesToWrite);
        return samplesToWrite;
    }

    /**
     * Real-time audio safe read from FIFO (e.g. from receive buffer to DAW output)
     */
    int read(float* const* channelData, int numSamples) noexcept {
        const int samplesToRead = juce::jmin(numSamples, fifo.getNumReady());
        if (samplesToRead <= 0) return 0;

        int startIndex1, blockSize1, startIndex2, blockSize2;
        fifo.prepareToRead(samplesToRead, startIndex1, blockSize1, startIndex2, blockSize2);

        if (blockSize1 > 0) {
            for (int ch = 0; ch < channels; ++ch) {
                if (channelData[ch] != nullptr) {
                    juce::FloatVectorOperations::copy(channelData[ch], buffer.getReadPointer(ch, startIndex1), blockSize1);
                }
            }
        }

        if (blockSize2 > 0) {
            for (int ch = 0; ch < channels; ++ch) {
                if (channelData[ch] != nullptr) {
                    juce::FloatVectorOperations::copy(channelData[ch] + blockSize1, buffer.getReadPointer(ch, startIndex2), blockSize2);
                }
            }
        }

        fifo.finishedRead(samplesToRead);
        return samplesToRead;
    }

private:
    const int channels;
    const int capacity;
    juce::AbstractFifo fifo;
    juce::AudioBuffer<float> buffer;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(AudioFifo)
};

} // namespace downbeat
