#pragma once

#include <juce_gui_basics/juce_gui_basics.h>
#include "AudioTransport.h"
#include "JitterBuffer.h"

namespace downbeat {

/**
 * Shows the audio path (direct / relay), round-trip time and an estimate of
 * one-way "their mic -> your ears" latency as a coloured bar.
 *
 *   one-way ≈ RTT/2 (network) + buffered audio (jitter buffer) + 2.7 ms (packet size)
 */
class LatencyMeter : public juce::Component {
public:
    void update(const TransportStats& t, const JitterBufferStats& j) {
        transport = t;
        jitter = j;
        repaint();
    }

    void paint(juce::Graphics& g) override {
        auto area = getLocalBounds().toFloat();
        g.setColour(juce::Colour(0xff11131a));
        g.fillRoundedRectangle(area, 6.0f);

        auto inner = getLocalBounds().reduced(10, 6);
        auto line1 = inner.removeFromTop(18);

        // --- path ---
        juce::String pathText;
        juce::Colour dot(0xff64748b);
        if (!transport.running) {
            pathText = "Audio idle - join a session";
        } else if (!transport.hasPeer) {
            pathText = "Waiting for a collaborator's plugin...";
        } else {
            switch (transport.sendPath) {
                case AudioPath::Direct: pathText = "Direct P2P  " + transport.directEndpoint; dot = juce::Colour(0xff10b981); break;
                case AudioPath::Relay:  pathText = "Via relay (direct path unavailable)";       dot = juce::Colour(0xfff59e0b); break;
                case AudioPath::None:   pathText = "Connecting to " + transport.peerName + "...";  break;
            }
        }
        g.setColour(dot);
        g.fillEllipse((float) line1.getX(), (float) line1.getCentreY() - 4.0f, 8.0f, 8.0f);
        g.setColour(juce::Colour(0xffe2e8f0));
        g.setFont(juce::FontOptions(12.0f, juce::Font::bold));
        g.drawText(pathText, line1.withTrimmedLeft(14), juce::Justification::centredLeft, true);

        inner.removeFromTop(4);
        auto barArea = inner.removeFromTop(10);
        inner.removeFromTop(4);
        auto line3 = inner.removeFromTop(16);

        // --- bar: 0..150 ms ---
        constexpr float maxMs = 150.0f;
        g.setColour(juce::Colour(0xff1f222d));
        g.fillRoundedRectangle(barArea.toFloat(), 3.0f);

        const bool haveRtt = transport.rttMs >= 0.0f;
        const float netMs = haveRtt ? transport.rttMs * 0.5f : 0.0f;
        const float bufMs = jitter.playing ? jitter.bufferedMs : (float) jitter.targetMs;
        const float oneWay = netMs + bufMs + 2.7f;

        if (transport.hasPeer && haveRtt) {
            const auto colour = oneWay < 30.0f ? juce::Colour(0xff10b981)
                              : oneWay < 60.0f ? juce::Colour(0xfff59e0b)
                                               : juce::Colour(0xffef4444);
            const float w = juce::jlimit(0.0f, 1.0f, oneWay / maxMs) * (float) barArea.getWidth();
            g.setColour(colour);
            g.fillRoundedRectangle(barArea.toFloat().withWidth(juce::jmax(4.0f, w)), 3.0f);
        }
        // 30 / 60 ms tick marks
        g.setColour(juce::Colour(0x66ffffff));
        for (float tick : { 30.0f, 60.0f }) {
            const float x = (float) barArea.getX() + tick / maxMs * (float) barArea.getWidth();
            g.drawVerticalLine((int) x, (float) barArea.getY(), (float) barArea.getBottom());
        }

        // --- numbers ---
        g.setFont(juce::FontOptions(11.0f));
        g.setColour(juce::Colour(0xff94a3b8));
        juce::String numbers;
        if (transport.hasPeer && haveRtt) {
            numbers << "~" << juce::String(oneWay, 0) << " ms one-way   (RTT " << juce::String(transport.rttMs, 1)
                    << " + buffer " << juce::String(bufMs, 0) << " ms)";
        } else if (transport.hasPeer) {
            numbers = "Measuring round-trip time...";
        } else {
            numbers = "Buffer target " + juce::String(jitter.targetMs) + " ms";
        }
        g.drawText(numbers, line3, juce::Justification::centredLeft, true);
    }

private:
    TransportStats transport;
    JitterBufferStats jitter;
};

} // namespace downbeat
