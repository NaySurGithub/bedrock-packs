#include "bedrock_packs/output.h"
#include "bedrock_packs/query.h"

#include "Network/BatchedNetworkPeer.h"
#include "Network/CompressedNetworkPeer.h"

#include <emscripten/emscripten.h>
#include <deque>
#include <memory>
#include <utility>

namespace {
    class BrowserPeer final : public NetworkPeer {
    public:
        explicit BrowserPeer(bool raknet) : raknet(raknet) {}

        void sendPacket(const std::string& data, Reliability, Compressibility) override {
            outgoing.push_back(data);
        }

        DataStatus receivePacket(std::string& data) override {
            if (incoming.empty()) {
                return DataStatus::NoData;
            }

            data = std::move(incoming.front());
            incoming.pop_front();
            return DataStatus::HasData;
        }

        NetworkStatus getNetworkStatus() const override {
            return {};
        }

        bool usesGamePacketId() const override {
            return raknet;
        }

        bool raknet;
        std::deque<std::string> incoming;
        std::deque<std::string> outgoing;
    };

    std::shared_ptr<BrowserPeer> transport;
    std::shared_ptr<CompressedNetworkPeer> compressed;
    std::unique_ptr<BatchedNetworkPeer> batched;
}

extern "C" {
    EMSCRIPTEN_KEEPALIVE void bp_framing_start(int raknet) {
        batched.reset();
        compressed.reset();
        transport = std::make_shared<BrowserPeer>(raknet != 0);
        compressed = std::make_shared<CompressedNetworkPeer>(transport);
        batched = std::make_unique<BatchedNetworkPeer>(compressed);
    }

    EMSCRIPTEN_KEEPALIVE int bp_compression(int algorithm, int threshold) {
        if (!compressed || (algorithm != 0 && algorithm != 1 && algorithm != 255) ||
            threshold < 0 || threshold > 65535) {
            return 0;
        }

        compressed->enableCompression(
            static_cast<CompressedNetworkPeer::CompressionAlgorithm>(algorithm),
            static_cast<unsigned short>(threshold)
        );
        return 1;
    }

    EMSCRIPTEN_KEEPALIVE int bp_frame_input(unsigned int length) {
        if (!transport || length == 0 || length > bp_capacity() || !transport->incoming.empty()) {
            return 0;
        }

        transport->incoming.emplace_back(reinterpret_cast<char*>(bp_buffer()), length);
        return 1;
    }

    EMSCRIPTEN_KEEPALIVE int bp_frame_send(unsigned int length) {
        if (!batched || length == 0 || length > bp_capacity() || !transport->outgoing.empty()) {
            return 0;
        }

        batched->sendPacket(
            std::string(reinterpret_cast<char*>(bp_buffer()), length),
            NetworkPeer::Reliability::ReliableOrdered,
            Compressibility::Compressible
        );
        batched->flush();
        return 1;
    }

    EMSCRIPTEN_KEEPALIVE const char* bp_frame_output() {
        if (!transport || transport->outgoing.empty()) {
            return bedrock_packs::set_output({});
        }

        auto data = std::move(transport->outgoing.front());
        transport->outgoing.pop_front();
        return bedrock_packs::set_output(std::move(data));
    }

    EMSCRIPTEN_KEEPALIVE const char* bp_frame_receive() {
        std::string data;

        if (batched) {
            batched->receivePacket(data);
        }

        return bedrock_packs::set_output(std::move(data));
    }
}
