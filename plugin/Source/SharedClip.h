#pragma once

#include <juce_core/juce_core.h>
#include <array>
#include <atomic>
#include <vector>

namespace downbeat {

/**
 * The session's shared MIDI clip (4 bars, 16th-note grid), edited live by every collaborator.
 *
 *  - Network/UI threads edit the master list under a lock (getNotes / apply* / replaceAll).
 *  - The audio thread reads a lock-free snapshot: each note is packed into one 32-bit atomic,
 *    published with a sequence counter (seqlock). No locks, no allocation on the audio thread.
 */
class SharedClip {
public:
    static constexpr int kSteps = 64;        // 4 bars x 16 steps
    static constexpr int kStepsPerBeat = 4;
    static constexpr int kMaxNotes = 512;

    struct Note {
        juce::String id;
        int step{0}, length{1}, pitch{60}, velocity{100};
        juce::String byUid, byName;
    };

    /** Compact note for the audio thread. */
    struct AudioNote {
        int step, length, pitch, velocity;
    };

    // ----- message / socket threads -----
    std::vector<Note> getNotes() const {
        const juce::ScopedLock sl(lock);
        return notes;
    }

    void replaceAll(std::vector<Note> newNotes) {
        const juce::ScopedLock sl(lock);
        notes = std::move(newNotes);
        publish();
    }

    void upsert(const Note& n) {
        const juce::ScopedLock sl(lock);
        for (auto& existing : notes) {
            if (existing.id == n.id) {
                existing = n;
                publish();
                return;
            }
        }
        if ((int) notes.size() < kMaxNotes) notes.push_back(n);
        publish();
    }

    bool remove(const juce::String& id) {
        const juce::ScopedLock sl(lock);
        const auto before = notes.size();
        notes.erase(std::remove_if(notes.begin(), notes.end(), [&](const Note& n) { return n.id == id; }), notes.end());
        if (notes.size() != before) publish();
        return notes.size() != before;
    }

    void clear() {
        const juce::ScopedLock sl(lock);
        notes.clear();
        publish();
    }

    /** Increments on every change (UI uses it to know when to repaint). */
    uint32_t getVersion() const noexcept { return version.load(); }

    // ----- audio thread -----
    /**
     * Copies the current snapshot into `dest` if it changed since `lastSeq`.
     * Returns true if `dest` was updated. Lock-free; retries a few times if a write is in progress.
     */
    bool readSnapshot(std::array<AudioNote, kMaxNotes>& dest, int& count, uint32_t& lastSeq) const noexcept {
        for (int attempt = 0; attempt < 4; ++attempt) {
            const uint32_t s1 = seq.load(std::memory_order_acquire);
            if (s1 == lastSeq) return false;
            if (s1 & 1u) continue; // writer active
            const int n = juce::jmin(kMaxNotes, packedCount.load(std::memory_order_relaxed));
            for (int i = 0; i < n; ++i) dest[(size_t) i] = unpack(packed[(size_t) i].load(std::memory_order_relaxed));
            std::atomic_thread_fence(std::memory_order_acquire);
            if (seq.load(std::memory_order_relaxed) == s1) {
                count = n;
                lastSeq = s1;
                return true;
            }
        }
        return false; // keep the previous snapshot this block
    }

    static uint32_t pack(int step, int length, int pitch, int velocity) noexcept {
        return (uint32_t) (step & 0x7f) | ((uint32_t) (length & 0x7f) << 7) | ((uint32_t) (pitch & 0x7f) << 14)
             | ((uint32_t) (velocity & 0x7f) << 21);
    }
    static AudioNote unpack(uint32_t v) noexcept {
        return { (int) (v & 0x7f), (int) ((v >> 7) & 0x7f), (int) ((v >> 14) & 0x7f), (int) ((v >> 21) & 0x7f) };
    }

private:
    void publish() {
        // caller holds `lock` (single writer)
        seq.fetch_add(1, std::memory_order_acq_rel); // odd: writing
        const int n = juce::jmin(kMaxNotes, (int) notes.size());
        for (int i = 0; i < n; ++i) {
            const auto& x = notes[(size_t) i];
            packed[(size_t) i].store(pack(x.step, x.length, x.pitch, x.velocity), std::memory_order_relaxed);
        }
        packedCount.store(n, std::memory_order_relaxed);
        seq.fetch_add(1, std::memory_order_release); // even: done
        version.fetch_add(1);
    }

    mutable juce::CriticalSection lock;
    std::vector<Note> notes;

    std::array<std::atomic<uint32_t>, kMaxNotes> packed{};
    std::atomic<int> packedCount{0};
    std::atomic<uint32_t> seq{0};
    std::atomic<uint32_t> version{0};
};

} // namespace downbeat
