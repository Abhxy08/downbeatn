#pragma once

#include <vector>
#include <cmath>
#include <algorithm>

namespace downbeat {

/**
 * Streaming stereo resampler (cubic Catmull-Rom interpolation).
 * Used off the audio thread to convert host-rate audio <-> the 48 kHz wire rate,
 * and to apply a tiny ratio trim that compensates for clock drift between machines.
 *
 * `ratio` = input samples consumed per output sample (inRate / outRate).
 * Call prepare() before use; process() never allocates.
 */
class StreamingResampler {
public:
    void prepare(int maxInputBlock) {
        workL.assign((size_t) maxInputBlock + kHistory, 0.0f);
        workR.assign((size_t) maxInputBlock + kHistory, 0.0f);
        reset();
    }

    void reset() {
        std::fill(histL, histL + kHistory, 0.0f);
        std::fill(histR, histR + kHistory, 0.0f);
        pos = 0.0;
    }

    /** Upper bound on outputs produced for nIn inputs at `ratio`. */
    static int maxOutputFor(int nIn, double ratio) { return (int) std::ceil(nIn / ratio) + 2; }

    /**
     * Consumes all nIn input frames, writes up to maxOut output frames.
     * Returns number of output frames written.
     */
    int process(const float* inL, const float* inR, int nIn, float* outL, float* outR, int maxOut, double ratio) {
        if (nIn <= 0 || (size_t) (nIn + kHistory) > workL.size()) return 0;

        // work = [history (3) | new input]
        std::copy(histL, histL + kHistory, workL.begin());
        std::copy(histR, histR + kHistory, workR.begin());
        std::copy(inL, inL + nIn, workL.begin() + kHistory);
        std::copy(inR, inR + nIn, workR.begin() + kHistory);

        // pos is relative to the first new input sample; interpolating between
        // x[i] and x[i+1] needs x[i-1] .. x[i+2], i.e. i + 2 <= nIn - 1.
        int produced = 0;
        while (produced < maxOut) {
            const int i = (int) std::floor(pos);
            if (i + 2 > nIn - 1) break;
            const float t = (float) (pos - i);
            const int w = i + kHistory; // index into work
            outL[produced] = cubic(workL[(size_t) w - 1], workL[(size_t) w], workL[(size_t) w + 1], workL[(size_t) w + 2], t);
            outR[produced] = cubic(workR[(size_t) w - 1], workR[(size_t) w], workR[(size_t) w + 1], workR[(size_t) w + 2], t);
            ++produced;
            pos += ratio;
        }

        // Keep the last 3 input samples and rebase pos onto the next block.
        std::copy(workL.begin() + nIn, workL.begin() + nIn + kHistory, histL);
        std::copy(workR.begin() + nIn, workR.begin() + nIn + kHistory, histR);
        pos -= nIn;
        return produced;
    }

private:
    static constexpr int kHistory = 3;

    static float cubic(float y0, float y1, float y2, float y3, float t) {
        const float a = -0.5f * y0 + 1.5f * y1 - 1.5f * y2 + 0.5f * y3;
        const float b = y0 - 2.5f * y1 + 2.0f * y2 - 0.5f * y3;
        const float c = -0.5f * y0 + 0.5f * y2;
        return ((a * t + b) * t + c) * t + y1;
    }

    std::vector<float> workL, workR;
    float histL[kHistory]{}, histR[kHistory]{};
    double pos{0.0};
};

} // namespace downbeat
