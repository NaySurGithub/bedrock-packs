#pragma once

#include "RakNet/RakNetTypes.h"

#include <deque>
#include <string>

namespace bedrock_packs {
    inline std::deque<std::string> incoming_datagrams;
    inline std::deque<std::string> outgoing_datagrams;
    inline RakNet::SystemAddress remote_address;
    inline size_t queued_datagram_bytes = 0;
    inline constexpr size_t max_queued_datagram_bytes = 4 * 1024 * 1024;
}
