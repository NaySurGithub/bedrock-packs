set(browser_network_dir ${CMAKE_CURRENT_BINARY_DIR}/browser-network)
file(MAKE_DIRECTORY ${browser_network_dir}/RakNet)

# Keep the pinned reliability implementation; replace its thread with explicit ticks.
file(READ ${falcon_network_SOURCE_DIR}/include/RakNet/RakPeer.h peer_header)
string(REPLACE "    private:" "        void browserTick() { UpdateNetworkLoop(); }\n\n    private:" peer_header "${peer_header}")
file(WRITE ${browser_network_dir}/RakNet/RakPeer.h "${peer_header}")

file(READ ${falcon_network_SOURCE_DIR}/src/RakNet/RakPeer.cpp peer_source)
string(FIND "${peer_source}" "    static std::vector<SystemAddress> LocalAddresses(" local_start)
string(FIND "${peer_source}" "    static const int CONNECTION_MTU_SIZES" local_end)
string(SUBSTRING "${peer_source}" 0 ${local_start} peer_prefix)
string(SUBSTRING "${peer_source}" ${local_end} -1 peer_suffix)
set(peer_source "${peer_prefix}    static std::vector<SystemAddress> LocalAddresses(const SystemAddress&) { return {}; }\n\n${peer_suffix}")
string(REPLACE "#include <ifaddrs.h>" "" peer_source "${peer_source}")
string(REPLACE "#include <net/if.h>" "" peer_source "${peer_source}")
string(REPLACE "        networkThread = std::thread(&RakPeer::UpdateNetworkLoop, this);" "" peer_source "${peer_source}")
string(REPLACE "        while (!endThreads) {" "        if (!endThreads) {" peer_source "${peer_source}")
string(REPLACE "        if (networkThread.joinable())\n            networkThread.join();" "" peer_source "${peer_source}")
file(WRITE ${browser_network_dir}/RakPeer.cpp "${peer_source}")

target_sources(FalconNetworkBrowser PRIVATE
    ${browser_network_dir}/RakPeer.cpp
    ${falcon_network_SOURCE_DIR}/src/RakNet/GetTime.cpp
    ${falcon_network_SOURCE_DIR}/src/RakNet/RakNetTypes.cpp
    ${falcon_network_SOURCE_DIR}/src/RakNet/ReliabilityLayer.cpp
    ${CMAKE_SOURCE_DIR}/native/src/socket.cpp
)

target_include_directories(FalconNetworkBrowser BEFORE PUBLIC ${browser_network_dir})
target_include_directories(FalconNetworkBrowser PRIVATE ${CMAKE_SOURCE_DIR}/native/include)

file(READ ${falcon_network_SOURCE_DIR}/src/Network/Client/ClientConnectionRequest.cpp client_source)
string(REPLACE "#include <openssl/rand.h>" "extern int RAND_bytes(unsigned char*, int);" client_source "${client_source}")
string(FIND "${client_source}" "bool ClientConnectionRequest::createOnline(" client_login_offset)
string(SUBSTRING "${client_source}" 0 ${client_login_offset} client_source)
file(WRITE ${browser_network_dir}/ClientData.cpp "${client_source}")
target_sources(FalconNetworkBrowser PRIVATE ${browser_network_dir}/ClientData.cpp)
