#include "AudioPacket.h"
#include <cmath>
#include <cstring>

namespace downbeat::wire {

void putU16(uint8_t* p, uint16_t v) noexcept { p[0] = uint8_t(v >> 8); p[1] = uint8_t(v); }
void putU32(uint8_t* p, uint32_t v) noexcept { for (int i = 0; i < 4; ++i) p[i] = uint8_t(v >> (24 - 8 * i)); }
void putU64(uint8_t* p, uint64_t v) noexcept { for (int i = 0; i < 8; ++i) p[i] = uint8_t(v >> (56 - 8 * i)); }
uint16_t getU16(const uint8_t* p) noexcept { return uint16_t((p[0] << 8) | p[1]); }
uint32_t getU32(const uint8_t* p) noexcept {
    return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 8) | uint32_t(p[3]);
}
uint64_t getU64(const uint8_t* p) noexcept {
    uint64_t v = 0;
    for (int i = 0; i < 8; ++i) v = (v << 8) | p[i];
    return v;
}

bool Uuid::parse(const juce::String& text, Uuid& out) {
    const auto hex = text.removeCharacters("-").toLowerCase();
    if (hex.length() != 32 || !hex.containsOnly("0123456789abcdef")) return false;
    for (int i = 0; i < 16; ++i)
        out.bytes[(size_t) i] = (uint8_t) hex.substring(i * 2, i * 2 + 2).getHexValue32();
    return true;
}

juce::String Uuid::toString() const {
    juce::String h = juce::String::toHexString(bytes.data(), 16, 0);
    return h.substring(0, 8) + "-" + h.substring(8, 12) + "-" + h.substring(12, 16) + "-"
         + h.substring(16, 20) + "-" + h.substring(20);
}

bool Uuid::isZero() const {
    for (auto b : bytes) if (b != 0) return false;
    return true;
}

void writeHeader(uint8_t* dst, PacketType type, const Uuid& session, const Uuid& sender) noexcept {
    putU32(dst, kMagic);
    dst[4] = kVersion;
    dst[5] = static_cast<uint8_t>(type);
    dst[6] = dst[7] = 0;
    std::memcpy(dst + 8, session.bytes.data(), 16);
    std::memcpy(dst + 24, sender.bytes.data(), 16);
}

bool parseHeader(const uint8_t* src, int len, Header& out) noexcept {
    if (len < kHeaderSize || getU32(src) != kMagic || src[4] != kVersion) return false;
    out.type = static_cast<PacketType>(src[5]);
    std::memcpy(out.session.bytes.data(), src + 8, 16);
    std::memcpy(out.sender.bytes.data(), src + 24, 16);
    return true;
}

int encodeAudio(uint8_t* dst, int capacity, const Uuid& session, const Uuid& sender,
                uint32_t sequence, const float* left, const float* right, int frames) noexcept {
    if (frames <= 0 || frames > kMaxFramesPerPacket) return 0;
    const int total = kHeaderSize + kAudioMetaSize + frames * 2 * 3;
    if (capacity < total) return 0;

    writeHeader(dst, PacketType::Audio, session, sender);
    uint8_t* p = dst + kHeaderSize;
    putU32(p, sequence);
    putU16(p + 4, (uint16_t) frames);
    p[6] = 2;   // channels
    p[7] = 24;  // bits
    putU32(p + 8, (uint32_t) kStreamSampleRate);
    p += kAudioMetaSize;

    auto put24 = [](uint8_t*& q, float x) {
        x = juce::jlimit(-1.0f, 1.0f, x);
        const int32_t v = (int32_t) std::lrint(x * 8388607.0f);
        q[0] = uint8_t(v);
        q[1] = uint8_t(v >> 8);
        q[2] = uint8_t(v >> 16);
        q += 3;
    };
    for (int i = 0; i < frames; ++i) {
        put24(p, left[i]);
        put24(p, right[i]);
    }
    return total;
}

bool decodeAudio(const uint8_t* packet, int len, uint32_t& sequence,
                 float* left, float* right, int maxFrames, int& frames) noexcept {
    if (len < kHeaderSize + kAudioMetaSize) return false;
    const uint8_t* p = packet + kHeaderSize;
    sequence = getU32(p);
    frames = getU16(p + 4);
    const int channels = p[6], bits = p[7];
    const uint32_t rate = getU32(p + 8);

    if (channels != 2 || bits != 24 || rate != (uint32_t) kStreamSampleRate) return false;
    if (frames <= 0 || frames > maxFrames) return false;
    if (len < kHeaderSize + kAudioMetaSize + frames * 6) return false;

    p += kAudioMetaSize;
    auto get24 = [](const uint8_t*& q) {
        int32_t v = int32_t(q[0]) | (int32_t(q[1]) << 8) | (int32_t(q[2]) << 16);
        if (v & 0x800000) v |= ~0xFFFFFF; // sign-extend
        q += 3;
        return (float) v / 8388607.0f;
    };
    for (int i = 0; i < frames; ++i) {
        left[i] = get24(p);
        right[i] = get24(p);
    }
    return true;
}

int encodeHello(uint8_t* dst, const Uuid& session, const Uuid& sender, int64_t expiresAtMs, const juce::String& tokenHex) noexcept {
    writeHeader(dst, PacketType::Hello, session, sender);
    putU64(dst + kHeaderSize, (uint64_t) expiresAtMs);
    juce::MemoryBlock token;
    token.loadFromHexString(tokenHex);
    std::memset(dst + kHeaderSize + 8, 0, 16);
    std::memcpy(dst + kHeaderSize + 8, token.getData(), juce::jmin<size_t>(16, token.getSize()));
    return kHeaderSize + 24;
}

int encodeTimestampPacket(uint8_t* dst, PacketType type, const Uuid& session, const Uuid& sender, uint64_t micros) noexcept {
    writeHeader(dst, type, session, sender);
    putU64(dst + kHeaderSize, micros);
    return kHeaderSize + 8;
}

bool decodeTimestamp(const uint8_t* packet, int len, uint64_t& micros) noexcept {
    if (len < kHeaderSize + 8) return false;
    micros = getU64(packet + kHeaderSize);
    return true;
}

} // namespace downbeat::wire
