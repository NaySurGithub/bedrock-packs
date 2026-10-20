import type { AuthConfig } from './auth/types.js';

export interface QueryModule {
    HEAPU8: Uint8Array;
    bp_buffer(): number;
    bp_capacity(): number;
    bp_build_ping(timestamp: number, guidHigh: number, guidLow: number): number;
    bp_read_pong(length: number, expectedTimestamp: number): number;
    authConfig(): AuthConfig;
}

export interface ServerAnnouncement {
    transport: 'RakNet' | 'NetherNet';
    name: string;
    description: string;
    version: string;
    protocol: string;
    players: string;
    capacity: string;
    latency: number;
}

export async function loadQueryModule(): Promise<QueryModule> {
    const moduleUrl = new URL(`${import.meta.env.BASE_URL}wasm/bedrock-packs.mjs`, location.href);
    const generatedModule = await import(/* @vite-ignore */ moduleUrl.href);
    const native = await generatedModule.default();

    return {
        get HEAPU8() {
            return native.HEAPU8;
        },
        bp_buffer: native._bp_buffer,
        bp_capacity: native._bp_capacity,
        bp_build_ping: native._bp_build_ping,
        bp_read_pong: native._bp_read_pong,
        authConfig() {
            if (typeof native._bp_auth_config !== 'function') {
                throw new Error('Rebuild the WebAssembly client to enable Microsoft sign-in.');
            }

            const pointer = native._bp_auth_config();
            const length = native._bp_output_size();
            const json = new TextDecoder().decode(
                native.HEAPU8.subarray(pointer, pointer + length),
            );

            return JSON.parse(json) as AuthConfig;
        },
    };
}

export function queryServer(
    module: QueryModule,
    host: string,
    port: number,
    signal: AbortSignal,
): Promise<ServerAnnouncement> {
    return new Promise((resolve, reject) => {
        const relayUrl = import.meta.env.VITE_RELAY_URL;

        if (!relayUrl && !import.meta.env.DEV) {
            reject(new Error('Set VITE_RELAY_URL to the deployed WebSocket relay address.'));
            return;
        }

        const url = new URL(relayUrl || '/relay', location.href);

        if (!relayUrl) {
            url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        }

        if (
            !['ws:', 'wss:'].includes(url.protocol) ||
            (location.protocol === 'https:' && url.protocol !== 'wss:')
        ) {
            reject(new Error('The relay URL must use WSS on an HTTPS site.'));
            return;
        }
        url.searchParams.set('host', host);
        url.searchParams.set('port', String(port));

        const socket = new WebSocket(url);
        socket.binaryType = 'arraybuffer';

        const timestamp = Date.now() >>> 0;
        const detectionStarted = performance.now();
        let started = 0;
        let completed = false;

        const finish = (error?: Error, result?: ServerAnnouncement) => {
            if (completed) {
                return;
            }

            completed = true;
            clearTimeout(timeout);
            signal.removeEventListener('abort', abort);
            socket.close();

            if (error) {
                reject(error);
            } else if (result) {
                resolve(result);
            }
        };

        const abort = () => finish(new Error('Connection cancelled.'));
        const timeout = setTimeout(() => {
            finish(
                new Error('The server did not respond. Check its address, port, and relay policy.'),
            );
        }, 8000);

        signal.addEventListener('abort', abort, {
            once: true,
        });

        if (signal.aborted) {
            abort();
            return;
        }

        socket.onerror = () => finish(new Error('Could not connect to the relay.'));
        socket.onclose = () => finish(new Error('The relay closed the connection.'));
        socket.onmessage = (event: MessageEvent<unknown>) => {
            if (typeof event.data === 'string') {
                let control: unknown;

                try {
                    control = JSON.parse(event.data);
                } catch {
                    finish(new Error('Invalid relay response.'));
                    return;
                }

                if (
                    !control ||
                    typeof control !== 'object' ||
                    !('type' in control) ||
                    control.type !== 'ready' ||
                    !('version' in control) ||
                    control.version !== 1 ||
                    started !== 0
                ) {
                    finish(new Error('Unsupported relay response.'));
                    return;
                }

                if ('transport' in control && control.transport === 'nethernet') {
                    if (
                        !('status' in control) ||
                        !control.status ||
                        typeof control.status !== 'object'
                    ) {
                        finish(new Error('Invalid NetherNet status response.'));
                        return;
                    }

                    const endpoint = control.status as Record<string, unknown>;

                    finish(undefined, {
                        transport: 'NetherNet',
                        name: String(endpoint.name ?? ''),
                        description: String(endpoint.level ?? ''),
                        version: String(endpoint.version ?? ''),
                        protocol: String(endpoint.protocol ?? ''),
                        players: String(endpoint.players ?? 0),
                        capacity: String(endpoint.maxPlayers ?? 0),
                        latency: Math.round(performance.now() - detectionStarted),
                    });
                    return;
                }

                const guid = crypto.getRandomValues(new Uint32Array(2));
                const length = module.bp_build_ping(timestamp, guid[0]!, guid[1]!);
                const memory = module.HEAPU8;
                const pointer = module.bp_buffer();

                started = performance.now();
                socket.send(memory.slice(pointer, pointer + length));
                return;
            }

            if (!(event.data instanceof ArrayBuffer) || event.data.byteLength > 1492) {
                return;
            }

            const memory = module.HEAPU8;
            const pointer = module.bp_buffer();
            memory.set(new Uint8Array(event.data), pointer);

            const length = module.bp_read_pong(event.data.byteLength, timestamp);

            if (length < 0) {
                return;
            }

            const announcement = new TextDecoder().decode(
                memory.subarray(pointer + 35, pointer + 35 + length),
            );
            const fields = announcement.split(';');

            if (fields[0] !== 'MCPE' || fields.length < 6) {
                finish(new Error('The destination did not announce a Bedrock server.'));
                return;
            }

            finish(undefined, {
                transport: 'RakNet',
                name: fields[1] ?? '',
                description: fields[7] ?? '',
                version: fields[3] ?? '',
                protocol: fields[2] ?? '',
                players: fields[4] ?? '',
                capacity: fields[5] ?? '',
                latency: Math.round(performance.now() - started),
            });
        };
    });
}
