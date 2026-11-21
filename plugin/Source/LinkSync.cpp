#include "LinkSync.h"

#include <ableton/Link.hpp>

namespace downbeat {

struct LinkSync::Impl {
    ableton::Link link{120.0};
};

LinkSync::LinkSync() : impl(std::make_unique<Impl>()) {
    impl->link.setTempoCallback([this](double bpm) {
        if (onTempoChanged) onTempoChanged(bpm);
    });
}

LinkSync::~LinkSync() {
    impl->link.setTempoCallback([](double) {});
    impl->link.enable(false);
}

void LinkSync::setEnabled(bool enabled) {
    if (impl->link.isEnabled() != enabled) impl->link.enable(enabled);
}

bool LinkSync::isEnabled() const {
    return impl->link.isEnabled();
}

void LinkSync::setTempo(double bpm) {
    auto state = impl->link.captureAppSessionState();
    if (std::abs(state.tempo() - bpm) < 0.005) return;
    state.setTempo(bpm, impl->link.clock().micros());
    impl->link.commitAppSessionState(state);
}

double LinkSync::getTempo() const {
    return impl->link.captureAppSessionState().tempo();
}

std::size_t LinkSync::numPeers() const {
    return impl->link.numPeers();
}

} // namespace downbeat
