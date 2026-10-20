#include "bedrock_packs/output.h"
#include "bedrock_packs/query.h"

#include "Protocol/PacketCodecContext.h"
#include "Protocol/Codec/ProtocolCodecRegistry.h"
#include "Protocol/Packets/RequestNetworkSettingsPacket.h"
#include "Protocol/Packets/LoginPacket.h"
#include "Protocol/Packets/NetworkSettingsPacket.h"
#include "Protocol/Packets/PlayStatusPacket.h"
#include "Protocol/Packets/DisconnectPacket.h"
#include "Protocol/Packets/ServerToClientHandshakePacket.h"
#include "Protocol/Packets/ClientToServerHandshakePacket.h"
#include "Protocol/Packets/ClientCacheStatusPacket.h"
#include "Network/JsonText.h"
#include "Core/Json/Json.h"
#include "Protocol/Types/BlockDefinitionRegistry.h"
#include "Protocol/Types/ItemDefinitionRegistry.h"

#include <emscripten/emscripten.h>
#include <cstring>
#include <exception>
#include <optional>

namespace {
    const BlockDefinitionRegistry blocks;
    const ItemDefinitionRegistry items;
    std::optional<PacketCodecContext> codec(std::in_place, blocks, items);

    const char* encode(const Packet& packet) {
        BinaryStream stream;
        packet.writeWithHeader(stream, *codec);
        return bedrock_packs::set_output(stream.getBuffer());
    }
}

extern "C" {
    EMSCRIPTEN_KEEPALIVE int bp_protocol_select(int protocol) {
        const auto selected = ProtocolCodecRegistry::instance().find(protocol);

        if (!selected) {
            return 0;
        }

        codec.emplace(blocks, items, selected);
        return 1;
    }

    EMSCRIPTEN_KEEPALIVE const char* bp_login(unsigned int length, int protocol) {
        if (length > bp_capacity()) {
            return bedrock_packs::set_output({});
        }

        const auto root = json::parse(std::string(reinterpret_cast<char*>(bp_buffer()), length));
        const auto* auth = root ? root->get("auth") : nullptr;
        const auto* client = root ? root->get("client") : nullptr;

        if (!auth || !auth->isString() || !client || !client->isString()) {
            return bedrock_packs::set_output({});
        }

        LoginPacket packet;
        packet.mProtocolVersion = protocol;
        packet.mAuthJwt = auth->string();
        packet.mClientJwt = client->string();
        return encode(packet);
    }

    EMSCRIPTEN_KEEPALIVE const char* bp_client_handshake() {
        return encode(ClientToServerHandshakePacket{});
    }

    EMSCRIPTEN_KEEPALIVE const char* bp_cache_status() {
        ClientCacheStatusPacket packet;
        packet.mSupported = false;
        return encode(packet);
    }

    EMSCRIPTEN_KEEPALIVE const char* bp_packet_read(unsigned int length) {
        if (length == 0 || length > bp_capacity()) {
            return bedrock_packs::set_output("{\"type\":\"invalid\"}");
        }

        try {
            ReadOnlyBinaryStream stream(std::string(reinterpret_cast<char*>(bp_buffer()), length));
            unsigned char sender = 0;
            unsigned char client = 0;
            const auto id = Packet::peekId(stream, sender, client);
            stream.rewind();

            if (id == NetworkSettingsPacket::ID) {
                NetworkSettingsPacket packet;
                packet.readHeader(stream);
                codec->getCodec().read(packet, stream, *codec);
                const auto algorithm = static_cast<int>(packet.mCompressionAlgorithm);
                return bedrock_packs::set_output(
                    "{\"type\":\"settings\",\"algorithm\":" + std::to_string(algorithm == 2 ? 255 : algorithm) +
                    ",\"threshold\":" + std::to_string(packet.mCompressionThreshold) + "}"
                );
            }

            if (id == ServerToClientHandshakePacket::ID) {
                ServerToClientHandshakePacket packet;
                packet.readHeader(stream);
                codec->getCodec().read(packet, stream, *codec);
                return bedrock_packs::set_output("{\"type\":\"handshake\",\"token\":" + JsonText::quote(packet.mJwt) + "}");
            }

            if (id == PlayStatusPacket::ID) {
                PlayStatusPacket packet;
                packet.readHeader(stream);
                codec->getCodec().read(packet, stream, *codec);
                return bedrock_packs::set_output("{\"type\":\"status\",\"status\":" + std::to_string(static_cast<int>(packet.mStatus)) + "}");
            }

            if (id == DisconnectPacket::ID) {
                DisconnectPacket packet;
                packet.readHeader(stream);
                codec->getCodec().read(packet, stream, *codec);
                return bedrock_packs::set_output("{\"type\":\"disconnect\",\"message\":" + JsonText::quote(packet.mKickMessage) + "}");
            }

            return bedrock_packs::set_output("{\"type\":\"packet\",\"id\":" + std::to_string(static_cast<int>(id)) + "}");
        } catch (const std::exception&) {
            return bedrock_packs::set_output("{\"type\":\"invalid\"}");
        }
    }
}

EMSCRIPTEN_KEEPALIVE unsigned int bp_network_settings(int protocol_version) {
    const BlockDefinitionRegistry block_definitions;
    const ItemDefinitionRegistry item_definitions;
    const PacketCodecContext context(block_definitions, item_definitions);

    RequestNetworkSettingsPacket packet;
    packet.mProtocolVersion = protocol_version;

    BinaryStream stream;
    packet.writeWithHeader(stream, context);

    if (stream.size() > bp_capacity()) {
        return 0;
    }

    std::memcpy(bp_buffer(), stream.getBuffer().data(), stream.size());

    return static_cast<unsigned int>(stream.size());
}
