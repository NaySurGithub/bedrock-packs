#include "bedrock_packs/query.h"

#include "Network/ServerQuery.h"
#include "RakNet/BitStream.h"
#include "RakNet/MessageIdentifiers.h"
#include "RakNet/RakNetDefines.h"

#include <emscripten/emscripten.h>
#include <algorithm>
#include <cstring>

namespace {
    constexpr uint32_t DatagramCapacity = 1492;
    constexpr uint32_t BufferCapacity = 8 * 1024 * 1024;

    uint8_t buffer[BufferCapacity];
}

EMSCRIPTEN_KEEPALIVE uint8_t* bp_buffer() {
    return buffer;
}

EMSCRIPTEN_KEEPALIVE uint32_t bp_capacity() {
    return BufferCapacity;
}

EMSCRIPTEN_KEEPALIVE uint32_t bp_build_ping(
    uint32_t timestamp,
    uint32_t guid_high,
    uint32_t guid_low
) {
    RakNet::BitStream stream;
    stream.Write(static_cast<uint8_t>(RakNet::ID_UNCONNECTED_PING));
    stream.Write(static_cast<uint64_t>(timestamp));
    stream.WriteAlignedBytes(
        RakNet::OFFLINE_MESSAGE_DATA_ID,
        sizeof(RakNet::OFFLINE_MESSAGE_DATA_ID)
    );
    stream.Write((static_cast<uint64_t>(guid_high) << 32) | guid_low);

    const auto length = stream.GetNumberOfBytesUsed();
    std::memcpy(buffer, stream.GetData(), length);

    return length;
}

EMSCRIPTEN_KEEPALIVE int32_t bp_read_pong(uint32_t length, uint32_t expected_timestamp) {
    if (length < 35 || length > DatagramCapacity) {
        return -1;
    }

    RakNet::BitStream stream(buffer, length, true);
    uint8_t identifier = 0;
    uint64_t timestamp = 0;
    uint64_t guid = 0;
    uint8_t magic[16] = {};
    uint16_t announcement_length = 0;

    if (!stream.Read(identifier) || identifier != RakNet::ID_UNCONNECTED_PONG) {
        return -1;
    }

    if (!stream.Read(timestamp) || timestamp != expected_timestamp || !stream.Read(guid)) {
        return -2;
    }

    if (!stream.ReadAlignedBytes(magic, sizeof(magic)) ||
        !std::equal(std::begin(magic), std::end(magic), RakNet::OFFLINE_MESSAGE_DATA_ID)) {
        return -3;
    }

    if (!stream.Read(announcement_length) || announcement_length == 0 ||
        35u + announcement_length != length) {
        return -4;
    }

    ServerQueryResult announcement;
    ServerQuery::readAnnouncement(
        std::string(reinterpret_cast<const char*>(buffer + 35), announcement_length),
        announcement
    );

    if (announcement.mProtocol <= 0) {
        return -5;
    }

    return announcement_length;
}
