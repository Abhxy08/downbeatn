#pragma once

#include <juce_core/juce_core.h>
#include <array>
#include <cstdint>

namespace downbeat::stun {

/**
 * Minimal STUN (RFC 5389) Binding client — just enough to learn our public
 * IPv4 address:port as seen from the internet, for UDP hole punching.
 */
constexpr uint32_t kMagicCookie = 0x2112A442;
constexpr int kHeaderSize = 20;

using TransactionId = std::array<uint8_t, 12>;

/** Writes a 20-byte Binding Request. */
void buildBindingRequest(uint8_t* out, const TransactionId& txId) noexcept;

/** True if the datagram looks like a STUN message (vs. a DownBeat packet). */
bool looksLikeStun(const uint8_t* data, int len) noexcept;

/** Parses a Binding Success Response for `txId`; extracts XOR-MAPPED-ADDRESS (or MAPPED-ADDRESS). */
bool parseBindingResponse(const uint8_t* data, int len, const TransactionId& txId,
                          juce::String& ip, int& port) noexcept;

/** "stun:host:port" / "host:port" / "host" -> host, port (default 3478). */
void parseServer(const juce::String& uri, juce::String& host, int& port);

} // namespace downbeat::stun
