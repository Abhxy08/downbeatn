#pragma once

#include <juce_audio_basics/juce_audio_basics.h>
#include "SharedClip.h"
#include <array>
#include <atomic>
#include <cmath>

namespace downbeat {

/**
 * Audio-thread renderer for the shared clip: turns the looping 4-bar pattern into MIDI
 * events placed sample-accurately against the host's musical position (PPQ). Handles
 * loop wrap, transport jumps, stop, and edits (sounding notes are released, never stuck).
 * Real-time safe: no locks, no allocation (MidiBuffer is pre-sized in prepare()).
 */
class ClipPlayer {
public:
    static constexpr double kClipBeats = (double) SharedClip::kSteps / SharedClip::kStepsPerBeat; // 16

    explicit ClipPlayer(const SharedClip& c) : clip(c) {}

    void prepare(double sampleRate) {
        rate = sampleRate;
        reset();
    }

    void reset() {
        for (auto& e : activeEnd) e = -1.0;
        expectedPpq = -1.0;
        internalPpq = 0.0;
        anyActive = false;
    }

    /**
     * @param hostPlaying  host transport running (with a valid ppq)
     * @param previewPlaying  Standalone / no transport: run on an internal clock instead
     */
    void process(juce::MidiBuffer& out, int numSamples, bool hostPlaying, double hostPpq, double bpm, bool previewPlaying) noexcept {
        // Pick up edits; release anything sounding so removed/moved notes can't hang.
        if (clip.readSnapshot(notes, noteCount, seenSeq)) allNotesOff(out, 0);

        const bool playing = hostPlaying || previewPlaying;
        if (!playing || bpm <= 0.0) {
            if (anyActive) allNotesOff(out, 0);
            expectedPpq = -1.0;
            position.store(-1.0);
            return;
        }

        double ppqStart = hostPlaying ? hostPpq : internalPpq;
        const double beatsPerSample = bpm / 60.0 / rate;
        const double ppqEnd = ppqStart + numSamples * beatsPerSample;

        // Transport jumped (locate, loop in the DAW): release and start fresh.
        if (expectedPpq >= 0.0 && std::abs(ppqStart - expectedPpq) > 0.01 && anyActive) allNotesOff(out, 0);

        auto offsetOf = [&](double ppq) {
            return juce::jlimit(0, numSamples - 1, (int) std::floor((ppq - ppqStart) / beatsPerSample));
        };

        // Note-offs first (so a re-trigger on the same sample comes after)
        for (int p = 0; p < 128; ++p) {
            if (activeEnd[(size_t) p] >= 0.0 && activeEnd[(size_t) p] < ppqEnd) {
                out.addEvent(juce::MidiMessage::noteOff(1, p), offsetOf(juce::jmax(ppqStart, activeEnd[(size_t) p])));
                activeEnd[(size_t) p] = -1.0;
            }
        }

        // Note-ons for every loop iteration overlapping this block
        const double loopBase = std::floor(ppqStart / kClipBeats) * kClipBeats;
        for (int i = 0; i < noteCount; ++i) {
            const auto& n = notes[(size_t) i];
            const double on = (double) n.step / SharedClip::kStepsPerBeat;
            for (double base = loopBase; base < ppqEnd; base += kClipBeats) {
                const double t = base + on;
                if (t < ppqStart || t >= ppqEnd) continue;
                const int off = offsetOf(t);
                if (activeEnd[(size_t) n.pitch] >= 0.0) out.addEvent(juce::MidiMessage::noteOff(1, n.pitch), off);
                out.addEvent(juce::MidiMessage::noteOn(1, n.pitch, (juce::uint8) juce::jlimit(1, 127, n.velocity)), off);
                activeEnd[(size_t) n.pitch] = t + (double) n.length / SharedClip::kStepsPerBeat - 1e-6;
                anyActive = true;
            }
        }

        expectedPpq = ppqEnd;
        if (!hostPlaying) internalPpq = std::fmod(ppqEnd, kClipBeats * 1024.0);
        position.store(std::fmod(ppqEnd, kClipBeats) / kClipBeats);
    }

    /** 0..1 position within the clip for the UI playhead (-1 = stopped). Any thread. */
    double getPosition() const noexcept { return position.load(); }

private:
    void allNotesOff(juce::MidiBuffer& out, int sample) noexcept {
        for (int p = 0; p < 128; ++p) {
            if (activeEnd[(size_t) p] >= 0.0) {
                out.addEvent(juce::MidiMessage::noteOff(1, p), sample);
                activeEnd[(size_t) p] = -1.0;
            }
        }
        anyActive = false;
    }

    const SharedClip& clip;
    std::array<SharedClip::AudioNote, SharedClip::kMaxNotes> notes{};
    int noteCount{0};
    uint32_t seenSeq{0};
    std::array<double, 128> activeEnd{};
    bool anyActive{false};
    double rate{48000.0};
    double expectedPpq{-1.0};
    double internalPpq{0.0};
    std::atomic<double> position{-1.0};
};

/** Small built-in voice so the clip is audible in any DAW without MIDI routing: plucky filtered saw. */
class ClipVoice : public juce::SynthesiserVoice {
public:
    bool canPlaySound(juce::SynthesiserSound* s) override { return s != nullptr; }

    void startNote(int note, float velocity, juce::SynthesiserSound*, int) override {
        freq = juce::MidiMessage::getMidiNoteInHertz(note);
        amp = 0.18f * velocity;
        phase = 0.0;
        lp = 0.0f;
        env.setSampleRate(getSampleRate());
        env.setParameters({ 0.004f, 0.25f, 0.35f, 0.18f });
        env.noteOn();
    }

    void stopNote(float, bool allowTailOff) override {
        if (allowTailOff) env.noteOff();
        else { env.reset(); clearCurrentNote(); }
    }

    void pitchWheelMoved(int) override {}
    void controllerMoved(int, int) override {}

    void renderNextBlock(juce::AudioBuffer<float>& out, int start, int num) override {
        if (!isVoiceActive()) return;
        const double inc = freq / getSampleRate();
        const float cutoff = (float) juce::jlimit(0.02, 0.6, freq * 6.0 / getSampleRate());
        for (int i = 0; i < num; ++i) {
            const float saw = (float) (2.0 * phase - 1.0);
            phase += inc;
            if (phase >= 1.0) phase -= 1.0;
            const float e = env.getNextSample();
            lp += (cutoff * (0.4f + e)) * (saw - lp); // envelope opens the filter: pluck
            const float s = lp * amp * e;
            for (int ch = 0; ch < out.getNumChannels(); ++ch) out.addSample(ch, start + i, s);
            if (!env.isActive()) { clearCurrentNote(); break; }
        }
    }

private:
    juce::ADSR env;
    double freq{440.0}, phase{0.0};
    float amp{0.0f}, lp{0.0f};
};

struct ClipSound : juce::SynthesiserSound {
    bool appliesToNote(int) override { return true; }
    bool appliesToChannel(int) override { return true; }
};

} // namespace downbeat
