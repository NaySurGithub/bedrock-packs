#include "bedrock_packs/socket.h"

#include "RakNet/RakNetSocket2.h"

#include <cstring>
#include <utility>

namespace RakNet {
    RakNetSocket2::RakNetSocket2() : sock(-1) {}

    RakNetSocket2::~RakNetSocket2() {
        Close();
    }

    RNS2BindResult RakNetSocket2::Bind(const char*, unsigned short, short) {
        sock = 1;
        boundAddress.FromString("0.0.0.0", 0);
        return BR_SUCCESS;
    }

    void RakNetSocket2::Close() {
        sock = -1;
        bedrock_packs::incoming_datagrams.clear();
        bedrock_packs::outgoing_datagrams.clear();
        bedrock_packs::queued_datagram_bytes = 0;
    }

    bool RakNetSocket2::IsOpen() const {
        return sock >= 0;
    }

    int RakNetSocket2::Send(const char* data, int length, const SystemAddress& address) {
        using namespace bedrock_packs;

        if (!IsOpen() || length <= 0 || length > 1492 || address != remote_address ||
            queued_datagram_bytes + static_cast<size_t>(length) > max_queued_datagram_bytes) {
            return -1;
        }

        outgoing_datagrams.emplace_back(data, static_cast<size_t>(length));
        queued_datagram_bytes += static_cast<size_t>(length);
        return length;
    }

    bool RakNetSocket2::RecvFrom(RNS2RecvStruct* received, int) {
        using namespace bedrock_packs;

        if (!IsOpen() || incoming_datagrams.empty()) {
            return false;
        }

        const auto data = std::move(incoming_datagrams.front());
        incoming_datagrams.pop_front();
        queued_datagram_bytes -= data.size();
        std::memcpy(received->data, data.data(), data.size());
        received->bytesRead = static_cast<int>(data.size());
        received->systemAddress = remote_address;
        received->timeRead = GetTimeUS();
        return true;
    }
}
