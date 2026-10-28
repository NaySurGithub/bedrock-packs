#pragma once

#include <string>

namespace bedrock_packs {
    const char* set_output(std::string value);
    // Game version a vanilla client of the selected protocol announces in its login.
    std::string selected_game_version();
}

extern "C" {
    unsigned int bp_output_size();
    const char* bp_encode_signal(unsigned int length);
    const char* bp_decode_signal(unsigned int length);
    unsigned int bp_network_settings(int protocol_version);
}
