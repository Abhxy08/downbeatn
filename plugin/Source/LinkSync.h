#pragma once

#include <atomic>
#include <cstddef>
#include <functional>
#include <memory>

namespace downbeat {

/**
 * Thin wrapper around Ableton Link (kept out of other headers because Link pulls in asio).
 *
 * Link only discovers peers on the *local network* (UDP multicast). DownBeat bridges
 * Link sessions across the internet: each plugin joins its local Link session, and the
 * session tempo travels between collaborators over the DownBeat WebSocket.
 *
 * None of these methods may be called from the audio thread.
 */
class LinkSync {
public:
    LinkSync();
    ~LinkSync();

    void setEnabled(bool enabled);
    bool isEnabled() const;

    /** Proposes a new tempo to the local Link session (other Link apps, e.g. Ableton Live, follow it). */
    void setTempo(double bpm);
    double getTempo() const;
    std::size_t numPeers() const;

    /** Called on a Link thread when the Link session tempo changes (from us or a local Link peer). */
    std::function<void(double bpm)> onTempoChanged;

private:
    struct Impl;
    std::unique_ptr<Impl> impl;
};

} // namespace downbeat
