#include "bedrock_packs/output.h"
#include "bedrock_packs/query.h"

#include "Protocol/PacketCodecContext.h"
#include "Protocol/Packets/RequestNetworkSettingsPacket.h"
#include "Protocol/Types/BlockDefinitionRegistry.h"
#include "Protocol/Types/ItemDefinitionRegistry.h"

#include <emscripten/emscripten.h>
#include <cstring>

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
