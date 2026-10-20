#pragma once

#include <stdint.h>

extern "C" {
    uint8_t* bp_buffer();
    uint32_t bp_capacity();
    uint32_t bp_build_ping(uint32_t timestamp, uint32_t guid_high, uint32_t guid_low);
    int32_t bp_read_pong(uint32_t length, uint32_t expected_timestamp);
}
