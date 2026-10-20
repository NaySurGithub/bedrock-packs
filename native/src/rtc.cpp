#include "bedrock_packs/output.h"
#include "bedrock_packs/query.h"

#include "Network/NetherNet/NetherNetConnection.h"

#include <emscripten/emscripten.h>
#include <memory>

namespace {
    std::shared_ptr<nethernet::Connection> connection;
    std::shared_ptr<rtc::DataChannel> reliable;
    std::shared_ptr<rtc::DataChannel> unreliable;
}

extern "C" {
    EMSCRIPTEN_KEEPALIVE void bp_nethernet_close() {
        connection.reset();
        reliable.reset();
        unreliable.reset();
    }

    EMSCRIPTEN_KEEPALIVE int bp_nethernet_start() {
        bp_nethernet_close();
        connection = std::make_shared<nethernet::Connection>(
            NetworkIdentifier("browser", 0),
            std::make_shared<rtc::PeerConnection>()
        );
        reliable = std::make_shared<rtc::DataChannel>(nethernet::RELIABLE_CHANNEL_LABEL, rtc::Reliability{});
        rtc::Reliability options;
        options.unordered = true;
        options.maxRetransmits = 0;
        unreliable = std::make_shared<rtc::DataChannel>(nethernet::UNRELIABLE_CHANNEL_LABEL, options);
        return connection->attachChannel(reliable) && connection->attachChannel(unreliable);
    }

    EMSCRIPTEN_KEEPALIVE int bp_nethernet_input(int kind, unsigned int length) {
        if (!connection || connection->isClosed() || length < 2 || length > 262144 ||
            (kind != 0 && kind != 1)) {
            return 0;
        }

        const auto channel = kind == 0 ? reliable : unreliable;
        channel->input(reinterpret_cast<const std::byte*>(bp_buffer()), length);
        return !connection->isClosed();
    }

    EMSCRIPTEN_KEEPALIVE int bp_nethernet_send(unsigned int length) {
        if (!connection || connection->isClosed() || length == 0 || length > bp_capacity()) {
            return 0;
        }

        connection->sendPacket(
            std::string(reinterpret_cast<char*>(bp_buffer()), length),
            NetworkPeer::Reliability::ReliableOrdered,
            Compressibility::Compressible
        );
        return !connection->isClosed();
    }

    EMSCRIPTEN_KEEPALIVE const char* bp_nethernet_output() {
        return bedrock_packs::set_output(reliable ? reliable->take() : std::string{});
    }

    EMSCRIPTEN_KEEPALIVE const char* bp_nethernet_receive() {
        std::string data;

        if (connection) {
            connection->receivePacket(data);
        }

        return bedrock_packs::set_output(std::move(data));
    }
}
