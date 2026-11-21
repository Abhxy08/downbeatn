#pragma once

namespace downbeat {

/** What the local user played during one reporting window (read + reset by the network side). */
struct ActivityWindow {
    double activeSeconds{0.0};   // seconds where the sent audio was above -50 dBFS
    double totalSeconds{0.0};
    float peakDb{-160.0f};
    int midiNotes{0};
    int lowestNote{-1};
    int highestNote{-1};
};

} // namespace downbeat
