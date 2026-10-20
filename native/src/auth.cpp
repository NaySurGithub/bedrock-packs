#include "bedrock_packs/output.h"

#include "Network/Auth/XboxLiveConfig.h"
#include "Network/JsonText.h"
#include "Protocol/ProtocolInfo.h"

#include <emscripten/emscripten.h>

extern "C" EMSCRIPTEN_KEEPALIVE const char* bp_auth_config() {
    const auto config = XboxLiveConfig::android();

    return bedrock_packs::set_output(
        "{\"clientId\":" + JsonText::quote(config.mClientId) +
        ",\"deviceType\":" + JsonText::quote(config.mDeviceType) +
        ",\"deviceVersion\":" + JsonText::quote(config.mVersion) +
        ",\"userAgent\":" + JsonText::quote(config.mUserAgent) +
        ",\"gameVersion\":" + JsonText::quote(ProtocolInfo::MINECRAFT_VERSION_NETWORK) + "}"
    );
}
