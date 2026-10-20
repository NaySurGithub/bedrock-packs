#pragma once

#include <cstddef>
#include <deque>
#include <functional>
#include <optional>
#include <string>
#include <utility>
#include <vector>

// Platform boundary only. Browser RTCPeerConnection owns ICE, DTLS and SCTP.
namespace rtc {
    using binary = std::vector<std::byte>;
    using string = std::string;

    struct Reliability {
        bool unordered = false;
        std::optional<unsigned int> maxRetransmits;
        std::optional<unsigned int> maxPacketLifeTime;
    };

    class PeerConnection {
    public:
        void close() {}
    };

    class DataChannel {
    public:
        DataChannel(std::string label, Reliability reliability)
            : name(std::move(label)), options(reliability) {}

        std::string label() const { return name; }
        Reliability reliability() const { return options; }
        bool isOpen() const { return open; }

        void onOpen(std::function<void()> callback) { opened = std::move(callback); }
        void onClosed(std::function<void()> callback) { closed = std::move(callback); }

        void onMessage(std::function<void(binary)> bytes, std::function<void(string)> text) {
            received = std::move(bytes);
            received_text = std::move(text);
        }

        bool send(const std::byte* bytes, size_t length) {
            if (!open || queued + length > 4 * 1024 * 1024) {
                return false;
            }

            outgoing.emplace_back(reinterpret_cast<const char*>(bytes), length);
            queued += length;
            return true;
        }

        void close() {
            if (open) {
                open = false;

                if (closed) {
                    closed();
                }
            }
        }

        void input(const std::byte* bytes, size_t length) {
            if (open && received) {
                received(binary(bytes, bytes + length));
            }
        }

        std::string take() {
            if (outgoing.empty()) {
                return {};
            }

            auto data = std::move(outgoing.front());
            outgoing.pop_front();
            queued -= data.size();
            return data;
        }

    private:
        std::string name;
        Reliability options;
        bool open = true;
        size_t queued = 0;
        std::deque<std::string> outgoing;
        std::function<void()> opened;
        std::function<void()> closed;
        std::function<void(binary)> received;
        std::function<void(string)> received_text;
    };
}
