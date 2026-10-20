import type { BrowserCodec } from './codec.js';

export interface BedrockTransport {
    readonly raknet: boolean;
    send(data: Uint8Array<ArrayBuffer>): void;
    receive(): Promise<Uint8Array<ArrayBuffer>>;
    close(): void;
}

export class PacketQueue {
    #packets: Uint8Array<ArrayBuffer>[] = [];
    #bytes = 0;
    #error: Error | undefined;
    #waiting:
        | {
              resolve(value: Uint8Array<ArrayBuffer>): void;
              reject(error: Error): void;
          }
        | undefined;

    push(packet: Uint8Array<ArrayBuffer>): void {
        if (this.#error) {
            return;
        }

        if (this.#waiting) {
            this.#waiting.resolve(packet);
            this.#waiting = undefined;
            return;
        }

        if (this.#bytes + packet.length > 8 * 1024 * 1024 || this.#packets.length >= 256) {
            this.fail(new Error('The incoming packet queue is full.'));
            return;
        }

        this.#bytes += packet.length;
        this.#packets.push(packet);
    }

    receive(): Promise<Uint8Array<ArrayBuffer>> {
        if (this.#error) {
            return Promise.reject(this.#error);
        }

        const packet = this.#packets.shift();

        if (packet) {
            this.#bytes -= packet.length;
            return Promise.resolve(packet);
        }

        if (this.#waiting) {
            return Promise.reject(new Error('Concurrent packet reads are not supported.'));
        }

        return new Promise((resolve, reject) => {
            this.#waiting = { resolve, reject };
        });
    }

    fail(error: Error): void {
        this.#error ??= error;
        this.#packets = [];
        this.#bytes = 0;
        this.#waiting?.reject(this.#error);
        this.#waiting = undefined;
    }
}

export function relayUrl(path: '/relay' | '/signal', host: string, port: number): URL {
    const configured = import.meta.env.VITE_RELAY_URL;

    if (!configured && !import.meta.env.DEV) {
        throw new Error('Configure VITE_RELAY_URL before connecting.');
    }

    const url = configured
        ? new URL(path === '/relay' ? configured : '/signal', configured)
        : new URL(path, location.href);
    url.protocol =
        path === '/relay'
            ? ['https:', 'wss:'].includes(url.protocol)
                ? 'wss:'
                : 'ws:'
            : ['https:', 'wss:'].includes(url.protocol)
              ? 'https:'
              : 'http:';

    if (location.protocol === 'https:' && !['https:', 'wss:'].includes(url.protocol)) {
        throw new Error('The relay must use a secure connection.');
    }

    url.searchParams.set('host', host);
    url.searchParams.set('port', String(port));
    return url;
}

export function raknetDisconnectMessage(id: number): string | undefined {
    const messages: Record<number, string> = {
        0x0a: 'RakNet: the server requires a public key.',
        0x0b: 'RakNet: the server requires a secure connection.',
        0x0c: 'RakNet: the server public key does not match.',
        0x11: 'RakNet: the connection attempt failed.',
        0x12: 'RakNet: this client is already connected.',
        0x14: 'RakNet: the server is full.',
        0x15: 'RakNet: the server closed the connection.',
        0x16: 'RakNet: the connection to the server was lost.',
        0x17: 'RakNet: the server has banned this connection.',
        0x18: 'RakNet: the server rejected the password.',
        0x19: 'RakNet: the server uses an incompatible protocol version.',
        0x1a: 'RakNet: this IP connected too recently. Try again shortly.',
    };
    return messages[id];
}

export async function connectRakNet(
    codec: BrowserCodec,
    host: string,
    port: number,
    signal: AbortSignal,
): Promise<BedrockTransport> {
    signal.throwIfAborted();
    const queue = new PacketQueue();
    const socket = new WebSocket(relayUrl('/relay', host, port));
    socket.binaryType = 'arraybuffer';
    let timer: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    let started = false;
    let accepted = false;
    let resolveConnected: (() => void) | undefined;
    let rejectConnected: ((error: Error) => void) | undefined;

    const close = (error = new Error('Connection closed.')) => {
        if (closed) {
            return;
        }

        closed = true;
        clearInterval(timer);
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        socket.close();
        codec.native._bp_raknet_close();
        queue.fail(error);
        rejectConnected?.(error);
    };
    const abort = () => close(new Error('Connection cancelled.'));
    const timeout = setTimeout(() => close(new Error('The RakNet handshake timed out.')), 15000);

    const flush = () => {
        for (;;) {
            const data = codec.output(codec.native._bp_raknet_output());

            if (data.length === 0) {
                return;
            }

            if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 256 * 1024) {
                throw new Error('The relay cannot keep up with the connection.');
            }

            socket.send(data);
        }
    };

    const tick = () => {
        try {
            codec.native._bp_raknet_tick();
            flush();

            for (;;) {
                const packet = codec.output(codec.native._bp_raknet_receive());

                if (packet.length === 0) {
                    break;
                }

                if (packet[0] === 0x10) {
                    accepted = true;
                    clearTimeout(timeout);
                    resolveConnected?.();
                } else if (packet[0] === 0xfe && accepted) {
                    queue.push(packet);
                } else {
                    const reason = raknetDisconnectMessage(packet[0]!);
                    if (reason) throw new Error(reason);
                }
            }
        } catch (error) {
            close(error instanceof Error ? error : new Error('RakNet failed.'));
        }
    };

    signal.addEventListener('abort', abort, { once: true });
    socket.onerror = () => close(new Error('Could not connect to the relay.'));
    socket.onclose = (event) =>
        close(
            new Error(
                event.reason
                    ? `RakNet relay: ${event.reason} (code ${event.code}).`
                    : `The RakNet relay closed the connection (code ${event.code}).`,
            ),
        );
    socket.onmessage = (event: MessageEvent<unknown>) => {
        try {
            if (typeof event.data === 'string' && !started) {
                const control = JSON.parse(event.data) as Record<string, unknown>;

                if (
                    control.type !== 'ready' ||
                    control.version !== 1 ||
                    control.transport !== 'raknet'
                ) {
                    throw new Error('Unexpected relay transport.');
                }

                if (!codec.native._bp_raknet_start(port)) {
                    throw new Error('The Falcon RakNet client could not start.');
                }

                started = true;
                timer = setInterval(tick, 5);
                tick();
            } else if (event.data instanceof ArrayBuffer && started) {
                if (!codec.native._bp_raknet_input(codec.input(new Uint8Array(event.data)))) {
                    throw new Error('Invalid relay datagram or full input queue.');
                }

                tick();
            } else {
                throw new Error('Invalid relay message.');
            }
        } catch (error) {
            close(error instanceof Error ? error : new Error('Invalid relay message.'));
        }
    };

    await new Promise<void>((resolve, reject) => {
        resolveConnected = resolve;
        rejectConnected = reject;
    });
    rejectConnected = undefined;

    return {
        raknet: true,
        send(data) {
            if (closed || !codec.native._bp_raknet_send(codec.input(data))) {
                throw new Error('The RakNet connection is unavailable.');
            }

            tick();
        },
        receive: () => queue.receive(),
        close: () => close(),
    };
}
