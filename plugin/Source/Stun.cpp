#include "Stun.h"
#include <cstring>

namespace downbeat::stun {

namespace {
uint16_t rd16(const uint8_t* p) { return uint16_t((p[0] << 8) | p[1]); }
uint32_t rd32(const uint8_t* p) { return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 8) | p[3]; }
constexpr uint16_t kBindingRequest = 0x0001;
constexpr uint16_t kBindingSuccess = 0x0101;
constexpr uint16_t kAttrMappedAddress = 0x0001;
constexpr uint16_t kAttrXorMappedAddress = 0x0020;
} // namespace

void buildBindingRequest(uint8_t* out, const TransactionId& txId) noexcept {
    out[0] = uint8_t(kBindingRequest >> 8);
    out[1] = uint8_t(kBindingRequest);
    out[2] = out[3] = 0; // message length (no attributes)
    out[4] = uint8_t(kMagicCookie >> 24);
    out[5] = uint8_t(kMagicCookie >> 16);
    out[6] = uint8_t(kMagicCookie >> 8);
    out[7] = uint8_t(kMagicCookie);
    std::memcpy(out + 8, txId.data(), 12);
}

bool looksLikeStun(const uint8_t* data, int len) noexcept {
    return len >= kHeaderSize && (data[0] & 0xC0) == 0 && rd32(data + 4) == kMagicCookie;
}

bool parseBindingResponse(const uint8_t* data, int len, const TransactionId& txId,
                          juce::String& ip, int& port) noexcept {
    if (!looksLikeStun(data, len) || rd16(data) != kBindingSuccess) return false;
    if (std::memcmp(data + 8, txId.data(), 12) != 0) return false;

    const int msgLen = rd16(data + 2);
    if (kHeaderSize + msgLen > len) return false;

    bool found = false;
    int offset = kHeaderSize;
    while (offset + 4 <= kHeaderSize + msgLen) {
        const uint16_t type = rd16(data + offset);
        const uint16_t alen = rd16(data + offset + 2);
        const uint8_t* v = data + offset + 4;
        if (offset + 4 + alen > len) return false;

        if ((type == kAttrXorMappedAddress || type == kAttrMappedAddress) && alen >= 8 && v[1] == 0x01 /* IPv4 */) {
            uint16_t p = rd16(v + 2);
            uint32_t addr = rd32(v + 4);
            if (type == kAttrXorMappedAddress) {
                p ^= uint16_t(kMagicCookie >> 16);
                addr ^= kMagicCookie;
            }
            port = p;
            ip = juce::String((addr >> 24) & 0xFF) + "." + juce::String((addr >> 16) & 0xFF) + "."
               + juce::String((addr >> 8) & 0xFF) + "." + juce::String(addr & 0xFF);
            found = true;
            if (type == kAttrXorMappedAddress) return true; // preferred
        }
        offset += 4 + ((alen + 3) & ~3); // attributes are 32-bit aligned
    }
    return found;
}

void parseServer(const juce::String& uri, juce::String& host, int& port) {
    auto s = uri.trim();
    if (s.startsWithIgnoreCase("stun:")) s = s.substring(5);
    port = 3478;
    if (s.containsChar(':')) {
        host = s.upToLastOccurrenceOf(":", false, false);
        port = s.fromLastOccurrenceOf(":", false, false).getIntValue();
    } else {
        host = s;
    }
}

} // namespace downbeat::stun
