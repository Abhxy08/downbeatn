#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include "AudioFifo.h"
#include "JitterBuffer.h"
#include "NetworkClient.h"
#include "BeatJamBuffer.h"
#include "MixCapture.h"
#include "SharedClip.h"
#include "ClipPlayer.h"

namespace downbeat {

class DownBeatAudioProcessor : public juce::AudioProcessor {
public:
    DownBeatAudioProcessor();
    ~DownBeatAudioProcessor() override;

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;

    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;

    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }

    const juce::String getName() const override { return "DownBeat"; }

    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return true; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;

    // Component accessors for UI
    NetworkClient& getNetworkClient() { return networkClient; }
    JitterBuffer& getJitterBuffer() { return rxJitterBuffer; }
    MixCapture& getMixCapture() { return mixCapture; }
    SharedClip& getSharedClip() { return sharedClip; }
    const ClipPlayer& getClipPlayer() const { return clipPlayer; }
    /** Standalone / stopped transport: play the shared clip on an internal clock. */
    void setClipPreview(bool on) noexcept { clipPreview.store(on); }
    bool isClipPreview() const noexcept { return clipPreview.load(); }
    juce::AudioProcessorValueTreeState& getAPVTS() { return parameters; }

    double getHostBpm() const noexcept { return currentBpm.load(); }

    /** Message/network thread: returns activity since the last call and resets the counters (lock-free). */
    ActivityWindow takeActivity() noexcept;
    bool getHostIsPlaying() const noexcept { return hostIsPlaying.load(); }
    /** False in the Standalone app or hosts that don't report tempo. */
    bool getHostProvidesTempo() const noexcept { return hostProvidesTempo.load(); }

private:
    // Lock-free ring buffer between audio thread and network thread
    AudioFifo txFifo;
    JitterBuffer rxJitterBuffer;
    BeatJamBuffer beatJamBuffer;
    MixCapture mixCapture;
    SharedClip sharedClip;
    ClipPlayer clipPlayer{sharedClip};
    juce::Synthesiser clipSynth;
    juce::MidiBuffer clipMidi;
    juce::AudioBuffer<float> clipAudio;
    std::atomic<bool> clipPreview{false};
    NetworkClient networkClient;

    // Host Transport state (lock-free atomics)
    std::atomic<double> currentBpm{120.0};
    std::atomic<bool> hostIsPlaying{false};
    std::atomic<bool> hostProvidesTempo{false};
    std::atomic<double> currentBeatPosition{0.0};

    // Activity counters written by the audio thread (atomics only — RT-safe)
    std::atomic<uint64_t> activeSamples{0}, totalSamples{0};
    std::atomic<float> peakLinear{0.0f};
    std::atomic<int> midiNoteCount{0}, lowestNote{128}, highestNote{-1};
    std::atomic<double> currentSampleRate{48000.0};
    juce::AudioBuffer<float> silenceBuffer;  // sent instead of input while "Mute my send" is on

    // Pre-allocated scratch audio buffer for real-time thread mixing (NO allocations in processBlock)
    juce::AudioBuffer<float> rxScratchBuffer;
    juce::AudioBuffer<float> beatJamScratch;

    // Parameters
    juce::AudioProcessorValueTreeState parameters;
    std::atomic<float>* remoteVolumeParam{nullptr};
    std::atomic<float>* beatJamVolumeParam{nullptr};
    std::atomic<float>* jitterMsParam{nullptr};
    std::atomic<float>* beatJamEnabledParam{nullptr};
    std::atomic<float>* sendMutedParam{nullptr};
    std::atomic<float>* clipSoundParam{nullptr};
    std::atomic<float>* clipMidiOutParam{nullptr};
    std::atomic<float>* clipVolumeParam{nullptr};

    juce::AudioProcessorValueTreeState::ParameterLayout createParameterLayout();

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(DownBeatAudioProcessor)
};

} // namespace downbeat
