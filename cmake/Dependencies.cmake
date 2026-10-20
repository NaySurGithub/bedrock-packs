include(FetchContent)

set(FALCON_NBT_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(FALCON_PROTOCOL_BUILD_TESTS OFF CACHE BOOL "" FORCE)

FetchContent_Declare(
    falcon_nbt
    GIT_REPOSITORY https://github.com/Falcon-MC/NBT.git
    GIT_TAG 696734079ac095fcff87e4895e74790484693896
)

FetchContent_Declare(
    falcon_protocol
    GIT_REPOSITORY https://github.com/Falcon-MC/Protocol.git
    GIT_TAG 8990c4b68504516c293b7fd32ac8f0d056aca714
)

# The upstream target uses native sockets, OpenSSL and libdatachannel.
# Build its portable sources while browser platform adapters are developed.
FetchContent_Declare(
    falcon_network
    GIT_REPOSITORY https://github.com/Falcon-MC/Network.git
    GIT_TAG 37a1b2f75fcead296ac2ffec77d86c999e611f17
    SOURCE_SUBDIR cmake/bedrock-packs-browser
)

FetchContent_MakeAvailable(falcon_nbt falcon_protocol falcon_network)

add_library(FalconNetworkBrowser STATIC
    ${falcon_network_SOURCE_DIR}/src/RakNet/BitStream.cpp
    ${falcon_network_SOURCE_DIR}/src/Network/ServerQuery.cpp
    ${falcon_network_SOURCE_DIR}/src/Network/NetherNet/NetherNetSignal.cpp
    ${falcon_network_SOURCE_DIR}/src/Network/NetherNet/NetherNetCredentials.cpp
)

target_include_directories(FalconNetworkBrowser PUBLIC
    ${falcon_network_SOURCE_DIR}/include
)

target_link_libraries(FalconNetworkBrowser PUBLIC FalconProtocol)
