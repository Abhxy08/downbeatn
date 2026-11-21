// Standalone-app conveniences (no effect inside a DAW).
#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_audio_plugin_client/Standalone/juce_StandaloneFilterWindow.h>
#include <set>

namespace downbeat {

namespace {
/**
 * On some Linux setups (PipeWire's ALSA device exposes 8 channels) JUCE's default picks
 * output channels 3+4, which is silence on stereo headphones. The first time each device
 * is opened we make sure the first stereo pair is active for output and input. A choice
 * the user makes afterwards for the same device is respected.
 */
class FirstStereoPairFix : private juce::ChangeListener {
public:
    explicit FirstStereoPairFix(juce::AudioDeviceManager& dm) : manager(dm) {
        manager.addChangeListener(this);
        apply();
    }

private:
    void changeListenerCallback(juce::ChangeBroadcaster*) override { apply(); }

    void apply() {
        auto* device = manager.getCurrentAudioDevice();
        if (device == nullptr) return;
        const auto key = device->getTypeName() + "|" + device->getName();
        if (!fixedDevices.insert(key).second) return; // already handled this device

        auto setup = manager.getAudioDeviceSetup();
        bool changed = false;
        auto ensureFirstPair = [&](juce::BigInteger& channels, bool& useDefault, int available) {
            if (available < 2 || (channels[0] && channels[1])) return;
            channels.clear();
            channels.setRange(0, 2, true);
            useDefault = false;
            changed = true;
        };
        ensureFirstPair(setup.outputChannels, setup.useDefaultOutputChannels, device->getOutputChannelNames().size());
        ensureFirstPair(setup.inputChannels, setup.useDefaultInputChannels, device->getInputChannelNames().size());
        if (changed) manager.setAudioDeviceSetup(setup, true);
    }

    juce::AudioDeviceManager& manager;
    std::set<juce::String> fixedDevices;
};
} // namespace

/** Call once from the message thread (e.g. the editor constructor). No-op inside a DAW. */
void installStandaloneAudioFixes() {
    static std::unique_ptr<FirstStereoPairFix> fix;
    if (fix != nullptr || !juce::JUCEApplicationBase::isStandaloneApp()) return;
    if (auto* holder = juce::StandalonePluginHolder::getInstance())
        fix = std::make_unique<FirstStereoPairFix>(holder->deviceManager);
}

} // namespace downbeat
