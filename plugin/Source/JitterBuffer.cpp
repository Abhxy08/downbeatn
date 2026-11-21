#include "JitterBuffer.h"
#include <cmath>
#include <cstring>
#include <thread>

namespace downbeat {

JitterBuffer::JitterBuffer(int targetLatencyMs)
    : targetMs(juce::jlimit(5, 250, targetLatencyMs)),
      // Allocated once (never swapped) so stats readers can't race a reallocation.
      // 1 s at the highest common host rate is far more than any jitter target.
      fifo(std::make_unique<AudioFifo>(2, 192000 + 1))
{
}

JitterBuffer::~JitterBuffer() {
    accepting.store(false);
    while (pushesInFlight.load() != 0) std::this_thread::yield();
}

void JitterBuffer::prepare(double hostSampleRate, int maxBlockSize) {
    // Exclude the network thread while we (re)allocate.
    accepting.store(false);
    while (pushesInFlight.load() != 0) std::this_thread::yield();

    hostRate.store(hostSampleRate);
    juce::ignoreUnused(maxBlockSize);

    slots.assign(kReorderSlots, Slot{});
    for (auto& s : slots) {
        s.l.assign(kMaxPacketFrames, 0.0f);
        s.r.assign(kMaxPacketFrames, 0.0f);
    }
    lastL.assign(kMaxPacketFrames, 0.0f);
    lastR.assign(kMaxPacketFrames, 0.0f);
    concealL.assign(kMaxPacketFrames, 0.0f);
    concealR.assign(kMaxPacketFrames, 0.0f);

    const int maxOut = StreamingResampler::maxOutputFor(kMaxPacketFrames, (double) kStreamRate / hostSampleRate * 0.99);
    rsOutL.assign((size_t) maxOut, 0.0f);
    rsOutR.assign((size_t) maxOut, 0.0f);
    resampler.prepare(kMaxPacketFrames);

    fifo->reset();

    streamStarted = false;
    lastFrames = 0;
    smoothedLevel = 0.0;
    lastArrivalMs = -1.0;
    jitterMs = 0.0;
    playing = false;

    statReceived = statLate = statLost = statUnderruns = statOverflow = 0;
    statJitter = 0.0f;
    statPlaying = false;

    accepting.store(true);
}

void JitterBuffer::setTargetLatencyMs(int ms) noexcept {
    targetMs.store(juce::jlimit(5, 250, ms));
}

void JitterBuffer::resetStream() {
    pushesInFlight.fetch_add(1);
    if (accepting.load()) {
        for (auto& s : slots) s.valid = false;
        streamStarted = false;
        lastFrames = 0;
        lastArrivalMs = -1.0;
        resampler.reset();
    }
    pushesInFlight.fetch_sub(1);
}

void JitterBuffer::pushPacket(uint32_t seq, const float* left, const float* right, int frames, double arrivalMs) {
    pushesInFlight.fetch_add(1);
    if (!accepting.load() || frames <= 0 || frames > kMaxPacketFrames) {
        pushesInFlight.fetch_sub(1);
        return;
    }
    statReceived.fetch_add(1);

    // RFC 3550 inter-arrival jitter: compare arrival spacing with send spacing.
    if (lastArrivalMs >= 0.0) {
        const auto seqDelta = (int32_t) (seq - lastArrivalSeq);
        if (seqDelta > 0 && seqDelta < 1000) {
            const double expected = seqDelta * frames * 1000.0 / kStreamRate;
            const double d = std::abs((arrivalMs - lastArrivalMs) - expected);
            jitterMs += (d - jitterMs) / 16.0;
            statJitter.store((float) jitterMs);
        }
    }
    lastArrivalMs = arrivalMs;
    lastArrivalSeq = seq;

    if (!streamStarted) {
        streamStarted = true;
        expectedSeq = highestSeq = seq;
    }

    const auto ahead = (int32_t) (seq - expectedSeq);
    if (ahead < 0) {
        // Late. If it's *very* late, the sender restarted its sequence numbers.
        if (ahead < -kReorderSlots) {
            for (auto& s : slots) s.valid = false;
            expectedSeq = highestSeq = seq;
        } else {
            statLate.fetch_add(1);
            pushesInFlight.fetch_sub(1);
            return;
        }
    } else if (ahead >= kReorderSlots) {
        // Huge gap (long outage): skip ahead rather than concealing seconds of audio.
        for (auto& s : slots) s.valid = false;
        expectedSeq = highestSeq = seq;
    }

    auto& slot = slots[seq % kReorderSlots];
    slot.seq = seq;
    slot.frames = frames;
    slot.valid = true;
    std::memcpy(slot.l.data(), left, sizeof(float) * (size_t) frames);
    std::memcpy(slot.r.data(), right, sizeof(float) * (size_t) frames);
    if ((int32_t) (seq - highestSeq) > 0) highestSeq = seq;

    releaseInOrder();
    pushesInFlight.fetch_sub(1);
}

void JitterBuffer::releaseInOrder() {
    for (;;) {
        auto& slot = slots[expectedSeq % kReorderSlots];
        if (slot.valid && slot.seq == expectedSeq) {
            emit(slot.l.data(), slot.r.data(), slot.frames);
            std::memcpy(lastL.data(), slot.l.data(), sizeof(float) * (size_t) slot.frames);
            std::memcpy(lastR.data(), slot.r.data(), sizeof(float) * (size_t) slot.frames);
            lastFrames = slot.frames;
            slot.valid = false;
            ++expectedSeq;
        } else if ((int32_t) (highestSeq - expectedSeq) >= kReorderWindow) {
            // Gave up waiting for expectedSeq: conceal it.
            statLost.fetch_add(1);
            emitConcealment(lastFrames > 0 ? lastFrames : 128);
            ++expectedSeq;
        } else {
            return;
        }
    }
}

void JitterBuffer::emitConcealment(int frames) {
    // Fade the previous packet out (avoids a click), then decay to silence on repeated loss.
    for (int i = 0; i < frames; ++i) {
        const float g = 0.5f * (1.0f - (float) i / (float) frames);
        concealL[(size_t) i] = lastL[(size_t) i] * g;
        concealR[(size_t) i] = lastR[(size_t) i] * g;
    }
    emit(concealL.data(), concealR.data(), frames);
    std::fill(lastL.begin(), lastL.end(), 0.0f);
    std::fill(lastR.begin(), lastR.end(), 0.0f);
}

void JitterBuffer::emit(const float* l, const float* r, int frames) {
    const double host = hostRate.load();
    const double target = targetMs.load() * host / 1000.0;
    const double level = fifo->getNumReady();

    // Way over target (e.g. after a burst): drop rather than build up latency.
    if (level > target * 3.0 + host * 0.02) {
        statOverflow.fetch_add(1);
        return;
    }

    // Clock-drift trim: nudge the resampling ratio by at most ±0.2 % (inaudible) so the
    // buffer level converges on the target instead of slowly over/underflowing.
    smoothedLevel += (level - smoothedLevel) * 0.01;
    const double err = target > 0.0 ? (smoothedLevel - target) / target : 0.0;
    const double trim = juce::jlimit(-0.002, 0.002, err * 0.002);
    const double ratio = (double) kStreamRate / host * (1.0 + trim);

    const int n = resampler.process(l, r, frames, rsOutL.data(), rsOutR.data(), (int) rsOutL.size(), ratio);
    const float* outs[2] = { rsOutL.data(), rsOutR.data() };
    if (fifo->write(outs, n) < n) statOverflow.fetch_add(1);
}

void JitterBuffer::read(float* left, float* right, int numSamples) noexcept {
    const int ready = fifo->getNumReady();
    if (!playing) {
        const int target = (int) (targetMs.load() * hostRate.load() / 1000.0);
        if (ready >= juce::jmax(target, numSamples)) {
            playing = true;
            statPlaying.store(true);
        }
    }

    int got = 0;
    if (playing) {
        float* dst[2] = { left, right };
        got = fifo->read(dst, numSamples);
        if (got < numSamples) {
            // Ran dry: play what we had, then re-buffer up to the target.
            playing = false;
            statPlaying.store(false);
            statUnderruns.fetch_add(1);
        }
    }
    if (got < numSamples) {
        std::memset(left + got, 0, sizeof(float) * (size_t) (numSamples - got));
        std::memset(right + got, 0, sizeof(float) * (size_t) (numSamples - got));
    }
}

JitterBufferStats JitterBuffer::getStats() const {
    JitterBufferStats s;
    s.packetsReceived = statReceived.load();
    s.packetsLate = statLate.load();
    s.packetsLost = statLost.load();
    s.underruns = statUnderruns.load();
    s.overflowDrops = statOverflow.load();
    s.arrivalJitterMs = statJitter.load();
    s.targetMs = targetMs.load();
    s.playing = statPlaying.load();
    const double rate = hostRate.load();
    if (rate > 0.0) s.bufferedMs = (float) (fifo->getNumReady() * 1000.0 / rate);
    return s;
}

} // namespace downbeat
