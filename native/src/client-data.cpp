#include "bedrock_packs/output.h"
#include "bedrock_packs/query.h"

#include "Core/Json/Json.h"
#include "Protocol/ProtocolInfo.h"
#include "Network/Auth/AuthenticationUtils.h"
#include "Network/Client/ClientConnectionRequest.h"
#include "Network/Crypto/Base64.h"
#include "Network/ConnectionRequest.h"
#include "Network/NetherNet/NetherNetIdentity.h"

#include <emscripten/emscripten.h>
#include <ctime>
#include <stdexcept>
#include <cctype>
#include <vector>

EM_JS(int, browser_random, (unsigned char* pointer, int length), {
    crypto.getRandomValues(HEAPU8.subarray(pointer, pointer + length));
    return 1;
});

int RAND_bytes(unsigned char* pointer, int length) {
    return browser_random(pointer, length);
}

int64_t AuthenticationUtils::currentUnixTime() {
    return static_cast<int64_t>(std::time(nullptr));
}

std::string AuthenticationUtils::randomHex(size_t length) {
    const char* alphabet = "0123456789abcdef";
    std::vector<unsigned char> bytes(length);
    RAND_bytes(bytes.data(), static_cast<int>(bytes.size()));
    std::string result;

    for (const auto byte : bytes) {
        result += alphabet[byte >> 4];
        result += alphabet[byte & 15];
    }

    return result;
}

std::string AuthenticationUtils::generateUuid() {
    auto value = randomHex(16);
    value[12] = '4';
    value[16] = "89ab"[(value[16] - '0') & 3];
    return value.substr(0, 8) + "-" + value.substr(8, 4) + "-" +
        value.substr(12, 4) + "-" + value.substr(16, 4) + "-" + value.substr(20);
}

std::string Base64::encode(const std::string& bytes) {
    constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string result;

    for (size_t offset = 0; offset < bytes.size(); offset += 3) {
        const auto first = static_cast<unsigned char>(bytes[offset]);
        const auto second = offset + 1 < bytes.size() ? static_cast<unsigned char>(bytes[offset + 1]) : 0;
        const auto third = offset + 2 < bytes.size() ? static_cast<unsigned char>(bytes[offset + 2]) : 0;
        result += alphabet[first >> 2];
        result += alphabet[((first & 3) << 4) | (second >> 4)];
        result += offset + 1 < bytes.size() ? alphabet[((second & 15) << 2) | (third >> 6)] : '=';
        result += offset + 2 < bytes.size() ? alphabet[third & 63] : '=';
    }

    return result;
}

std::string nethernet::Identity::encodeBase64(const std::string& bytes) {
    return Base64::encode(bytes);
}

std::string ConnectionRequest::decodeBase64Url(const std::string& value) {
    const std::string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string result;
    unsigned int accumulator = 0;
    unsigned int bits = 0;

    for (auto character : value) {
        if (character == '=') {
            break;
        }

        if (character == '-') {
            character = '+';
        } else if (character == '_') {
            character = '/';
        }

        const auto index = alphabet.find(character);

        if (index == std::string::npos) {
            return {};
        }

        accumulator = (accumulator << 6) | static_cast<unsigned int>(index);
        bits += 6;

        if (bits >= 8) {
            bits -= 8;
            result += static_cast<char>((accumulator >> bits) & 255);
        }
    }

    return result;
}

extern "C" EMSCRIPTEN_KEEPALIVE const char* bp_client_data(unsigned int length) {
    if (length > bp_capacity()) {
        return bedrock_packs::set_output({});
    }

    const auto input = json::parse(std::string(reinterpret_cast<char*>(bp_buffer()), length));

    if (!input || !input->isObject()) {
        return bedrock_packs::set_output({});
    }

    const auto* address = input->get("address");
    const auto* name = input->get("name");
    const auto* version = input->get("version");
    const auto* playfab = input->get("playFabId");

    if (!address || !address->isString() || !name || !name->isString() ||
        !version || !version->isString() || !playfab || !playfab->isString()) {
        return bedrock_packs::set_output({});
    }

    const auto* profile = input->get("profile");
    if (!profile || !profile->isObject()) return bedrock_packs::set_output({});
    const auto text = [&](const char* key) {
        const auto* value = profile->get(key);
        return value && value->isString() ? value->string() : std::string();
    };
    const auto integer = [&](const char* key) {
        const auto* value = profile->get(key);
        if (!value || !value->isNumber()) return -1;
        const double number = value->number();
        if (number < 0 || number > 4 || number != static_cast<int>(number)) return -1;
        return static_cast<int>(number);
    };
    const auto is_uuid = [](const std::string& value) {
        if (value.size() != 36) return false;
        for (size_t i = 0; i < value.size(); ++i) {
            if (i == 8 || i == 13 || i == 18 || i == 23) { if (value[i] != '-') return false; }
            else if (!std::isxdigit(static_cast<unsigned char>(value[i]))) return false;
        }
        return true;
    };
    // DeviceOS 8 device IDs are 16 bytes written as 32 lowercase hex digits.
    const auto is_windows_device_id = [](const std::string& value) {
        return value.size() == 32 &&
            value.find_first_not_of("0123456789abcdef") == std::string::npos;
    };
    const auto online_id = text("platformOnlineId");
    if (online_id.empty() || online_id.size() > 20 || online_id.find_first_not_of("0123456789") != std::string::npos)
        return bedrock_packs::set_output({});
    const auto device_id = text("deviceId");
    const auto self_id = text("selfSignedId");
    const auto skin_id = text("skinId");
    const auto language = text("languageCode");
    const int current_input = integer("inputMode");
    const int memory = integer("memoryTier");
    // Validate the authentication context separately from the captured login profile.
    if (text("deviceType") != "Android" || !is_windows_device_id(device_id) || !is_uuid(self_id) ||
        !is_uuid(skin_id) || language.empty() || language.size() > 32 ||
        (current_input != 1 && current_input != 2) || memory < 0) return bedrock_packs::set_output({});
    const auto random_id = text("clientRandomId");
    int64_t client_id = 0;
    try {
        size_t used = 0;
        client_id = std::stoll(random_id, &used, 10);
        if (used != random_id.size() || client_id == 0 || std::to_string(client_id) != random_id)
            return bedrock_packs::set_output({});
    } catch (const std::exception&) { return bedrock_packs::set_output({}); }

    ClientData data;
    data.mPlayFabId.clear();
    data.mPlatformOnlineId.clear();
    data.mGameVersion = ProtocolInfo::MINECRAFT_VERSION_NETWORK;
    data.mDeviceId = device_id;
    data.mSelfSignedId = self_id;
    data.mClientRandomId = client_id;
    data.mSkinId = skin_id + ".Custom";
    data.mLanguageCode = "fr_FR";
    data.mCurrentInputMode = 1;
    data.mDefaultInputMode = 1;
    data.mDeviceOS = 8;
    data.mDeviceModel = "Unknown (Desktop)";
    data.mMemoryTier = 4;
    data.mGuiScale = -1;
    data.mCompatibleWithClientSideChunkGen = true;
    data.mClientIsEditorCapable = true;
    data.mClientEditorConnectionIntent = 2;
    data.mFilterProfanity = true;
    data.mMaxViewDistance = 77;
    data.mGraphicsMode = 0;
    data.mUIProfile = 0;
    data.mArmSize = "wide";
    data.mSkinColor = "#b37b62";
    // Own placeholder pixels, not a bundled Minecraft asset. Match the fallback
    // geometry's 64x64 texture instead of advertising a 64x32 image with that model.
    data.mSkinImageWidth = 64;
    data.mSkinImageHeight = 64;
    data.mSkinData = Base64::encode(std::string(64 * 64 * 4, '\xff'));
    data.mSkinGeometryVersion = Base64::encode(ProtocolInfo::MINECRAFT_VERSION_NETWORK);
    data.mTrustedSkin = true;
    data.mPremiumSkin = true;
    ClientConnectionRequest::applyClientDefaults(data, address->string(), name->string(), version->string());
    // Match the direct vanilla capture, where these optional IDs were empty or absent.
    data.mSelfSignedId.clear();
    data.mPlayFabId.clear();
    data.mPlatformOnlineId.clear();
    auto result = ClientConnectionRequest::toJson(data);
    // Falcon emits this optional party claim even when false. Omit it entirely
    // for the browser client, which does not implement parties.
    const std::string party_claim = ",\"IsPartyLeader\":false";
    const auto party_position = result.find(party_claim);
    if (party_position != std::string::npos) {
        result.erase(party_position, party_claim.size());
    }
    const std::string party_id = ",\"PartyId\":\"\"";
    const auto party_id_position = result.find(party_id);
    if (party_id_position != std::string::npos) {
        result.erase(party_id_position, party_id.size());
    }
    result.pop_back();
    result += ",\"ThirdPartyNameOnly\":false}";
    return bedrock_packs::set_output(std::move(result));
}
