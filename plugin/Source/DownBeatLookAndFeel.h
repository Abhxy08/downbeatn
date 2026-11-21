#pragma once

#include <juce_gui_basics/juce_gui_basics.h>

namespace downbeat {

/** Dark theme matching the web app (Tailwind slate/indigo). Mark a button primary with
 *  button.getProperties().set("primary", true). */
class DownBeatLookAndFeel : public juce::LookAndFeel_V4 {
public:
    static inline const juce::Colour bg{0xff0c0d11}, panel{0xff15171e}, raised{0xff1f222d}, line{0xff2a2e3b},
        text{0xffe2e8f0}, muted{0xff94a3b8}, accent{0xff6366f1}, accentHi{0xff818cf8};

    DownBeatLookAndFeel() {
        setColourScheme({ bg, panel, raised, line, text, raised, text, accent, text });
        setColour(juce::ResizableWindow::backgroundColourId, bg);
        setColour(juce::TextButton::buttonColourId, raised);
        setColour(juce::TextButton::textColourOffId, text);
        setColour(juce::TextButton::textColourOnId, juce::Colours::white);
        setColour(juce::TextEditor::backgroundColourId, juce::Colour(0xff0f1117));
        setColour(juce::TextEditor::textColourId, text);
        setColour(juce::TextEditor::outlineColourId, line);
        setColour(juce::TextEditor::focusedOutlineColourId, accent);
        setColour(juce::TextEditor::highlightColourId, accent.withAlpha(0.4f));
        setColour(juce::CaretComponent::caretColourId, accentHi);
        setColour(juce::Label::textColourId, text);
        setColour(juce::Slider::thumbColourId, accentHi);
        setColour(juce::Slider::trackColourId, accent);
        setColour(juce::Slider::backgroundColourId, raised);
        setColour(juce::Slider::textBoxTextColourId, muted);
        setColour(juce::Slider::textBoxOutlineColourId, juce::Colours::transparentBlack);
        setColour(juce::ToggleButton::textColourId, text);
        setColour(juce::ToggleButton::tickColourId, juce::Colours::white);
        setColour(juce::ToggleButton::tickDisabledColourId, muted);
        setColour(juce::GroupComponent::outlineColourId, line);
        setColour(juce::GroupComponent::textColourId, muted);
        setColour(juce::ScrollBar::thumbColourId, line);
        setColour(juce::TooltipWindow::backgroundColourId, raised);
        setColour(juce::TooltipWindow::textColourId, text);
        setColour(juce::TooltipWindow::outlineColourId, line);
    }

    juce::Font getTextButtonFont(juce::TextButton&, int buttonHeight) override {
        return juce::FontOptions(juce::jmin(13.0f, (float) buttonHeight * 0.5f), juce::Font::bold);
    }

    void drawButtonBackground(juce::Graphics& g, juce::Button& b, const juce::Colour&, bool over, bool down) override {
        auto r = b.getLocalBounds().toFloat().reduced(0.5f);
        const bool primary = (bool) b.getProperties()["primary"];
        auto fill = primary ? accent : raised;
        if (!b.isEnabled()) fill = fill.withAlpha(0.35f);
        else if (down) fill = fill.darker(0.15f);
        else if (over) fill = primary ? accentHi : fill.brighter(0.12f);
        g.setColour(fill);
        g.fillRoundedRectangle(r, 6.0f);
        if (!primary) {
            g.setColour(line);
            g.drawRoundedRectangle(r, 6.0f, 1.0f);
        }
        if (b.hasKeyboardFocus(false)) {
            g.setColour(accentHi);
            g.drawRoundedRectangle(r.reduced(1.0f), 5.0f, 1.5f);
        }
    }

    void drawGroupComponentOutline(juce::Graphics& g, int w, int h, const juce::String& title,
                                   const juce::Justification&, juce::GroupComponent&) override {
        auto r = juce::Rectangle<float>(0.5f, 0.5f, (float) w - 1.0f, (float) h - 1.0f);
        g.setColour(panel);
        g.fillRoundedRectangle(r, 10.0f);
        g.setColour(line);
        g.drawRoundedRectangle(r, 10.0f, 1.0f);
        g.setColour(muted);
        g.setFont(juce::FontOptions(11.0f, juce::Font::bold));
        g.drawText(title.toUpperCase(), 12, 4, w - 24, 16, juce::Justification::centredLeft);
    }

    void drawToggleButton(juce::Graphics& g, juce::ToggleButton& b, bool over, bool) override {
        const float s = 16.0f;
        auto box = juce::Rectangle<float>(2.0f, ((float) b.getHeight() - s) * 0.5f, s, s);
        const bool on = b.getToggleState();
        g.setColour(on ? accent : (over ? raised.brighter(0.1f) : raised));
        g.fillRoundedRectangle(box, 4.0f);
        g.setColour(on ? accent : line);
        g.drawRoundedRectangle(box, 4.0f, 1.0f);
        if (on) {
            juce::Path tick;
            tick.startNewSubPath(box.getX() + 4.0f, box.getCentreY());
            tick.lineTo(box.getX() + 7.0f, box.getBottom() - 4.5f);
            tick.lineTo(box.getRight() - 3.5f, box.getY() + 4.5f);
            g.setColour(juce::Colours::white);
            g.strokePath(tick, juce::PathStrokeType(2.0f, juce::PathStrokeType::curved, juce::PathStrokeType::rounded));
        }
        g.setColour(b.isEnabled() ? text : muted);
        g.setFont(juce::FontOptions(12.0f));
        g.drawText(b.getButtonText(), (int) box.getRight() + 7, 0, b.getWidth() - (int) box.getRight() - 7, b.getHeight(),
                   juce::Justification::centredLeft, true);
    }

    void drawLinearSlider(juce::Graphics& g, int x, int y, int w, int h, float pos, float, float,
                          juce::Slider::SliderStyle style, juce::Slider& s) override {
        if (style != juce::Slider::LinearHorizontal) {
            LookAndFeel_V4::drawLinearSlider(g, x, y, w, h, pos, 0, 0, style, s);
            return;
        }
        const float cy = (float) y + (float) h * 0.5f;
        auto track = juce::Rectangle<float>((float) x, cy - 2.0f, (float) w, 4.0f);
        g.setColour(raised);
        g.fillRoundedRectangle(track, 2.0f);
        g.setColour(s.isEnabled() ? accent : muted);
        g.fillRoundedRectangle(track.withRight(pos), 2.0f);
        g.setColour(s.isEnabled() ? accentHi : muted);
        g.fillEllipse(pos - 6.0f, cy - 6.0f, 12.0f, 12.0f);
    }

    juce::Label* createSliderTextBox(juce::Slider& s) override {
        auto* l = LookAndFeel_V4::createSliderTextBox(s);
        l->setColour(juce::Label::outlineColourId, juce::Colours::transparentBlack);
        l->setColour(juce::Label::backgroundColourId, juce::Colours::transparentBlack);
        l->setColour(juce::Label::textColourId, muted);
        l->setColour(juce::Label::outlineWhenEditingColourId, accent);
        l->setColour(juce::TextEditor::backgroundColourId, juce::Colour(0xff0f1117));
        l->setFont(juce::FontOptions(11.0f));
        return l;
    }

    void fillTextEditorBackground(juce::Graphics& g, int w, int h, juce::TextEditor& e) override {
        g.setColour(e.findColour(juce::TextEditor::backgroundColourId));
        g.fillRoundedRectangle(0.0f, 0.0f, (float) w, (float) h, 6.0f);
    }

    void drawTextEditorOutline(juce::Graphics& g, int w, int h, juce::TextEditor& e) override {
        if (!e.isEnabled()) return;
        g.setColour(e.hasKeyboardFocus(true) ? accent : line);
        g.drawRoundedRectangle(0.5f, 0.5f, (float) w - 1.0f, (float) h - 1.0f, 6.0f, e.hasKeyboardFocus(true) ? 1.5f : 1.0f);
    }
};

} // namespace downbeat
