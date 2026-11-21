#pragma once

#include <juce_core/juce_core.h>
#include <array>
#include <cstdint>

namespace downbeat::wire {

/**
 * DownBeat UDP wire format, shared by direct P2P traffic and the relay.
 * Mirror of relay/src/protocol.ts — keep them in sync.
 *
 *  offset size field
 *  0      4    magic "DWBT" (big-endian)
 *  4      1    version (1)
 *  5      1    type (PacketType)
 *  6      2    reserved
 *  8      16   sessionId (UUID bytes)
 *  24     16   senderId (WebSocket connectionId UUID bytes)
 *  40     ...  payload
 *
 * Multi-byte integers are big-endian. PCM samples are signed 24-bit little-endian,
 * interleaved L/R, always 48 kHz on the wire.
 */
constexpr uint32_t kMagic = 0x44574254;
constexpr uint8_t kVersion = 1;
constexpr int kHeaderSize = 40;
constexpr int kStreamSampleRate = 48000;
constexpr int kFramesPerPacket = 128;          // 2.67 ms per packet
constexpr int kMaxFramesPerPacket = 256;
constexpr int kAudioMetaSize = 12;             // seq u32, frames u16, channels u8, bits u8, rate u32
constexpr int kMaxPacketSize = kHeaderSize + kAudioMetaSize + kMaxFramesPerPacket * 2 * 3;

enum class PacketType : uint8_t {
    Hello = 1, HelloAck = 2, Audio = 3, Ping = 4, Pong = 5,
    Bye = 6, Probe = 7, ProbeAck = 8, Keepalive = 9
};

enum class HelloStatus : uint8_t { Ok = 0, BadToken = 1, Expired = 2 };

struct Uuid {
    std::array<uint8_t, 16> bytes{};

    /** Parses "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" (hyphens optional). */
    static bool parse(const juce::String& text, Uuid& out);
    juce::String toString() const;
    bool isZero() const;
    bool operator==(const Uuid& o) const { return bytes == o.bytes; }
    bool operator!=(const Uuid& o) const { return !(*this == o); }
};

struct Header {
    PacketType type{PacketType::Audio};
    Uuid session;
    Uuid sender;
};

void writeHeader(uint8_t* dst, PacketType type, const Uuid& session, const Uuid& sender) noexcept;
bool parseHeader(const uint8_t* src, int len, Header& out) noexcept;

/** Encodes one audio packet. Returns total bytes written, or 0 if `capacity` is too small. */
int encodeAudio(uint8_t* dst, int capacity, const Uuid& session, const Uuid& sender,
                uint32_t sequence, const float* left, const float* right, int frames) noexcept;

/** Decodes the payload of an audio packet (after the header). */
bool decodeAudio(const uint8_t* packet, int len, uint32_t& sequence,
                 float* left, float* right, int maxFrames, int& frames) noexcept;

/** HELLO payload for relay registration: u64 expiresAt + 16-byte token (hex in, bytes out). */
int encodeHello(uint8_t* dst, const Uuid& session, const Uuid& sender, int64_t expiresAtMs, const juce::String& tokenHex) noexcept;

/** PING/PONG payload is a u64 timestamp in microseconds. */
int encodeTimestampPacket(uint8_t* dst, PacketType type, const Uuid& session, const Uuid& sender, uint64_t micros) noexcept;
bool decodeTimestamp(const uint8_t* packet, int len, uint64_t& micros) noexcept;

// Byte helpers (exposed for tests)
void putU16(uint8_t* p, uint16_t v) noexcept;
void putU32(uint8_t* p, uint32_t v) noexcept;
void putU64(uint8_t* p, uint64_t v) noexcept;
uint16_t getU16(const uint8_t* p) noexcept;
uint32_t getU32(const uint8_t* p) noexcept;
uint64_t getU64(const uint8_t* p) noexcept;

} // namespace downbeat::wire
