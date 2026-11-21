#include "PluginProcessor.h"
#include "PluginEditor.h"

namespace downbeat {

juce::AudioProcessorValueTreeState::ParameterLayout DownBeatAudioProcessor::createParameterLayout() {
    std::vector<std::unique_ptr<juce::RangedAudioParameter>> params;

    params.push_back(std::make_unique<juce::AudioParameterFloat>(
        juce::ParameterID{"remoteVolume", 1},
        "Remote Volume",
        juce::NormalisableRange<float>{-60.0f, 6.0f, 0.1f},
        0.0f));

    params.push_back(std::make_unique<juce::AudioParameterFloat>(
        juce::ParameterID{"beatJamVolume", 1},
        "Beat Jam Volume",
        juce::NormalisableRange<float>{-60.0f, 6.0f, 0.1f},
        0.0f));

    params.push_back(std::make_unique<juce::AudioParameterInt>(
        juce::ParameterID{"jitterMs", 1},
        "Jitter Buffer (ms)",
        10, 200, 40));

    params.push_back(std::make_unique<juce::AudioParameterBool>(
        juce::ParameterID{"beatJamEnabled", 1},
        "Beat Jam Active",
        false));

    params.push_back(std::make_unique<juce::AudioParameterBool>(
        juce::ParameterID{"sendMuted", 1},
        "Mute My Send",
        false));

    params.push_back(std::make_unique<juce::AudioParameterBool>(
        juce::ParameterID{"clipSound", 1}, "Shared Clip: Built-in Synth", true));
    params.push_back(std::make_unique<juce::AudioParameterBool>(
        juce::ParameterID{"clipMidiOut", 1}, "Shared Clip: MIDI Out", true));
    params.push_back(std::make_unique<juce::AudioParameterFloat>(
        juce::ParameterID{"clipVolume", 1}, "Shared Clip Volume",
        juce::NormalisableRange<float>{-60.0f, 6.0f, 0.1f}, -6.0f));

    return { params.begin(), params.end() };
}

DownBeatAudioProcessor::DownBeatAudioProcessor()
    : AudioProcessor(BusesProperties()
                         .withInput("Input", juce::AudioChannelSet::stereo(), true)
                         .withOutput("Output", juce::AudioChannelSet::stereo(), true)),
      txFifo(2, 48000), // 1 second capacity at 48kHz
      rxJitterBuffer(40),
      networkClient(txFifo, rxJitterBuffer, beatJamBuffer, sharedClip),
      parameters(*this, nullptr, "Parameters", createParameterLayout())
{
    remoteVolumeParam = parameters.getRawParameterValue("remoteVolume");
    beatJamVolumeParam = parameters.getRawParameterValue("beatJamVolume");
    jitterMsParam = parameters.getRawParameterValue("jitterMs");
    beatJamEnabledParam = parameters.getRawParameterValue("beatJamEnabled");
    sendMutedParam = parameters.getRawParameterValue("sendMuted");
    clipSoundParam = parameters.getRawParameterValue("clipSound");
    clipMidiOutParam = parameters.getRawParameterValue("clipMidiOut");
    clipVolumeParam = parameters.getRawParameterValue("clipVolume");

    for (int i = 0; i < 8; ++i) clipSynth.addVoice(new ClipVoice());
    clipSynth.addSound(new ClipSound());

    // Feed the session event log (both called on the message thread)
    networkClient.setActivityProvider([this] { return takeActivity(); });
    networkClient.setParamProvider([this] {
        std::vector<std::pair<juce::String, juce::var>> v;
        v.emplace_back("collaboratorVolume", std::round(remoteVolumeParam->load() * 10.0) / 10.0);
        v.emplace_back("jitterBufferMs", (int) jitterMsParam->load());
        v.emplace_back("sendMuted", sendMutedParam->load() >= 0.5f);
        v.emplace_back("beatJam", beatJamEnabledParam->load() >= 0.5f);
        return v;
    });
}

namespace {
template <typename T, typename Cmp>
void atomicUpdate(std::atomic<T>& a, T v, Cmp better) noexcept {
    T cur = a.load(std::memory_order_relaxed);
    while (better(v, cur) && !a.compare_exchange_weak(cur, v, std::memory_order_relaxed)) {}
}
} // namespace

ActivityWindow DownBeatAudioProcessor::takeActivity() noexcept {
    ActivityWindow w;
    const double rate = juce::jmax(1.0, currentSampleRate.load());
    w.activeSeconds = (double) activeSamples.exchange(0) / rate;
    w.totalSeconds = (double) totalSamples.exchange(0) / rate;
    const float peak = peakLinear.exchange(0.0f);
    w.peakDb = juce::Decibels::gainToDecibels(peak, -160.0f);
    w.midiNotes = midiNoteCount.exchange(0);
    const int lo = lowestNote.exchange(128), hi = highestNote.exchange(-1);
    if (w.midiNotes > 0) { w.lowestNote = lo; w.highestNote = hi; }
    return w;
}

DownBeatAudioProcessor::~DownBeatAudioProcessor() {
    networkClient.setActivityProvider(nullptr);
    networkClient.setParamProvider(nullptr);
}

bool DownBeatAudioProcessor::isBusesLayoutSupported(const BusesLayout& layouts) const {
    if (layouts.getMainOutputChannelSet() != juce::AudioChannelSet::mono()
     && layouts.getMainOutputChannelSet() != juce::AudioChannelSet::stereo()) {
        return false;
    }

    if (layouts.getMainOutputChannelSet() != layouts.getMainInputChannelSet()) {
        return false;
    }

    return true;
}

void DownBeatAudioProcessor::prepareToPlay(double sampleRate, int samplesPerBlock) {
    // NB: txFifo is not reset here — the network thread may be reading it concurrently.
    // The transport drains stale audio itself when a session starts.
    const int targetLatency = static_cast<int>(jitterMsParam != nullptr ? jitterMsParam->load() : 40.0f);
    rxJitterBuffer.setTargetLatencyMs(targetLatency);
    rxJitterBuffer.prepare(sampleRate, samplesPerBlock);
    networkClient.setHostSampleRate(sampleRate);

    currentSampleRate.store(sampleRate);
    silenceBuffer.setSize(2, samplesPerBlock, false, true, true);
    silenceBuffer.clear();

    // Pre-allocate scratch buffer so processBlock NEVER allocates
    rxScratchBuffer.setSize(2, samplesPerBlock, false, false, true);
    rxScratchBuffer.clear();
    beatJamScratch.setSize(2, samplesPerBlock, false, false, true);
    beatJamScratch.clear();
    beatJamBuffer.prepare(sampleRate);
    mixCapture.prepare(sampleRate);
    clipPlayer.prepare(sampleRate);
    clipSynth.setCurrentPlaybackSampleRate(sampleRate);
    clipMidi.ensureSize(4096);
    clipAudio.setSize(2, samplesPerBlock, false, false, true);
}

void DownBeatAudioProcessor::releaseResources() {
    rxScratchBuffer.setSize(0, 0);
}

void DownBeatAudioProcessor::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midiMessages) {
    juce::ScopedNoDenormals noDenormals;

    const int totalNumInputChannels = getTotalNumInputChannels();
    const int totalNumOutputChannels = getTotalNumOutputChannels();
    const int numSamples = buffer.getNumSamples();

    for (auto i = totalNumInputChannels; i < totalNumOutputChannels; ++i) {
        buffer.clear(i, 0, numSamples);
    }

    // 1. Host Transport Sync via AudioPlayHead (Ableton Link / DAW tempo sync)
    bool tempoFromHost = false;
    bool hostPlayingWithPpq = false;
    double hostPpq = 0.0;
    if (auto* playHead = getPlayHead()) {
        if (auto positionInfo = playHead->getPosition()) {
            if (positionInfo->getBpm().hasValue()) {
                currentBpm.store(*positionInfo->getBpm());
                tempoFromHost = true;
            }
            hostIsPlaying.store(positionInfo->getIsPlaying());
            if (positionInfo->getPpqPosition().hasValue()) {
                hostPpq = *positionInfo->getPpqPosition();
                currentBeatPosition.store(hostPpq);
                hostPlayingWithPpq = positionInfo->getIsPlaying();
            }
        }
    }

    hostProvidesTempo.store(tempoFromHost);

    // 2. Transmit local DAW audio (lock-free push into FIFO for the network thread)
    const bool sendMuted = sendMutedParam->load() >= 0.5f;
    const float* inL = totalNumInputChannels >= 1 ? buffer.getReadPointer(0) : nullptr;
    const float* inR = totalNumInputChannels >= 2 ? buffer.getReadPointer(1) : inL;

    if (inL != nullptr && !sendMuted) {
        const float* const inputChannels[2] = { inL, inR };
        txFifo.write(inputChannels, numSamples);

        // Activity metering for the session log: count samples in blocks above -50 dBFS
        const float rms = juce::jmax(buffer.getRMSLevel(0, 0, numSamples),
                                     totalNumInputChannels >= 2 ? buffer.getRMSLevel(1, 0, numSamples) : 0.0f);
        const float peak = juce::jmax(buffer.getMagnitude(0, 0, numSamples),
                                      totalNumInputChannels >= 2 ? buffer.getMagnitude(1, 0, numSamples) : 0.0f);
        if (rms > 0.00316f) activeSamples.fetch_add((uint64_t) numSamples, std::memory_order_relaxed);
        atomicUpdate(peakLinear, peak, [](float a, float b) { return a > b; });
    } else if (silenceBuffer.getNumSamples() >= numSamples) {
        // keep the stream's timing intact while muted
        const float* const silent[2] = { silenceBuffer.getReadPointer(0), silenceBuffer.getReadPointer(1) };
        txFifo.write(silent, numSamples);
    }
    totalSamples.fetch_add((uint64_t) numSamples, std::memory_order_relaxed);

    // Mix Doctor capture (only copies while armed; lock-free)
    if (inL != nullptr) mixCapture.push(inL, inR, numSamples);

    // MIDI notes passing through this track
    for (const auto meta : midiMessages) {
        const auto msg = meta.getMessage();
        if (msg.isNoteOn()) {
            midiNoteCount.fetch_add(1, std::memory_order_relaxed);
            atomicUpdate(lowestNote, msg.getNoteNumber(), [](int a, int b) { return a < b; });
            atomicUpdate(highestNote, msg.getNoteNumber(), [](int a, int b) { return a > b; });
        }
    }

    // 3. Receive Remote Audio from Jitter Buffer into pre-allocated scratch buffer
    if (rxScratchBuffer.getNumSamples() < numSamples) {
        // Safety: should not happen if prepareToPlay was called with max samplesPerBlock
        return;
    }

    float* destChannels[2] = {
        rxScratchBuffer.getWritePointer(0),
        rxScratchBuffer.getWritePointer(1)
    };

    rxJitterBuffer.setTargetLatencyMs(static_cast<int>(jitterMsParam->load())); // atomic store, RT-safe
    rxJitterBuffer.read(destChannels[0], destChannels[1], numSamples);

    // 4. Mix Remote Peer Audio into DAW Output
    const float remoteGain = juce::Decibels::decibelsToGain(remoteVolumeParam != nullptr ? remoteVolumeParam->load() : 0.0f);

    if (remoteGain > 0.0001f) {
        if (totalNumOutputChannels >= 2) {
            buffer.addFrom(0, 0, rxScratchBuffer, 0, 0, numSamples, remoteGain);
            buffer.addFrom(1, 0, rxScratchBuffer, 1, 0, numSamples, remoteGain);
        } else if (totalNumOutputChannels == 1) {
            buffer.addFrom(0, 0, rxScratchBuffer, 0, 0, numSamples, remoteGain * 0.5f);
            buffer.addFrom(0, 0, rxScratchBuffer, 1, 0, numSamples, remoteGain * 0.5f);
        }
    }

    // 5. Shared MIDI clip: render against the host's musical position (or the preview clock)
    if (clipAudio.getNumSamples() >= numSamples) {
        clipMidi.clear();
        const double clipBpm = tempoFromHost ? currentBpm.load() : networkClient.getSessionBpm();
        clipPlayer.process(clipMidi, numSamples, hostPlayingWithPpq, hostPpq, clipBpm, clipPreview.load() && !hostPlayingWithPpq);
        if (clipSoundParam->load() >= 0.5f) {
            clipAudio.clear(0, numSamples);
            clipSynth.renderNextBlock(clipAudio, clipMidi, 0, numSamples);
            const float g = juce::Decibels::decibelsToGain(clipVolumeParam->load());
            for (int ch = 0; ch < juce::jmin(2, totalNumOutputChannels); ++ch)
                buffer.addFrom(ch, 0, clipAudio, ch, 0, numSamples, g);
        }
        if (clipMidiOutParam->load() >= 0.5f) midiMessages.addEvents(clipMidi, 0, numSamples, 0);
    }

    // 6. Beat Jam (Lyria RealTime) as its own toggleable track. Always read so the
    //    buffer doesn't hold stale audio while the user has it switched off.
    if (beatJamScratch.getNumSamples() >= numSamples) {
        beatJamBuffer.read(beatJamScratch.getWritePointer(0), beatJamScratch.getWritePointer(1), numSamples);
        const bool hearJam = beatJamEnabledParam->load() >= 0.5f;
        const float jamGain = juce::Decibels::decibelsToGain(beatJamVolumeParam->load());
        if (hearJam && jamGain > 0.0001f) {
            if (totalNumOutputChannels >= 2) {
                buffer.addFrom(0, 0, beatJamScratch, 0, 0, numSamples, jamGain);
                buffer.addFrom(1, 0, beatJamScratch, 1, 0, numSamples, jamGain);
            } else if (totalNumOutputChannels == 1) {
                buffer.addFrom(0, 0, beatJamScratch, 0, 0, numSamples, jamGain * 0.5f);
                buffer.addFrom(0, 0, beatJamScratch, 1, 0, numSamples, jamGain * 0.5f);
            }
        }
    }
}

juce::AudioProcessorEditor* DownBeatAudioProcessor::createEditor() {
    return new DownBeatAudioProcessorEditor(*this);
}

void DownBeatAudioProcessor::getStateInformation(juce::MemoryBlock& destData) {
    auto state = parameters.copyState();
    std::unique_ptr<juce::XmlElement> xml(state.createXml());
    copyXmlToBinary(*xml, destData);
}

void DownBeatAudioProcessor::setStateInformation(const void* data, int sizeInBytes) {
    std::unique_ptr<juce::XmlElement> xmlState(getXmlFromBinary(data, sizeInBytes));
    if (xmlState.get() != nullptr && xmlState->hasTagName(parameters.state.getType())) {
        parameters.replaceState(juce::ValueTree::fromXml(*xmlState));
    }
}

} // namespace downbeat

// JUCE Plugin Entry Point
juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() {
    return new downbeat::DownBeatAudioProcessor();
}
