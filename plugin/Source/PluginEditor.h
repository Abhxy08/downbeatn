#pragma once

#include <juce_gui_basics/juce_gui_basics.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include "PluginProcessor.h"
#include "LatencyMeter.h"
#include "DownBeatLookAndFeel.h"
#include "SharedClipEditor.h"

namespace downbeat {

class DownBeatAudioProcessorEditor : public juce::AudioProcessorEditor,
                                     public juce::Timer {
public:
    explicit DownBeatAudioProcessorEditor(DownBeatAudioProcessor&);
    ~DownBeatAudioProcessorEditor() override;

    void paint(juce::Graphics&) override;
    void resized() override;
    void timerCallback() override;

private:
    DownBeatAudioProcessor& processorRef;
    DownBeatLookAndFeel lookAndFeel; // declared first so it outlives every child component
    juce::TooltipWindow tooltips{this, 500};

    // Header
    juce::Label titleLabel;
    juce::Label subtitleLabel;
    juce::TextButton signInButton;
    juce::TextButton signOutButton;
    juce::Label userProfileLabel;

    // Pairing overlay
    juce::GroupComponent pairingGroup;
    juce::Label pairingInstructionsLabel;
    juce::Label pairingCodeDisplay;
    juce::TextButton copyCodeButton;
    juce::TextButton openBrowserButton;
    juce::String currentPairUrl;
    int pairingPollTicks{0};

    // Session (left column)
    juce::GroupComponent sessionGroup;
    juce::TextEditor inviteCodeInput;
    juce::TextButton joinSessionButton;
    juce::TextButton createSessionButton;
    juce::Label sessionCodeLabel;
    juce::TextButton copyInviteButton;
    juce::TextButton leaveSessionButton;
    juce::Label connectionStatusLabel;
    juce::Label onlineLabel;
    juce::Label activityLabel;
    juce::TextEditor noteInput;
    juce::TextButton logNoteButton;
    bool sessionRequestInFlight{false};
    juce::String sessionActionError;

    // Tempo & Audio (right column)
    juce::GroupComponent audioGroup;
    juce::Label tempoLabel;
    juce::Label tempoHintLabel;
    juce::TextButton useMyTempoButton;
    juce::Label linkLabel;
    LatencyMeter latencyMeter;
    juce::Label audioStatsLabel;
    juce::Label remoteVolumeLabel;
    juce::Slider remoteVolumeSlider;
    juce::Label jitterLabel;
    juce::Slider jitterSlider;
    juce::ToggleButton forceRelayToggle;
    juce::ToggleButton muteSendToggle;
    std::unique_ptr<juce::AudioProcessorValueTreeState::ButtonAttachment> muteSendAttachment;
    std::unique_ptr<juce::AudioProcessorValueTreeState::SliderAttachment> remoteVolumeAttachment;
    std::unique_ptr<juce::AudioProcessorValueTreeState::SliderAttachment> jitterAttachment;

    // Bottom panel: Shared clip | AI agents
    juce::GroupComponent clipGroup;
    std::unique_ptr<SharedClipEditor> clipEditor;
    juce::TextButton clipTabButton, agentsTabButton;
    bool showClipTab{true};
    void showTab(bool clip);

    // AI agents
    juce::GroupComponent aiAgentsGroup;
    juce::ToggleButton beatJamToggle;
    juce::TextEditor beatJamPromptInput;
    juce::TextButton beatJamStartButton;
    juce::TextButton beatJamStopButton;
    juce::Label beatJamStatusLabel;
    juce::Slider beatJamVolumeSlider;
    juce::TextButton mixDoctorButton;
    juce::TextButton creditsAgentButton;
    juce::TextButton approveCreditsButton;
    juce::Label aiStatusLabel;
    juce::TextEditor agentReportView;
    juce::String shownReport;
    std::unique_ptr<juce::AudioProcessorValueTreeState::ButtonAttachment> beatJamAttachment;
    std::unique_ptr<juce::AudioProcessorValueTreeState::SliderAttachment> beatJamVolumeAttachment;

    void updateAuthUI(const SessionInfo& info);
    void updateSessionUI(const SessionInfo& info);
    void updateAudioUI(const SessionInfo& info);
    void updateAgentsUI(const SessionInfo& info);
    void setPairingVisible(bool visible);
    void beginSessionRequest();
    NetworkClient::SessionCallback makeSessionCallback();

    static void styleLabel(juce::Label& l, float size, juce::Colour colour, bool bold = false);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(DownBeatAudioProcessorEditor)
};

} // namespace downbeat
