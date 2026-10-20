#include "bedrock_packs/output.h"
#include "bedrock_packs/query.h"
#include "bedrock_packs/socket.h"

#include "RakNet/RakPeer.h"
#include "RakNet/MessageIdentifiers.h"

#include <emscripten/emscripten.h>
#include <memory>

namespace {
    std::unique_ptr<RakNet::RakPeer> peer;
}

extern "C" {
    EMSCRIPTEN_KEEPALIVE void bp_raknet_close() {
        if (peer) {
            peer->Shutdown(0);
            peer.reset();
        }
    }

    EMSCRIPTEN_KEEPALIVE int bp_raknet_start(int port) {
        bp_raknet_close();

        if (port < 1 || port > 65535) {
            return 0;
        }

        // The relay owns DNS and the destination. This address stays inside WASM.
        bedrock_packs::remote_address.FromString("127.0.0.1", static_cast<unsigned short>(port));
        peer = std::make_unique<RakNet::RakPeer>();
        RakNet::SocketDescriptor descriptor;

        if (peer->Startup(1, &descriptor, 1) != RakNet::RAKNET_STARTED ||
            !peer->Connect("127.0.0.1", static_cast<unsigned short>(port))) {
            bp_raknet_close();
            return 0;
        }

        return 1;
    }

    EMSCRIPTEN_KEEPALIVE int bp_raknet_input(unsigned int length) {
        using namespace bedrock_packs;

        if (!peer || length == 0 || length > 1492 ||
            queued_datagram_bytes + length > max_queued_datagram_bytes) {
            return 0;
        }

        incoming_datagrams.emplace_back(reinterpret_cast<char*>(bp_buffer()), length);
        queued_datagram_bytes += length;
        return 1;
    }

    EMSCRIPTEN_KEEPALIVE void bp_raknet_tick() {
        if (peer) {
            peer->browserTick();
        }
    }

    EMSCRIPTEN_KEEPALIVE const char* bp_raknet_output() {
        using namespace bedrock_packs;

        if (outgoing_datagrams.empty()) {
            return set_output({});
        }

        auto data = std::move(outgoing_datagrams.front());
        outgoing_datagrams.pop_front();
        queued_datagram_bytes -= data.size();
        return set_output(std::move(data));
    }

    EMSCRIPTEN_KEEPALIVE const char* bp_raknet_receive() {
        if (!peer) {
            return bedrock_packs::set_output({});
        }

        auto* packet = peer->Receive();

        if (!packet) {
            return bedrock_packs::set_output({});
        }

        std::string data(reinterpret_cast<char*>(packet->data), packet->length);
        peer->DeallocatePacket(packet);
        return bedrock_packs::set_output(std::move(data));
    }

    EMSCRIPTEN_KEEPALIVE int bp_raknet_send(unsigned int length) {
        if (!peer || length == 0 || length > bp_capacity() ||
            peer->GetConnectionState(bedrock_packs::remote_address) != RakNet::IS_CONNECTED) {
            return 0;
        }

        return peer->Send(
            reinterpret_cast<char*>(bp_buffer()),
            static_cast<int>(length),
            RakNet::HIGH_PRIORITY,
            RakNet::RELIABLE_ORDERED,
            0,
            bedrock_packs::remote_address,
            false
        ) != 0;
    }
}
