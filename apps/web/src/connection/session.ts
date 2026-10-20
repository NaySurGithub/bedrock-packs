import type { AccountClient } from '../auth/client.js';
import type { QueryModule, ServerAnnouncement } from '../query.js';
import { queryServer } from '../query.js';
import { BrowserCodec } from './codec.js';
import { GameCipher, signToken, tokenParts } from './crypto.js';
import type { ConnectionIdentity } from './crypto.js';
import { connectNetherNet } from './nethernet.js';
import { connectRakNet } from './transport.js';
import type { BedrockTransport } from './transport.js';

export interface BedrockSession {
    server: ServerAnnouncement;
    close(): void;
}

export interface ConnectionState {
    phase:
        'authenticating' | 'detecting' | 'connecting' | 'logging-in' | 'connected' | 'disconnected';
    message: string;
}

let inUse = false;

async function loginIdentity(identity: ConnectionIdentity, version: string): Promise<string> {
    const first = identity.identity.chain[0];

    if (!first) {
        throw new Error('The Microsoft session has no Minecraft identity chain.');
    }

    const rootKey = tokenParts(first).header.x5u;

    if (typeof rootKey !== 'string') {
        throw new Error('The Minecraft identity chain has no root key.');
    }

    const now = Math.floor(Date.now() / 1000);
    const root = await signToken(
        identity,
        JSON.stringify({
            exp: now + 21600,
            nbf: now - 21600,
            identityPublicKey: rootKey,
            certificateAuthority: true,
        }),
    );
    const [major, minor, patch] = version.split('.').map(Number);
    const tokenOnly =
        major! > 1 || (major === 1 && (minor! > 26 || (minor === 26 && patch! >= 30)));
    const certificate = JSON.stringify({ chain: [root, ...identity.identity.chain] });

    return JSON.stringify({
        ...(!tokenOnly ? { Certificate: certificate } : {}),
        AuthenticationType: 0,
        Token: identity.identity.multiplayerToken,
    });
}

export async function connectBedrock(
    module: QueryModule,
    account: AccountClient,
    host: string,
    port: number,
    signal: AbortSignal,
    changed: (state: ConnectionState) => void,
): Promise<BedrockSession> {
    if (inUse) {
        throw new Error('Disconnect the current server before connecting again.');
    }

    signal.throwIfAborted();
    const codec = new BrowserCodec(module.connection);
    inUse = true;
    let transport: BedrockTransport | undefined;
    let cipher: GameCipher | undefined;
    let closed = false;
    let connected = false;
    let rejectLogin: ((error: Error) => void) | undefined;
    const controller = new AbortController();

    const close = (error = new Error('Disconnected.')) => {
        if (closed) {
            return;
        }

        closed = true;
        clearTimeout(deadline);
        signal.removeEventListener('abort', abort);
        unsubscribe();
        controller.abort();
        transport?.close();
        cipher?.dispose();
        inUse = false;
        rejectLogin?.(error);

        if (connected) {
            changed({ phase: 'disconnected', message: error.message });
        }
    };
    const abort = () => close(new Error('Connection cancelled.'));
    const deadline = setTimeout(() => close(new Error('The Bedrock login timed out.')), 60000);
    const unsubscribe = account.subscribe((state) => {
        if (state.status === 'signed-out' || state.status === 'error') {
            queueMicrotask(() => close(new Error('The Microsoft session is no longer available.')));
        }
    });
    signal.addEventListener('abort', abort, { once: true });

    try {
        changed({ phase: 'authenticating', message: 'Preparing Microsoft identity…' });
        const identity = await account.connectionIdentity();
        controller.signal.throwIfAborted();
        changed({ phase: 'detecting', message: 'Detecting server transport…' });
        const server = await queryServer(module, host, port, controller.signal);
        const protocol = Number(server.protocol);

        if (!Number.isInteger(protocol) || !codec.native._bp_protocol_select(protocol)) {
            throw new Error(
                `Server protocol ${server.protocol} is not supported by this Falcon build.`,
            );
        }

        controller.signal.throwIfAborted();
        changed({ phase: 'connecting', message: `Connecting with ${server.transport}…` });
        transport =
            server.transport === 'NetherNet'
                ? await connectNetherNet(codec, identity, host, port, controller.signal)
                : await connectRakNet(codec, host, port, controller.signal);
        controller.signal.throwIfAborted();
        codec.start(transport.raknet);
        const address = `${host.includes(':') ? `[${host}]` : host}:${port}`;
        const data = codec.clientData(
            address,
            identity.gamertag,
            server.version,
            identity.identity.playFabId,
        );
        const clientJwt = await signToken(identity, data);
        const auth = await loginIdentity(identity, server.version);
        controller.signal.throwIfAborted();

        const send = async (packet: Uint8Array) => {
            for (const batch of codec.send(packet)) {
                const data = cipher && transport!.raknet ? await cipher.encrypt(batch) : batch;
                controller.signal.throwIfAborted();
                transport!.send(data);
            }
        };

        let sentLogin = false;
        let handshake = false;
        const authenticated = new Promise<void>((resolve, reject) => {
            rejectLogin = reject;

            const run = async () => {
                await send(codec.settings(protocol));

                while (!closed) {
                    const incoming = await transport!.receive();
                    const batch =
                        cipher && transport!.raknet ? await cipher.decrypt(incoming) : incoming;
                    controller.signal.throwIfAborted();

                    for (const packet of codec.receive(batch)) {
                        const event = codec.read(packet);

                        switch (event.type) {
                            case 'settings':
                                if (
                                    sentLogin ||
                                    !codec.native._bp_compression(event.algorithm, event.threshold)
                                ) {
                                    throw new Error('Invalid or repeated network settings.');
                                }

                                sentLogin = true;
                                changed({
                                    phase: 'logging-in',
                                    message: 'Signing in to the Bedrock server…',
                                });
                                await send(codec.login(protocol, auth, clientJwt));
                                break;
                            case 'handshake':
                                if (!sentLogin || handshake) {
                                    throw new Error('Unexpected server encryption handshake.');
                                }

                                handshake = true;
                                cipher = await GameCipher.fromHandshake(identity, event.token);
                                await send(codec.output(codec.native._bp_client_handshake()));
                                break;
                            case 'status':
                                if (event.status === 0 && sentLogin && !connected) {
                                    await send(codec.output(codec.native._bp_cache_status()));
                                    connected = true;
                                    clearTimeout(deadline);
                                    changed({
                                        phase: 'connected',
                                        message: `Connected as ${identity.gamertag}.`,
                                    });
                                    resolve();
                                } else if (event.status !== 0 && event.status !== 3) {
                                    const failures: Record<number, string> = {
                                        1: 'The client version is too old.',
                                        2: 'The server version is too old.',
                                        7: 'The server is full.',
                                    };
                                    throw new Error(
                                        failures[event.status] ??
                                            `Bedrock login failed (${event.status}).`,
                                    );
                                }

                                break;
                            case 'disconnect':
                                throw new Error(
                                    event.message || 'Disconnected by the Bedrock server.',
                                );
                            case 'invalid':
                                throw new Error('The server sent a malformed Bedrock packet.');
                            case 'packet':
                                // Login ends before resource-pack negotiation.
                                break;
                        }
                    }
                }
            };

            void run().catch((error: unknown) => {
                close(error instanceof Error ? error : new Error('Bedrock connection failed.'));
            });
        });
        await authenticated;
        rejectLogin = undefined;
        return { server, close: () => close() };
    } catch (error) {
        close();
        throw error;
    }
}
