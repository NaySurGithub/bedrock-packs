#include "bedrock_packs/output.h"
#include "bedrock_packs/query.h"

#include "Core/Json/Json.h"
#include "Network/JsonText.h"
#include "Network/NetherNet/NetherNetSignal.h"
#include "Network/NetherNet/NetherNetDescription.h"

#include <emscripten/emscripten.h>
#include <limits>
#include <utility>

namespace {
    std::string output;

    bool valid_type(const std::string& type) {
        return type == nethernet::SIGNAL_TYPE_OFFER ||
            type == nethernet::SIGNAL_TYPE_ANSWER ||
            type == nethernet::SIGNAL_TYPE_CANDIDATE ||
            type == nethernet::SIGNAL_TYPE_ERROR;
    }

    bool read_connection_id(const std::string& value, uint64_t& result) {
        if (value.empty() || value.size() > 20) {
            return false;
        }

        result = 0;

        for (const char character : value) {
            if (character < '0' || character > '9') {
                return false;
            }

            const auto digit = static_cast<uint64_t>(character - '0');

            if (result > (std::numeric_limits<uint64_t>::max() - digit) / 10) {
                return false;
            }

            result = result * 10 + digit;
        }

        return true;
    }
}

extern "C" {
    EMSCRIPTEN_KEEPALIVE const char* bp_sdp_read(unsigned int length) {
        if (length == 0 || length > bp_capacity()) {
            return bedrock_packs::set_output({});
        }

        const std::string sdp(reinterpret_cast<char*>(bp_buffer()), length);
        const auto fingerprints = nethernet::Description::parseFingerprints(sdp);
        nethernet::IdentityData identity;
        std::string error;
        const auto present = nethernet::Description::parseIdentity(sdp, identity, error);

        return bedrock_packs::set_output(
            "{\"fingerprints\":" + JsonText::quote(nethernet::Description::generateFingerprintsPayload(fingerprints)) +
            ",\"hasFingerprints\":" + (fingerprints.empty() ? "false" : "true") +
            ",\"identity\":" + (present && identity.isValid() ? "true" : "false") +
            ",\"error\":" + JsonText::quote(error) +
            ",\"token\":" + JsonText::quote(identity.mAssertionToken) +
            ",\"signature\":" + JsonText::quote(identity.mAssertionFingerprints) + "}"
        );
    }

    EMSCRIPTEN_KEEPALIVE const char* bp_sdp_identity(unsigned int length) {
        if (length > bp_capacity()) {
            return bedrock_packs::set_output({});
        }

        const auto input = json::parse(std::string(reinterpret_cast<char*>(bp_buffer()), length));
        const auto* token = input ? input->get("token") : nullptr;
        const auto* signature = input ? input->get("signature") : nullptr;
        const auto* domain = input ? input->get("domain") : nullptr;

        if (!token || !token->isString() || !signature || !signature->isString() ||
            !domain || !domain->isString()) {
            return bedrock_packs::set_output({});
        }

        nethernet::IdentityData identity;
        identity.mAssertionToken = token->string();
        identity.mAssertionFingerprints = signature->string();
        identity.mIdpDomain = domain->string();
        identity.mIdpProtocol = "default";
        return bedrock_packs::set_output(nethernet::Description::encodeIdentity(identity));
    }
}

const char* bedrock_packs::set_output(std::string value) {
    output = std::move(value);
    return output.c_str();
}

EMSCRIPTEN_KEEPALIVE unsigned int bp_output_size() {
    return static_cast<unsigned int>(output.size());
}

EMSCRIPTEN_KEEPALIVE const char* bp_encode_signal(unsigned int length) {
    if (length > bp_capacity()) {
        return bedrock_packs::set_output({});
    }

    const auto input = json::parse(std::string(reinterpret_cast<char*>(bp_buffer()), length));

    if (!input || !input->isObject()) {
        return bedrock_packs::set_output({});
    }

    const auto* type = input->get("type");
    const auto* connection = input->get("connectionId");
    const auto* data = input->get("data");
    nethernet::Signal signal;

    if (!type || !type->isString() || !valid_type(type->string()) ||
        !connection || !connection->isString() ||
        !read_connection_id(connection->string(), signal.mConnectionID) ||
        !data || !data->isString()) {
        return bedrock_packs::set_output({});
    }

    signal.mType = type->string();
    signal.mData = data->string();

    return bedrock_packs::set_output(signal.toString());
}

EMSCRIPTEN_KEEPALIVE const char* bp_decode_signal(unsigned int length) {
    if (length > bp_capacity()) {
        return bedrock_packs::set_output({});
    }

    const std::string input(reinterpret_cast<char*>(bp_buffer()), length);
    nethernet::Signal signal;

    if (!signal.parse(input) || !valid_type(signal.mType)) {
        return bedrock_packs::set_output({});
    }

    uint64_t connection_id = 0;
    const auto first = input.find(' ');
    const auto second = input.find(' ', first + 1);

    if (!read_connection_id(input.substr(first + 1, second - first - 1), connection_id)) {
        return bedrock_packs::set_output({});
    }

    return bedrock_packs::set_output(
        "{\"type\":" + JsonText::quote(signal.mType) +
        ",\"connectionId\":" + JsonText::quote(std::to_string(connection_id)) +
        ",\"data\":" + JsonText::quote(signal.mData) + "}"
    );
}
