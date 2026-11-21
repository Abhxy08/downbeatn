#pragma once

#include <juce_gui_basics/juce_gui_basics.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include "PluginProcessor.h"
#include "DownBeatLookAndFeel.h"

namespace downbeat {

/**
 * Piano roll for the session's shared clip. Everyone in the session edits the same notes live.
 *  click empty cell = add (drag right to lengthen) · drag note = move · drag right edge = resize
 *  click / right-click note = delete
 */
class SharedClipEditor : public juce::Component, private juce::Timer {
public:
    explicit SharedClipEditor(DownBeatAudioProcessor& p) : proc(p) {
        auto setupButton = [this](juce::TextButton& b, const juce::String& text, std::function<void()> fn) {
            b.setButtonText(text);
            b.onClick = std::move(fn);
            addAndMakeVisible(b);
        };
        setupButton(octDown, "Oct -", [this] { lowestPitch = juce::jmax(24, lowestPitch - 12); repaint(); });
        setupButton(octUp, "Oct +", [this] { lowestPitch = juce::jmin(108 - kRows + 1, lowestPitch + 12); repaint(); });
        setupButton(clearButton, "Clear", [this] {
            if (!proc.getSharedClip().getNotes().empty()) proc.getNetworkClient().clipClear();
        });
        previewButton.setButtonText("Preview");
        previewButton.setClickingTogglesState(true);
        previewButton.setTooltip("Play the clip on its own (Standalone or stopped DAW). In a DAW it follows your transport.");
        previewButton.onClick = [this] { proc.setClipPreview(previewButton.getToggleState()); };
        addAndMakeVisible(previewButton);

        soundToggle.setButtonText("Built-in synth");
        soundToggle.setTooltip("Play the clip with DownBeat's own synth (works in every DAW)");
        midiToggle.setButtonText("MIDI out");
        midiToggle.setTooltip("Also output the clip as MIDI (route it to your own instrument, e.g. next FX in REAPER)");
        addAndMakeVisible(soundToggle);
        addAndMakeVisible(midiToggle);
        soundAttach = std::make_unique<juce::AudioProcessorValueTreeState::ButtonAttachment>(p.getAPVTS(), "clipSound", soundToggle);
        midiAttach = std::make_unique<juce::AudioProcessorValueTreeState::ButtonAttachment>(p.getAPVTS(), "clipMidiOut", midiToggle);

        volume.setSliderStyle(juce::Slider::LinearHorizontal);
        volume.setTextBoxStyle(juce::Slider::TextBoxRight, false, 52, 18);
        volume.setTextValueSuffix(" dB");
        volume.setTooltip("Built-in synth volume");
        addAndMakeVisible(volume);
        volumeAttach = std::make_unique<juce::AudioProcessorValueTreeState::SliderAttachment>(p.getAPVTS(), "clipVolume", volume);

        info.setFont(juce::FontOptions(11.0f));
        info.setColour(juce::Label::textColourId, DownBeatLookAndFeel::muted);
        info.setMinimumHorizontalScale(0.7f);
        addAndMakeVisible(info);

        startTimerHz(30);
    }

    void setEnabledForSession(bool connected) {
        if (connected == sessionConnected) return;
        sessionConnected = connected;
        for (auto* c : std::initializer_list<juce::Component*>{ &clearButton, &previewButton }) c->setEnabled(connected);
        repaint();
    }

    void setMyUserId(const juce::String& uid) { myUid = uid; }

    void resized() override {
        auto r = getLocalBounds();
        auto top = r.removeFromTop(26);
        octDown.setBounds(top.removeFromLeft(52));
        top.removeFromLeft(4);
        octUp.setBounds(top.removeFromLeft(52));
        top.removeFromLeft(8);
        previewButton.setBounds(top.removeFromLeft(74));
        top.removeFromLeft(4);
        clearButton.setBounds(top.removeFromLeft(56));
        top.removeFromLeft(10);
        volume.setBounds(top.removeFromRight(170));
        midiToggle.setBounds(top.removeFromRight(86));
        soundToggle.setBounds(top.removeFromRight(118));
        info.setBounds(top);
        r.removeFromTop(6);
        grid = r.withTrimmedLeft(kKeyWidth);
        keys = r.withWidth(kKeyWidth);
    }

    void paint(juce::Graphics& g) override {
        const float rowH = rowHeight(), stepW = stepWidth();

        // Keyboard + row stripes
        for (int row = 0; row < kRows; ++row) {
            const int pitch = lowestPitch + (kRows - 1 - row);
            const bool black = juce::MidiMessage::isMidiNoteBlack(pitch);
            const float y = (float) grid.getY() + row * rowH;
            g.setColour(black ? juce::Colour(0xff0c0e14) : juce::Colour(0xff121520));
            g.fillRect((float) grid.getX(), y, (float) grid.getWidth(), rowH);
            g.setColour(black ? juce::Colour(0xff1b1e28) : juce::Colour(0xffcbd5e1));
            g.fillRect((float) keys.getX(), y, (float) keys.getWidth() - 2.0f, rowH - 1.0f);
            if (pitch % 12 == 0) {
                g.setColour(juce::Colour(0xff0c0d11));
                g.setFont(juce::FontOptions(juce::jmin(10.0f, rowH)));
                g.drawText(juce::MidiMessage::getMidiNoteName(pitch, true, true, 4), keys.withY((int) y).withHeight((int) rowH).reduced(3, 0),
                           juce::Justification::centredRight);
            }
        }

        // Beat / bar lines
        for (int s = 0; s <= SharedClip::kSteps; ++s) {
            const float x = (float) grid.getX() + s * stepW;
            g.setColour(s % 16 == 0 ? juce::Colour(0xff3b4256) : s % 4 == 0 ? juce::Colour(0xff252a38) : juce::Colour(0xff181b25));
            g.drawVerticalLine((int) x, (float) grid.getY(), (float) grid.getBottom());
        }

        // Notes
        const auto notes = proc.getSharedClip().getNotes();
        int mine = 0, theirs = 0, hidden = 0;
        for (const auto& n : notes) {
            (n.byUid == myUid ? mine : theirs)++;
            const auto rect = noteRect(n);
            if (rect.isEmpty()) { ++hidden; continue; }
            const auto base = n.byUid == myUid ? DownBeatLookAndFeel::accentHi : juce::Colour(0xff22d3ee);
            g.setColour(base.withAlpha(0.45f + 0.55f * n.velocity / 127.0f));
            g.fillRoundedRectangle(rect, 2.5f);
            g.setColour(base.brighter(0.4f));
            g.drawRoundedRectangle(rect, 2.5f, 1.0f);
        }

        // Playhead
        const double pos = proc.getClipPlayer().getPosition();
        if (pos >= 0.0) {
            const float x = (float) grid.getX() + (float) pos * (float) grid.getWidth();
            g.setColour(juce::Colour(0xfff59e0b));
            g.drawLine(x, (float) grid.getY(), x, (float) grid.getBottom(), 1.5f);
        }

        if (!sessionConnected) {
            g.setColour(juce::Colour(0xcc0c0d11));
            g.fillRect(grid);
            g.setColour(DownBeatLookAndFeel::muted);
            g.setFont(juce::FontOptions(13.0f));
            g.drawText("Join a session to write a clip together", grid, juce::Justification::centred);
        }

        juce::String text;
        text << "4-bar loop, 1/16 grid  |  you: " << mine << "  others: " << theirs;
        if (hidden > 0) text << "  (" << hidden << " outside this octave view)";
        info.setText(text, juce::dontSendNotification);
    }

    void mouseDown(const juce::MouseEvent& e) override {
        drag = Drag::None;
        if (!sessionConnected || !grid.contains(e.getPosition())) return;
        auto& net = proc.getNetworkClient();

        if (auto* n = noteAt(e.position)) {
            if (e.mods.isPopupMenu()) {
                net.clipRemove(n->id);
                return;
            }
            dragNote = *n;
            original = *n;
            const auto r = noteRect(*n);
            drag = (e.position.x > r.getRight() - juce::jmax(6.0f, r.getWidth() * 0.3f)) ? Drag::Resize : Drag::Move;
            grabOffset = stepAt(e.position.x) - n->step;
            return;
        }

        if (e.mods.isPopupMenu()) return;
        const int step = stepAt(e.position.x), pitch = pitchAt(e.position.y);
        net.clipAdd(step, 1, pitch, 100);
        // pick up the note we just created so a drag can lengthen it
        original = {};
        for (const auto& n : proc.getSharedClip().getNotes())
            if (n.step == step && n.pitch == pitch && n.byUid == myUid) { dragNote = n; original = n; }
        drag = original.id.isEmpty() ? Drag::None : Drag::Create;
    }

    void mouseDrag(const juce::MouseEvent& e) override {
        if (drag == Drag::None) return;
        const int step = stepAt(e.position.x);
        auto n = original;
        if (drag == Drag::Create || drag == Drag::Resize) {
            n.length = juce::jlimit(1, SharedClip::kSteps - n.step, step - n.step + 1);
        } else {
            n.step = juce::jlimit(0, SharedClip::kSteps - n.length, step - grabOffset);
            n.pitch = juce::jlimit(24, 108, pitchAt(e.position.y));
        }
        if (n.step != dragNote.step || n.length != dragNote.length || n.pitch != dragNote.pitch) {
            dragNote = n;
            proc.getSharedClip().upsert(n); // local preview; sent on mouse up
            repaint();
        }
    }

    void mouseUp(const juce::MouseEvent&) override {
        auto& net = proc.getNetworkClient();
        const bool changed = dragNote.step != original.step || dragNote.length != original.length || dragNote.pitch != original.pitch;
        if (drag == Drag::Move && !changed) net.clipRemove(original.id); // a click on a note deletes it
        else if (drag != Drag::None && changed) net.clipUpdate(dragNote);
        drag = Drag::None;
    }

    juce::MouseCursor getMouseCursor() override { return juce::MouseCursor::PointingHandCursor; }

private:
    static constexpr int kRows = 24;
    static constexpr int kKeyWidth = 34;

    enum class Drag { None, Create, Move, Resize };

    void timerCallback() override {
        const auto v = proc.getSharedClip().getVersion();
        const double pos = proc.getClipPlayer().getPosition();
        if (v != seenVersion || pos >= 0.0 || lastPos >= 0.0) {
            seenVersion = v;
            lastPos = pos;
            repaint();
        }
        if (previewButton.getToggleState() != proc.isClipPreview()) previewButton.setToggleState(proc.isClipPreview(), juce::dontSendNotification);
    }

    float rowHeight() const { return (float) grid.getHeight() / kRows; }
    float stepWidth() const { return (float) grid.getWidth() / SharedClip::kSteps; }
    int stepAt(float x) const { return juce::jlimit(0, SharedClip::kSteps - 1, (int) ((x - grid.getX()) / stepWidth())); }
    int pitchAt(float y) const { return lowestPitch + (kRows - 1 - juce::jlimit(0, kRows - 1, (int) ((y - grid.getY()) / rowHeight()))); }

    juce::Rectangle<float> noteRect(const SharedClip::Note& n) const {
        const int row = kRows - 1 - (n.pitch - lowestPitch);
        if (row < 0 || row >= kRows) return {};
        return { (float) grid.getX() + n.step * stepWidth() + 1.0f, (float) grid.getY() + row * rowHeight() + 1.0f,
                 n.length * stepWidth() - 2.0f, rowHeight() - 2.0f };
    }

    const SharedClip::Note* noteAt(juce::Point<float> p) {
        cached = proc.getSharedClip().getNotes();
        for (auto it = cached.rbegin(); it != cached.rend(); ++it)
            if (noteRect(*it).contains(p)) return &*it;
        return nullptr;
    }

    DownBeatAudioProcessor& proc;
    juce::TextButton octDown, octUp, clearButton, previewButton;
    juce::ToggleButton soundToggle, midiToggle;
    juce::Slider volume;
    juce::Label info;
    std::unique_ptr<juce::AudioProcessorValueTreeState::ButtonAttachment> soundAttach, midiAttach;
    std::unique_ptr<juce::AudioProcessorValueTreeState::SliderAttachment> volumeAttach;

    juce::Rectangle<int> grid, keys;
    int lowestPitch{48}; // C3..B4
    juce::String myUid;
    bool sessionConnected{true};
    uint32_t seenVersion{~0u};
    double lastPos{-1.0};

    Drag drag{Drag::None};
    SharedClip::Note dragNote, original;
    int grabOffset{0};
    std::vector<SharedClip::Note> cached;
};

} // namespace downbeat
