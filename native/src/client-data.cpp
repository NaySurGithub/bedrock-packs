#include "bedrock_packs/output.h"
#include "bedrock_packs/query.h"

#include "Core/Json/Json.h"
#include "Network/Auth/AuthenticationUtils.h"
#include "Network/Client/ClientConnectionRequest.h"
#include "Network/Crypto/Base64.h"
#include "Network/ConnectionRequest.h"
#include "Network/NetherNet/NetherNetIdentity.h"

#include <emscripten/emscripten.h>
#include <ctime>
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

    ClientData data;
    data.mPlayFabId = playfab->string();
    ClientConnectionRequest::applyClientDefaults(data, address->string(), name->string(), version->string());
    return bedrock_packs::set_output(ClientConnectionRequest::toJson(data));
}
