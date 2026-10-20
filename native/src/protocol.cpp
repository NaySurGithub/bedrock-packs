#include "bedrock_packs/output.h"
#include "bedrock_packs/query.h"

#include "Protocol/PacketCodecContext.h"
#include "Protocol/Codec/ProtocolCodecRegistry.h"
#include "Protocol/Packets/RequestNetworkSettingsPacket.h"
#include "Protocol/Packets/LoginPacket.h"
#include "Protocol/Packets/NetworkSettingsPacket.h"
#include "Protocol/Packets/PlayStatusPacket.h"
#include "Protocol/Packets/DisconnectPacket.h"
#include "Protocol/Packets/TransferPacket.h"
#include "Protocol/Packets/ServerToClientHandshakePacket.h"
#include "Protocol/Packets/ClientToServerHandshakePacket.h"
#include "Protocol/Packets/ClientCacheStatusPacket.h"
#include "Protocol/Packets/ResourcePacksInfoPacket.h"
#include "Protocol/Packets/ResourcePackDataInfoPacket.h"
#include "Protocol/Packets/ResourcePackChunkDataPacket.h"
#include "Protocol/Packets/ResourcePackStackPacket.h"
#include "Protocol/Packets/ResourcePackClientResponsePacket.h"
#include "Protocol/Packets/ResourcePackChunkRequestPacket.h"
#include "Network/JsonText.h"
#include "Core/Json/Json.h"
#include "Protocol/Types/BlockDefinitionRegistry.h"
#include "Protocol/Types/ItemDefinitionRegistry.h"

#include <emscripten/emscripten.h>
#include <cstring>
#include <exception>
#include <optional>
#include <stdexcept>

namespace {
    std::string pack_chunk;

    std::string hex(const std::string& bytes) {
        std::string result;
        for (unsigned char byte : bytes) {
            result += "0123456789abcdef"[byte >> 4];
            result += "0123456789abcdef"[byte & 15];
        }
        return result;
    }

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

    EMSCRIPTEN_KEEPALIVE const char* bp_pack_response(unsigned int length) {
        try {
            if (length > bp_capacity()) return bedrock_packs::set_output({});
            const auto root = json::parse(std::string(reinterpret_cast<char*>(bp_buffer()), length));
            const auto* status = root ? root->get("status") : nullptr;
            const auto* packs = root ? root->get("packs") : nullptr;
            if (!status || !packs || !packs->isArray() || packs->mArray.size() > 128 ||
                status->integer() < 1 || status->integer() > 4) return bedrock_packs::set_output({});
            ResourcePackClientResponsePacket packet;
            packet.mStatus = static_cast<ResourcePackClientResponsePacket::Status>(status->integer());
            for (const auto& entry : packs->mArray) {
                if (!entry->isString() || entry->string().size() > 256) return bedrock_packs::set_output({});
                packet.mPackIds.push_back(entry->string());
            }
            return encode(packet);
        } catch (const std::exception&) { return bedrock_packs::set_output({}); }
    }

    EMSCRIPTEN_KEEPALIVE const char* bp_pack_request(unsigned int length) {
        try {
            if (length > bp_capacity()) return bedrock_packs::set_output({});
            const auto root = json::parse(std::string(reinterpret_cast<char*>(bp_buffer()), length));
            const auto* id = root ? root->get("id") : nullptr;
            const auto* version = root ? root->get("version") : nullptr;
            const auto* index = root ? root->get("index") : nullptr;
            if (!id || !version || !index || !id->isString() || !version->isString() ||
                id->string().size() != 36 || version->string().size() > 128 || index->integer(-1) < 0)
                return bedrock_packs::set_output({});
            ResourcePackChunkRequestPacket packet;
            packet.mPackId = Uuid::fromString(id->string());
            packet.mPackVersion = version->string();
            packet.mChunkIndex = index->integer();
            return encode(packet);
        } catch (const std::exception&) { return bedrock_packs::set_output({}); }
    }

    EMSCRIPTEN_KEEPALIVE const char* bp_pack_chunk() {
        return bedrock_packs::set_output(std::move(pack_chunk));
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

            if (id == ResourcePacksInfoPacket::ID) {
                ResourcePacksInfoPacket packet;
                packet.readHeader(stream);
                codec->getCodec().read(packet, stream, *codec);
                if (packet.mResourcePackInfos.size() > 128) throw std::runtime_error("Too many packs");
                std::string result = "{\"type\":\"packs-info\",\"packs\":[";
                bool first = true;
                for (const auto& pack : packet.mResourcePackInfos) {
                    if (!first) result += ',';
                    first = false;
                    result += "{\"id\":" + JsonText::quote(pack.mPackId.toString()) +
                        ",\"version\":" + JsonText::quote(pack.mPackVersion) +
                        ",\"size\":" + std::to_string(pack.mPackSize) +
                        ",\"key\":" + JsonText::quote(pack.mContentKey) +
                        ",\"cdnUrl\":" + JsonText::quote(pack.mCdnUrl) + "}";
                }
                return bedrock_packs::set_output(result + "]}");
            }

            if (id == ResourcePackDataInfoPacket::ID) {
                ResourcePackDataInfoPacket packet;
                packet.readHeader(stream);
                codec->getCodec().read(packet, stream, *codec);
                return bedrock_packs::set_output(
                    "{\"type\":\"pack-data\",\"id\":" + JsonText::quote(packet.mPackId.toString()) +
                    ",\"version\":" + JsonText::quote(packet.mPackVersion) +
                    ",\"chunkSize\":" + std::to_string(packet.mMaxChunkSize) +
                    ",\"chunkCount\":" + std::to_string(packet.mChunkCount) +
                    ",\"size\":" + std::to_string(packet.mCompressedPackSize) +
                    ",\"hash\":" + JsonText::quote(hex(packet.mHash)) + "}"
                );
            }

            if (id == ResourcePackChunkDataPacket::ID) {
                ResourcePackChunkDataPacket packet;
                packet.readHeader(stream);
                codec->getCodec().read(packet, stream, *codec);
                pack_chunk = std::move(packet.mData);
                return bedrock_packs::set_output(
                    "{\"type\":\"pack-chunk\",\"id\":" + JsonText::quote(packet.mPackId.toString()) +
                    ",\"version\":" + JsonText::quote(packet.mPackVersion) +
                    ",\"index\":" + std::to_string(packet.mChunkIndex) +
                    ",\"progress\":" + std::to_string(packet.mProgress) + "}"
                );
            }

            if (id == ResourcePackStackPacket::ID) {
                ResourcePackStackPacket packet;
                packet.readHeader(stream);
                codec->getCodec().read(packet, stream, *codec);
                return bedrock_packs::set_output("{\"type\":\"packs-stack\"}");
            }

            if (id == TransferPacket::ID) {
                TransferPacket packet;
                packet.readHeader(stream);
                codec->getCodec().read(packet, stream, *codec);
                return bedrock_packs::set_output(
                    "{\"type\":\"transfer\",\"host\":" + JsonText::quote(packet.mAddress) +
                    ",\"port\":" + std::to_string(packet.mPort) +
                    ",\"reloadWorld\":" + (packet.mReloadWorld ? "true" : "false") + "}"
                );
            }

            if (id == DisconnectPacket::ID) {
                DisconnectPacket packet;
                packet.readHeader(stream);
                codec->getCodec().read(packet, stream, *codec);
                return bedrock_packs::set_output("{\"type\":\"disconnect\",\"message\":" + JsonText::quote(packet.mKickMessage.empty() ? packet.mFilteredMessage : packet.mKickMessage) +
                    ",\"reason\":" + std::to_string(packet.mReason) + "}");
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
