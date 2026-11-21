#include "PluginProcessor.h"
#include "PluginEditor.h"

namespace downbeat {

void installStandaloneAudioFixes(); // StandaloneSupport.cpp

namespace {
constexpr int kWidth = 760;
constexpr int kHeightCompact = 700;
constexpr int kHeightWithPairing = 820;

const juce::Colour kText(0xffe2e8f0);
const juce::Colour kMuted(0xff94a3b8);
const juce::Colour kGreen(0xff10b981);
const juce::Colour kAmber(0xfff59e0b);
const juce::Colour kRed(0xffef4444);
const juce::Colour kAccent(0xff38bdf8);
} // namespace

void DownBeatAudioProcessorEditor::styleLabel(juce::Label& l, float size, juce::Colour colour, bool bold) {
    l.setFont(juce::FontOptions(size, bold ? juce::Font::bold : juce::Font::plain));
    l.setColour(juce::Label::textColourId, colour);
}

DownBeatAudioProcessorEditor::DownBeatAudioProcessorEditor(DownBeatAudioProcessor& p)
    : AudioProcessorEditor(&p),
      processorRef(p)
{
    auto& net = processorRef.getNetworkClient();
    installStandaloneAudioFixes();
    setLookAndFeel(&lookAndFeel);
    tooltips.setLookAndFeel(&lookAndFeel);

    // ----- Header -----
    titleLabel.setText("DOWNBEAT", juce::dontSendNotification);
    styleLabel(titleLabel, 22.0f, juce::Colours::white, true);
    addAndMakeVisible(titleLabel);

    subtitleLabel.setText("Cross-DAW Live Audio Collab + Google AI", juce::dontSendNotification);
    styleLabel(subtitleLabel, 11.0f, kMuted);
    addAndMakeVisible(subtitleLabel);

    signInButton.setButtonText("Sign In");
    signInButton.onClick = [this] {
        signInButton.setEnabled(false);
        signInButton.setButtonText("Pairing...");
        juce::Component::SafePointer<DownBeatAudioProcessorEditor> safeThis(this);
        processorRef.getNetworkClient().startPairing([safeThis](bool success, const juce::String& code, const juce::String& pairUrl) {
            if (safeThis == nullptr) return;
            auto& ed = *safeThis;
            if (success) {
                ed.currentPairUrl = pairUrl;
                ed.pairingCodeDisplay.setText(code, juce::dontSendNotification);
                ed.setPairingVisible(true);
                juce::URL(pairUrl).launchInDefaultBrowser();
            } else {
                ed.signInButton.setEnabled(true);
                ed.signInButton.setButtonText("Sign In");
                ed.userProfileLabel.setText("Server unreachable", juce::dontSendNotification);
            }
        });
    };
    addAndMakeVisible(signInButton);

    userProfileLabel.setText("Not signed in", juce::dontSendNotification);
    styleLabel(userProfileLabel, 12.0f, juce::Colour(0xffcbd5e1));
    userProfileLabel.setJustificationType(juce::Justification::centredRight);
    addAndMakeVisible(userProfileLabel);

    signOutButton.setButtonText("Sign Out");
    signOutButton.onClick = [this] {
        processorRef.getNetworkClient().signOut();
        signInButton.setEnabled(true);
        signInButton.setButtonText("Sign In");
        setPairingVisible(false);
    };
    addChildComponent(signOutButton);

    // ----- Pairing overlay -----
    pairingGroup.setText("Device Pairing Required");
    addChildComponent(pairingGroup);

    pairingInstructionsLabel.setText("Enter this code in your browser or click 'Open Link':", juce::dontSendNotification);
    styleLabel(pairingInstructionsLabel, 12.0f, kText);
    pairingGroup.addAndMakeVisible(pairingInstructionsLabel);

    pairingCodeDisplay.setText("------", juce::dontSendNotification);
    styleLabel(pairingCodeDisplay, 28.0f, juce::Colour(0xff6366f1), true);
    pairingCodeDisplay.setJustificationType(juce::Justification::centred);
    pairingGroup.addAndMakeVisible(pairingCodeDisplay);

    copyCodeButton.setButtonText("Copy Code");
    copyCodeButton.onClick = [this] {
        juce::SystemClipboard::copyTextToClipboard(pairingCodeDisplay.getText());
        copyCodeButton.setButtonText("Copied!");
        juce::Component::SafePointer<juce::TextButton> btn(&copyCodeButton);
        juce::Timer::callAfterDelay(1500, [btn] { if (btn != nullptr) btn->setButtonText("Copy Code"); });
    };
    pairingGroup.addAndMakeVisible(copyCodeButton);

    openBrowserButton.setButtonText("Open Link in Browser");
    openBrowserButton.onClick = [this] {
        if (currentPairUrl.isNotEmpty()) juce::URL(currentPairUrl).launchInDefaultBrowser();
    };
    pairingGroup.addAndMakeVisible(openBrowserButton);

    // ----- Session (left) -----
    sessionGroup.setText("Live Session");
    addAndMakeVisible(sessionGroup);

    inviteCodeInput.setTextToShowWhenEmpty("Invite code, e.g. DB-7K9A", juce::Colour(0xff64748b));
    inviteCodeInput.setInputRestrictions(8, "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz- ");
    inviteCodeInput.setJustification(juce::Justification::centredLeft);
    inviteCodeInput.onReturnKey = [this] { joinSessionButton.triggerClick(); };
    sessionGroup.addAndMakeVisible(inviteCodeInput);

    joinSessionButton.setButtonText("Join");
    joinSessionButton.onClick = [this] {
        const auto code = inviteCodeInput.getText().trim();
        if (code.length() < 4) {
            sessionActionError = "Enter the invite code your collaborator shared";
            return;
        }
        beginSessionRequest();
        processorRef.getNetworkClient().joinSessionByInviteCode(code, makeSessionCallback());
    };
    sessionGroup.addAndMakeVisible(joinSessionButton);

    createSessionButton.setButtonText("New Session");
    createSessionButton.onClick = [this] {
        beginSessionRequest();
        auto& n = processorRef.getNetworkClient();
        auto first = juce::String(n.getSessionInfo().currentUserName).upToFirstOccurrenceOf(" ", false, false);
        const double bpm = processorRef.getHostProvidesTempo() ? processorRef.getHostBpm() : 120.0;
        n.createSession((first.isNotEmpty() ? first + "'s" : juce::String("DownBeat")) + " Jam", bpm, makeSessionCallback());
    };
    sessionGroup.addAndMakeVisible(createSessionButton);

    styleLabel(sessionCodeLabel, 13.0f, kAccent, true);
    sessionCodeLabel.setMinimumHorizontalScale(0.7f);
    sessionGroup.addChildComponent(sessionCodeLabel);

    copyInviteButton.setButtonText("Copy");
    copyInviteButton.onClick = [this] {
        juce::SystemClipboard::copyTextToClipboard(processorRef.getNetworkClient().getSessionInfo().inviteCode);
        copyInviteButton.setButtonText("Copied!");
        juce::Component::SafePointer<juce::TextButton> btn(&copyInviteButton);
        juce::Timer::callAfterDelay(1500, [btn] { if (btn != nullptr) btn->setButtonText("Copy"); });
    };
    sessionGroup.addChildComponent(copyInviteButton);

    leaveSessionButton.setButtonText("Leave");
    leaveSessionButton.onClick = [this] {
        processorRef.getNetworkClient().leaveSession();
        sessionActionError = {};
    };
    sessionGroup.addChildComponent(leaveSessionButton);

    styleLabel(connectionStatusLabel, 11.0f, kMuted);
    sessionGroup.addAndMakeVisible(connectionStatusLabel);

    styleLabel(onlineLabel, 12.0f, kText);
    onlineLabel.setJustificationType(juce::Justification::topLeft);
    sessionGroup.addAndMakeVisible(onlineLabel);

    styleLabel(activityLabel, 10.5f, kMuted);
    activityLabel.setJustificationType(juce::Justification::topLeft);
    activityLabel.setMinimumHorizontalScale(0.8f);
    sessionGroup.addAndMakeVisible(activityLabel);

    noteInput.setTextToShowWhenEmpty("What did you just do? e.g. wrote the chorus hook", juce::Colour(0xff64748b));
    noteInput.setInputRestrictions(280);
    noteInput.onReturnKey = [this] { logNoteButton.triggerClick(); };
    sessionGroup.addAndMakeVisible(noteInput);

    logNoteButton.setButtonText("Log");
    logNoteButton.setTooltip("Adds a note to the session log; the Credits Agent uses it to propose splits");
    logNoteButton.onClick = [this] {
        const auto text = noteInput.getText().trim();
        if (text.isEmpty()) return;
        auto* obj = new juce::DynamicObject();
        obj->setProperty("text", text);
        processorRef.getNetworkClient().logEvent("contribution_note", juce::var(obj));
        noteInput.clear();
    };
    sessionGroup.addAndMakeVisible(logNoteButton);

    // ----- Tempo & Audio (right) -----
    audioGroup.setText("Tempo & Audio");
    addAndMakeVisible(audioGroup);

    styleLabel(tempoLabel, 13.0f, kText, true);
    audioGroup.addAndMakeVisible(tempoLabel);

    styleLabel(tempoHintLabel, 11.0f, kAmber);
    tempoHintLabel.setMinimumHorizontalScale(0.8f);
    audioGroup.addAndMakeVisible(tempoHintLabel);

    useMyTempoButton.setButtonText("Use my DAW tempo");
    useMyTempoButton.setTooltip("Change the session tempo for everyone to your DAW's current tempo");
    useMyTempoButton.onClick = [this] {
        processorRef.getNetworkClient().proposeSessionTempo(std::round(processorRef.getHostBpm() * 100.0) / 100.0);
    };
    audioGroup.addChildComponent(useMyTempoButton);

    styleLabel(linkLabel, 11.0f, kMuted);
    audioGroup.addAndMakeVisible(linkLabel);

    audioGroup.addAndMakeVisible(latencyMeter);

    styleLabel(audioStatsLabel, 10.5f, juce::Colour(0xff64748b));
    audioStatsLabel.setMinimumHorizontalScale(0.7f);
    audioGroup.addAndMakeVisible(audioStatsLabel);

    remoteVolumeLabel.setText("Collaborator volume", juce::dontSendNotification);
    styleLabel(remoteVolumeLabel, 11.0f, kMuted);
    audioGroup.addAndMakeVisible(remoteVolumeLabel);
    remoteVolumeSlider.setSliderStyle(juce::Slider::LinearHorizontal);
    remoteVolumeSlider.setTextBoxStyle(juce::Slider::TextBoxRight, false, 64, 20);
    remoteVolumeSlider.setTextValueSuffix(" dB");
    audioGroup.addAndMakeVisible(remoteVolumeSlider);
    remoteVolumeAttachment = std::make_unique<juce::AudioProcessorValueTreeState::SliderAttachment>(
        processorRef.getAPVTS(), "remoteVolume", remoteVolumeSlider);

    jitterLabel.setText("Jitter buffer", juce::dontSendNotification);
    styleLabel(jitterLabel, 11.0f, kMuted);
    audioGroup.addAndMakeVisible(jitterLabel);
    jitterSlider.setSliderStyle(juce::Slider::LinearHorizontal);
    jitterSlider.setTextBoxStyle(juce::Slider::TextBoxRight, false, 64, 20);
    jitterSlider.setTextValueSuffix(" ms");
    jitterSlider.setTooltip("More buffer = fewer dropouts on bad networks, but more delay");
    audioGroup.addAndMakeVisible(jitterSlider);
    jitterAttachment = std::make_unique<juce::AudioProcessorValueTreeState::SliderAttachment>(
        processorRef.getAPVTS(), "jitterMs", jitterSlider);

    forceRelayToggle.setButtonText("Force relay (testing)");
    forceRelayToggle.setToggleState(net.isForceRelay(), juce::dontSendNotification);
    forceRelayToggle.onClick = [this] {
        processorRef.getNetworkClient().setForceRelay(forceRelayToggle.getToggleState());
    };
    audioGroup.addAndMakeVisible(forceRelayToggle);

    muteSendToggle.setButtonText("Mute my send");
    muteSendToggle.setTooltip("Stop sending your audio to collaborators (they hear silence)");
    audioGroup.addAndMakeVisible(muteSendToggle);
    muteSendAttachment = std::make_unique<juce::AudioProcessorValueTreeState::ButtonAttachment>(
        processorRef.getAPVTS(), "sendMuted", muteSendToggle);

    // ----- Shared MIDI clip -----
    clipGroup.setText("Shared MIDI clip - write it together");
    addAndMakeVisible(clipGroup);
    clipEditor = std::make_unique<SharedClipEditor>(processorRef);
    clipGroup.addAndMakeVisible(*clipEditor);

    clipTabButton.setButtonText("Shared clip");
    agentsTabButton.setButtonText("AI agents");
    clipTabButton.onClick = [this] { showTab(true); };
    agentsTabButton.onClick = [this] { showTab(false); };
    addAndMakeVisible(clipTabButton);
    addAndMakeVisible(agentsTabButton);

    // ----- AI agents -----
    aiAgentsGroup.setText("Google AI Agents");
    addChildComponent(aiAgentsGroup);

    beatJamToggle.setButtonText("Hear Beat Jam");
    beatJamToggle.setTooltip("Mix the Lyria RealTime jam into your output as its own track");
    beatJamAttachment = std::make_unique<juce::AudioProcessorValueTreeState::ButtonAttachment>(
        processorRef.getAPVTS(), "beatJamEnabled", beatJamToggle);
    aiAgentsGroup.addAndMakeVisible(beatJamToggle);

    beatJamPromptInput.setTextToShowWhenEmpty("Beat Jam prompt, e.g. dark minimal techno / add hi-hats", juce::Colour(0xff64748b));
    beatJamPromptInput.setInputRestrictions(200);
    beatJamPromptInput.onReturnKey = [this] { beatJamStartButton.triggerClick(); };
    aiAgentsGroup.addAndMakeVisible(beatJamPromptInput);

    beatJamStartButton.setButtonText("Start");
    beatJamStartButton.onClick = [this] {
        auto& n = processorRef.getNetworkClient();
        const auto prompt = beatJamPromptInput.getText().trim();
        if (prompt.isEmpty()) return;
        if (n.getSessionInfo().beatJam.active) n.beatJamSteer(prompt);
        else {
            n.beatJamStart(prompt);
            if (!beatJamToggle.getToggleState()) beatJamToggle.setToggleState(true, juce::sendNotification);
        }
        beatJamPromptInput.clear();
    };
    aiAgentsGroup.addAndMakeVisible(beatJamStartButton);

    beatJamStopButton.setButtonText("Stop");
    beatJamStopButton.onClick = [this] { processorRef.getNetworkClient().beatJamStop(); };
    aiAgentsGroup.addAndMakeVisible(beatJamStopButton);

    styleLabel(beatJamStatusLabel, 11.0f, kMuted);
    beatJamStatusLabel.setMinimumHorizontalScale(0.75f);
    aiAgentsGroup.addAndMakeVisible(beatJamStatusLabel);

    beatJamVolumeSlider.setSliderStyle(juce::Slider::LinearHorizontal);
    beatJamVolumeSlider.setTextBoxStyle(juce::Slider::TextBoxRight, false, 56, 18);
    beatJamVolumeSlider.setTextValueSuffix(" dB");
    beatJamVolumeSlider.setTooltip("Beat Jam volume");
    aiAgentsGroup.addAndMakeVisible(beatJamVolumeSlider);
    beatJamVolumeAttachment = std::make_unique<juce::AudioProcessorValueTreeState::SliderAttachment>(
        processorRef.getAPVTS(), "beatJamVolume", beatJamVolumeSlider);

    mixDoctorButton.setButtonText("Mix Doctor: analyze 30 s");
    mixDoctorButton.setTooltip("Records 30 s of what passes through DownBeat (put it on your master bus), then Gemini diagnoses the mix");
    mixDoctorButton.onClick = [this] {
        auto& capture = processorRef.getMixCapture();
        if (capture.isCapturing()) {
            capture.cancel();
            processorRef.getNetworkClient().setAgentStatus("Capture cancelled");
            return;
        }
        // NB: the callback runs on the message thread and must not depend on the editor being open
        auto* proc = &processorRef;
        capture.start(30.0, [proc](juce::MemoryBlock wav, double seconds) {
            auto& n = proc->getNetworkClient();
            if (proc->getMixCapture().capturedPeak() < 0.001f) {
                n.setAgentStatus("Captured only silence - press play in your DAW, then try again");
                return;
            }
            const auto name = juce::String(n.getSessionInfo().sessionName).replaceCharacters(" /\\", "___") + "-mix-"
                            + juce::String((int) seconds) + "s.wav";
            n.analyzeMix(std::move(wav), name);
        });
        processorRef.getNetworkClient().setAgentStatus("Capturing... press play in your DAW");
    };
    aiAgentsGroup.addAndMakeVisible(mixDoctorButton);

    creditsAgentButton.setButtonText("Credits: propose splits");
    creditsAgentButton.setTooltip("Gemini reads the session log and proposes a split sheet; everyone must approve");
    creditsAgentButton.onClick = [this] { processorRef.getNetworkClient().proposeCredits(); };
    aiAgentsGroup.addAndMakeVisible(creditsAgentButton);

    approveCreditsButton.setButtonText("Approve split");
    approveCreditsButton.onClick = [this] { processorRef.getNetworkClient().approveCredits(); };
    aiAgentsGroup.addChildComponent(approveCreditsButton);

    styleLabel(aiStatusLabel, 11.0f, juce::Colour(0xffa78bfa));
    aiStatusLabel.setMinimumHorizontalScale(0.75f);
    aiAgentsGroup.addAndMakeVisible(aiStatusLabel);

    agentReportView.setMultiLine(true, true);
    agentReportView.setReadOnly(true);
    agentReportView.setScrollbarsShown(true);
    agentReportView.setCaretVisible(false);
    agentReportView.setFont(juce::FontOptions(11.5f));
    agentReportView.setColour(juce::TextEditor::backgroundColourId, juce::Colour(0xff11131a));
    agentReportView.setColour(juce::TextEditor::textColourId, kText);
    agentReportView.setColour(juce::TextEditor::outlineColourId, juce::Colour(0xff1f222d));
    agentReportView.setTextToShowWhenEmpty("Agent results appear here.", juce::Colour(0xff64748b));
    aiAgentsGroup.addAndMakeVisible(agentReportView);

    for (auto* b : { &signInButton, &createSessionButton, &joinSessionButton, &beatJamStartButton, &approveCreditsButton, &logNoteButton })
        b->getProperties().set("primary", true);

    showTab(true);
    clipTabButton.toFront(false);   // the groups fill their area; keep the tabs on top
    agentsTabButton.toFront(false);

    // Children configured before being parented (e.g. slider text boxes) picked up the default
    // look; re-send now that the whole tree uses our LookAndFeel.
    sendLookAndFeelChange();

    setSize(kWidth, kHeightCompact);
    startTimerHz(10);

    // Developer aid: DOWNBEAT_UI_SNAPSHOT=/path/file.png renders the editor to a PNG
    // (and quits the Standalone app) so the UI can be reviewed without a screen grab.
    const auto snapshotPath = juce::SystemStats::getEnvironmentVariable("DOWNBEAT_UI_SNAPSHOT", {});
    if (snapshotPath.isNotEmpty()) {
        juce::Component::SafePointer<DownBeatAudioProcessorEditor> safeThis(this);
        juce::Timer::callAfterDelay(1500, [safeThis, snapshotPath] {
            if (safeThis == nullptr) return;
            const auto img = safeThis->createComponentSnapshot(safeThis->getLocalBounds(), true, 1.0f);
            juce::File out(snapshotPath);
            out.deleteFile();
            if (auto stream = out.createOutputStream()) juce::PNGImageFormat().writeImageToStream(img, *stream);
            if (juce::JUCEApplicationBase::isStandaloneApp())
                if (auto* app = juce::JUCEApplicationBase::getInstance()) app->systemRequestedQuit();
        });
    }
}

DownBeatAudioProcessorEditor::~DownBeatAudioProcessorEditor() {
    stopTimer();
    tooltips.setLookAndFeel(nullptr);
    setLookAndFeel(nullptr);
}

void DownBeatAudioProcessorEditor::showTab(bool clip) {
    showClipTab = clip;
    clipGroup.setVisible(clip);
    aiAgentsGroup.setVisible(!clip);
    clipTabButton.getProperties().set("primary", clip);
    agentsTabButton.getProperties().set("primary", !clip);
    clipTabButton.repaint();
    agentsTabButton.repaint();
}

void DownBeatAudioProcessorEditor::setPairingVisible(bool visible) {
    if (pairingGroup.isVisible() == visible) return;
    pairingGroup.setVisible(visible);
    setSize(kWidth, visible ? kHeightWithPairing : kHeightCompact); // triggers resized()
}

void DownBeatAudioProcessorEditor::timerCallback() {
    const auto info = processorRef.getNetworkClient().getSessionInfo();
    updateAuthUI(info);
    updateSessionUI(info);
    updateAudioUI(info);
    updateAgentsUI(info);
}

void DownBeatAudioProcessorEditor::updateAgentsUI(const SessionInfo& info) {
    const bool connected = !info.sessionId.empty() && info.signalingStatus == SignalingStatus::Connected;
    clipEditor->setEnabledForSession(connected);
    clipEditor->setMyUserId(juce::String(info.currentUserId));
    // the AI tab label shows when an agent is busy or Beat Jam is running
    agentsTabButton.setButtonText(info.agentBusy ? "AI agents (working)" : info.beatJam.active ? "AI agents (jam on)" : "AI agents");
    auto& capture = processorRef.getMixCapture();

    // Beat Jam
    const auto& bj = info.beatJam;
    beatJamStartButton.setButtonText(bj.active ? "Steer" : "Start");
    beatJamStartButton.setEnabled(connected);
    beatJamPromptInput.setEnabled(connected);
    beatJamStopButton.setEnabled(connected && bj.active);
    juce::String jam;
    juce::Colour jamColour = kMuted;
    if (!connected) jam = "Beat Jam: join a session to jam with Lyria RealTime";
    else if (bj.status == "connecting") jam = "Beat Jam: connecting to Lyria...";
    else if (bj.active) {
        jam << "Beat Jam by " << bj.startedBy << " @ " << bj.bpm << " BPM: " << bj.prompts.joinIntoString(" + ");
        jam << (info.beatJamPlaying ? "  (playing" : "  (buffering") << ", " << juce::String(info.beatJamBufferedSec, 1) << " s buffered)";
        if (!beatJamToggle.getToggleState()) jam << "  - tick Hear Beat Jam to listen";
        jamColour = kGreen;
    } else if (bj.error.isNotEmpty()) {
        jam = bj.error;
        jamColour = kRed;
    } else jam = "Beat Jam: off - type a prompt and press Start (shared with everyone in the session)";
    beatJamStatusLabel.setText(jam, juce::dontSendNotification);
    beatJamStatusLabel.setColour(juce::Label::textColourId, jamColour);

    // Mix Doctor / Credits
    mixDoctorButton.setEnabled(connected && !info.agentBusy);
    mixDoctorButton.setButtonText(capture.isCapturing()
                                      ? "Capturing " + juce::String((int) capture.capturedSeconds()) + "/30 s (cancel)"
                                      : juce::String("Mix Doctor: analyze 30 s"));
    creditsAgentButton.setEnabled(connected && !info.agentBusy);
    approveCreditsButton.setVisible(connected && info.canApproveCredits);

    juce::String status(info.agentStatus);
    if (info.agentBusy) status = juce::String(juce::CharPointer_UTF8("\xe2\x8f\xb3 ")) + status;
    aiStatusLabel.setText(status, juce::dontSendNotification);

    if (juce::String(info.agentReport) != shownReport) {
        shownReport = juce::String(info.agentReport);
        agentReportView.setText(shownReport, false);
        agentReportView.moveCaretToTop(false);
    }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
void DownBeatAudioProcessorEditor::updateAuthUI(const SessionInfo& info) {
    if (info.isSignedIn) {
        userProfileLabel.setText("Signed in as " + juce::String(info.currentUserName)
                                     + (info.keychainWarning.empty() ? "" : "  (!)"), juce::dontSendNotification);
        userProfileLabel.setTooltip(juce::String(info.keychainWarning));
        signInButton.setVisible(false);
        signOutButton.setVisible(true);
        setPairingVisible(false);
        return;
    }

    signOutButton.setVisible(false);
    signInButton.setVisible(true);
    if (!pairingGroup.isVisible()) {
        if (signInButton.isEnabled()) userProfileLabel.setText("Not signed in", juce::dontSendNotification);
    } else if (++pairingPollTicks % 10 == 0) { // timer is 10 Hz -> poll once per second
        processorRef.getNetworkClient().pollPairingStatus([](bool, const juce::String&) {
            // The signed-in user shows up on the next tick via getSessionInfo()
        });
    }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
void DownBeatAudioProcessorEditor::beginSessionRequest() {
    sessionRequestInFlight = true;
    sessionActionError = {};
}

NetworkClient::SessionCallback DownBeatAudioProcessorEditor::makeSessionCallback() {
    juce::Component::SafePointer<DownBeatAudioProcessorEditor> safeThis(this);
    return [safeThis](bool success, const juce::String& error) {
        if (safeThis == nullptr) return;
        safeThis->sessionRequestInFlight = false;
        safeThis->sessionActionError = success ? juce::String() : error;
        if (success) safeThis->inviteCodeInput.clear();
    };
}

void DownBeatAudioProcessorEditor::updateSessionUI(const SessionInfo& info) {
    const bool inSession = !info.sessionId.empty();

    inviteCodeInput.setVisible(!inSession);
    joinSessionButton.setVisible(!inSession);
    createSessionButton.setVisible(!inSession);
    sessionCodeLabel.setVisible(inSession);
    copyInviteButton.setVisible(inSession);
    leaveSessionButton.setVisible(inSession);

    const bool canAct = info.isSignedIn && !sessionRequestInFlight;
    inviteCodeInput.setEnabled(canAct);
    joinSessionButton.setEnabled(canAct);
    createSessionButton.setEnabled(canAct);

    juce::String status;
    juce::Colour statusColour = kMuted;
    juce::String onlineText;

    if (inSession) {
        const auto name = juce::String(info.sessionName);
        sessionCodeLabel.setText((name.isNotEmpty() ? name : juce::String("Joining...")) + "   " + juce::String(info.inviteCode),
                                 juce::dontSendNotification);

        switch (info.signalingStatus) {
            case SignalingStatus::Connected:    status = "Connected to session"; statusColour = kGreen; break;
            case SignalingStatus::Connecting:   status = "Connecting..."; break;
            case SignalingStatus::Reconnecting: status = "Reconnecting... " + juce::String(info.lastError); statusColour = kAmber; break;
            case SignalingStatus::Failed:       status = "Failed: " + juce::String(info.lastError); statusColour = kRed; break;
            case SignalingStatus::Idle:         break;
        }

        onlineText << "Online (" << (int) info.online.size() << "):";
        for (const auto& p : info.online)
            onlineText << "\n  ● " << p.userName << "  -  " << p.daw;
        if (info.online.size() == 1)
            onlineText << "\n\n  Share the invite code so your\n  collaborator can join.";
    } else if (sessionRequestInFlight) {
        status = "Contacting server...";
    } else if (sessionActionError.isNotEmpty()) {
        status = sessionActionError;
        statusColour = kRed;
    } else if (!info.isSignedIn) {
        status = "Sign in to create or join a session";
    } else {
        status = "Start a new session or enter an invite code";
    }

    connectionStatusLabel.setText(status, juce::dontSendNotification);
    connectionStatusLabel.setColour(juce::Label::textColourId, statusColour);
    onlineLabel.setText(onlineText, juce::dontSendNotification);

    const bool connected = inSession && info.signalingStatus == SignalingStatus::Connected;
    noteInput.setEnabled(connected);
    logNoteButton.setEnabled(connected);

    juce::String activity;
    if (inSession) {
        activity << "Session log: " << info.eventsLogged << " events";
        if (info.eventsPending > 0) activity << " (" << info.eventsPending << " waiting to send)";
        if (!info.lastEventError.empty()) activity << "  -  rejected: " << juce::String(info.lastEventError);
        for (auto it = info.recentActivity.rbegin(); it != info.recentActivity.rend(); ++it)
            activity << "\n" << juce::String(*it);
    }
    activityLabel.setText(activity, juce::dontSendNotification);
}

// ---------------------------------------------------------------------------
// Tempo & audio
// ---------------------------------------------------------------------------
void DownBeatAudioProcessorEditor::updateAudioUI(const SessionInfo& info) {
    const bool inSession = !info.sessionId.empty() && info.signalingStatus == SignalingStatus::Connected;
    const bool hostTempo = processorRef.getHostProvidesTempo();
    const double hostBpm = processorRef.getHostBpm();

    // --- tempo ---
    juce::String tempo;
    if (inSession) tempo << "Session " << juce::String(info.sessionBpm, 1) << " BPM";
    if (hostTempo) tempo << (tempo.isEmpty() ? "" : "   |   ") << "DAW " << juce::String(hostBpm, 1) << " BPM";
    if (tempo.isEmpty()) tempo = "Tempo: no DAW tempo (Standalone)";
    tempoLabel.setText(tempo, juce::dontSendNotification);

    juce::String hint;
    juce::Colour hintColour = kAmber;
    bool showUseMine = false;
    if (inSession && hostTempo && std::abs(hostBpm - info.sessionBpm) >= 0.05) {
        hint = info.linkPeers > 0 ? "Waiting for Link to update your DAW..."
                                  : "Set your DAW to " + juce::String(info.sessionBpm, 1) + " BPM";
        showUseMine = true;
    } else if (inSession && hostTempo) {
        hint = juce::CharPointer_UTF8("\xe2\x9c\x93 In sync with the session");
        hintColour = kGreen;
    } else if (inSession && !info.lastTempoChangeBy.empty()) {
        hint = "Tempo set by " + juce::String(info.lastTempoChangeBy);
        hintColour = kMuted;
    }
    tempoHintLabel.setText(hint, juce::dontSendNotification);
    tempoHintLabel.setColour(juce::Label::textColourId, hintColour);
    useMyTempoButton.setVisible(showUseMine);

    juce::String link = "Ableton Link: ";
    if (!info.linkEnabled) link << "off (joins when you enter a session)";
    else if (info.linkPeers == 0) link << "on, no other Link apps on this network";
    else link << "on, " << (int) info.linkPeers << " Link app" << (info.linkPeers == 1 ? "" : "s") << " following the session";
    linkLabel.setText(link, juce::dontSendNotification);

    // --- audio ---
    const auto jb = processorRef.getJitterBuffer().getStats();
    latencyMeter.update(info.transport, jb);

    juce::String stats;
    if (info.transport.running) {
        const double total = (double) jb.packetsReceived + (double) jb.packetsLost;
        const double lossPct = total > 0 ? 100.0 * (double) jb.packetsLost / total : 0.0;
        stats << "Sent " << juce::String(info.transport.sendKbps / 1000.0f, 2) << " Mbps"
              << "  |  " << (info.transport.receivingAudio ? "receiving" : "no audio in")
              << "  |  loss " << juce::String(lossPct, 1) << "%"
              << "  |  late " << (int) jb.packetsLate
              << "  |  dropouts " << (int) jb.underruns
              << "  |  jitter " << juce::String(jb.arrivalJitterMs, 1) << " ms";
        if (info.transport.relayStatus.isNotEmpty() && info.transport.relayStatus != "registered")
            stats << "  |  relay: " << info.transport.relayStatus;
    }
    audioStatsLabel.setText(stats, juce::dontSendNotification);
    audioStatsLabel.setTooltip(stats + (info.transport.publicEndpoint.isNotEmpty()
                                            ? "\nPublic address: " + info.transport.publicEndpoint : juce::String()));
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
void DownBeatAudioProcessorEditor::paint(juce::Graphics& g) {
    g.fillAll(DownBeatLookAndFeel::bg);
    g.setColour(DownBeatLookAndFeel::panel);
    g.fillRect(0, 0, getWidth(), 60);
    // accent hairline under the header
    g.setGradientFill(juce::ColourGradient(DownBeatLookAndFeel::accent, 0.0f, 60.0f,
                                           juce::Colour(0xff06b6d4), (float) getWidth(), 60.0f, false));
    g.fillRect(0, 59, getWidth(), 2);
}

void DownBeatAudioProcessorEditor::resized() {
    const int pad = 16;
    titleLabel.setBounds(pad, 8, 160, 26);
    subtitleLabel.setBounds(pad, 34, 300, 16);
    userProfileLabel.setBounds(getWidth() - 340 - pad, 18, 240, 24);
    signInButton.setBounds(getWidth() - 90 - pad, 15, 90, 30);
    signOutButton.setBounds(getWidth() - 90 - pad, 15, 90, 30);

    int y = 72;
    if (pairingGroup.isVisible()) {
        pairingGroup.setBounds(pad, y, getWidth() - pad * 2, 110);
        pairingInstructionsLabel.setBounds(16, 25, pairingGroup.getWidth() - 32, 20);
        pairingCodeDisplay.setBounds(16, 45, 140, 45);
        copyCodeButton.setBounds(165, 52, 90, 32);
        openBrowserButton.setBounds(265, 52, 160, 32);
        y += 120;
    }

    const int colW = (getWidth() - pad * 3) / 2;
    const int colH = 328;

    // Session (left)
    sessionGroup.setBounds(pad, y, colW, colH);
    inviteCodeInput.setBounds(14, 26, colW - 14 - 176, 28);
    joinSessionButton.setBounds(colW - 170, 26, 56, 28);
    createSessionButton.setBounds(colW - 108, 26, 94, 28);
    sessionCodeLabel.setBounds(10, 26, colW - 140, 28);
    copyInviteButton.setBounds(colW - 128, 26, 56, 28);
    leaveSessionButton.setBounds(colW - 68, 26, 54, 28);
    connectionStatusLabel.setBounds(10, 58, colW - 20, 18);
    onlineLabel.setBounds(10, 80, colW - 20, 92);
    activityLabel.setBounds(10, 176, colW - 20, 108);
    noteInput.setBounds(14, colH - 40, colW - 28 - 56, 26);
    logNoteButton.setBounds(colW - 14 - 50, colH - 40, 50, 26);

    // Tempo & Audio (right)
    audioGroup.setBounds(pad * 2 + colW, y, colW, colH);
    const int iw = colW - 28;
    tempoLabel.setBounds(10, 22, iw, 20);
    tempoHintLabel.setBounds(10, 44, iw - 130, 22);
    useMyTempoButton.setBounds(colW - 14 - 128, 44, 128, 22);
    linkLabel.setBounds(10, 68, iw, 16);
    latencyMeter.setBounds(14, 90, iw, 62);
    audioStatsLabel.setBounds(10, 154, iw, 16);
    remoteVolumeLabel.setBounds(10, 176, 120, 22);
    remoteVolumeSlider.setBounds(130, 176, iw - 116, 22);
    jitterLabel.setBounds(10, 202, 120, 22);
    jitterSlider.setBounds(130, 202, iw - 116, 22);
    muteSendToggle.setBounds(10, 232, 160, 22);
    forceRelayToggle.setBounds(170, 232, 180, 22);

    y += colH + 10;

    // Bottom panel (tabs sit in the group's header row)
    const int aw = getWidth() - pad * 2;
    const juce::Rectangle<int> bottom(pad, y, aw, getHeight() - y - 10);
    clipGroup.setBounds(bottom);
    clipEditor->setBounds(12, 26, aw - 24, bottom.getHeight() - 36);
    agentsTabButton.setBounds(bottom.getRight() - 12 - 130, y + 3, 130, 18);
    clipTabButton.setBounds(agentsTabButton.getX() - 6 - 100, y + 3, 100, 18);
    aiAgentsGroup.setBounds(bottom);
    beatJamToggle.setBounds(12, 24, 120, 24);
    beatJamPromptInput.setBounds(136, 24, aw - 136 - 140 - 14, 24);
    beatJamStartButton.setBounds(aw - 14 - 136, 24, 66, 24);
    beatJamStopButton.setBounds(aw - 14 - 66, 24, 66, 24);
    beatJamStatusLabel.setBounds(12, 52, aw - 24 - 190, 20);
    beatJamVolumeSlider.setBounds(aw - 14 - 186, 52, 186, 20);
    mixDoctorButton.setBounds(14, 78, 196, 26);
    creditsAgentButton.setBounds(216, 78, 170, 26);
    approveCreditsButton.setBounds(392, 78, 110, 26);
    aiStatusLabel.setBounds(508, 78, aw - 508 - 14, 26);
    agentReportView.setBounds(14, 110, aw - 28, aiAgentsGroup.getHeight() - 110 - 12);
}

} // namespace downbeat
