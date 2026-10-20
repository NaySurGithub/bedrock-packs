add_executable(bedrock-packs
    src/query.cpp
    src/nethernet.cpp
    src/protocol.cpp
)

target_include_directories(bedrock-packs PRIVATE include)
target_link_libraries(bedrock-packs PRIVATE FalconNetworkBrowser FalconProtocol)

target_compile_options(bedrock-packs PRIVATE -Wall -Wextra -Werror)

target_link_options(bedrock-packs PRIVATE
    --no-entry
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    -sENVIRONMENT=web,node
    -sALLOW_MEMORY_GROWTH=1
    -sEXPORTED_RUNTIME_METHODS=HEAPU8
    -sFILESYSTEM=0
    -sASSERTIONS=1
)

set_target_properties(bedrock-packs PROPERTIES
    SUFFIX .mjs
    RUNTIME_OUTPUT_DIRECTORY ${CMAKE_SOURCE_DIR}/apps/web/public/wasm
)
