import { createClientProfile, windowsDeviceId } from './profile.js';
import { followTransfers, transferTarget } from './routing.js';
import type { EndpointResult, ServerTarget } from './routing.js';
import { debug } from '../debug.js';
import { PackTransfer } from '../packs/transfer.js';
import { processPack } from '../packs/process.js';
import type { PackView } from '../packs/types.js';
import type { AccountClient } from '../auth/client.js';
import type { QueryModule, ServerAnnouncement } from '../query.js';
import { queryServer } from '../query.js';
import { BrowserCodec } from './codec.js';
import { GameCipher, signToken, tokenParts } from './crypto.js';
import type { ConnectionIdentity } from './crypto.js';
import { connectNetherNet } from './nethernet.js';
import { connectRakNet } from './transport.js';
import type { BedrockTransport } from './transport.js';

export interface ConnectionState {
    phase:
        | 'authenticating'
        | 'detecting'
        | 'connecting'
        | 'logging-in'
        | 'connected'
        | 'transferring'
        | 'ready'
        | 'disconnected';
    message: string;
    outcome?: 'error' | 'cancelled' | 'completed';
    server?: ServerAnnouncement;
    destination?: ServerTarget;
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
    packsChanged: (packs: PackView[]) => void = () => {},
): Promise<void> {
    if (inUse) throw new Error('Disconnect the current server before connecting again.');
    signal.throwIfAborted();
    inUse = true;
    const retained = new Map<string, PackView>();
    try {
        const message = await followTransfers(
            { host, port },
            signal,
            (target) =>
                connectEndpoint(
                    module,
                    account,
                    target.host,
                    target.port,
                    signal,
                    changed,
                    (packs) => {
                        const merged = new Map(retained);
                        for (const pack of packs) {
                            const ready = retained.get(pack.id);
                            if (!ready || ready.version !== pack.version || pack.status === 'ready')
                                merged.set(pack.id, pack);
                        }
                        for (const pack of packs)
                            if (pack.status === 'ready') retained.set(pack.id, pack);
                        packsChanged([...merged.values()]);
                    },
                ),
            (destination, count) => {
                packsChanged([...retained.values()]);
                changed({
                    phase: 'transferring',
                    destination,
                    message: `Transfer ${count}: connecting to ${destination.host}:${destination.port}…`,
                });
            },
        );
        changed({ phase: 'disconnected', message, outcome: 'cancelled' });
    } finally {
        inUse = false;
    }
}

async function connectEndpoint(
    module: QueryModule,
    account: AccountClient,
    host: string,
    port: number,
    signal: AbortSignal,
    changed: (state: ConnectionState) => void,
    packsChanged: (packs: PackView[]) => void,
): Promise<EndpointResult> {
    signal.throwIfAborted();
    const codec = new BrowserCodec(module.connection);
    let transport: BedrockTransport | undefined;
    let cipher: GameCipher | undefined;
    let closed = false;
    let connected = false;
    let finish!: (result: EndpointResult) => void;
    const finished = new Promise<EndpointResult>((resolve) => {
        finish = resolve;
    });
    const controller = new AbortController();

    const close = (result: EndpointResult = { type: 'cancelled', message: 'Disconnected.' }) => {
        if (closed) return;
        closed = true;
        debug('session', 'closed', {
            result: result.type,
            detail:
                result.type === 'error'
                    ? result.error.message
                    : result.type === 'cancelled'
                      ? result.message
                      : result.target,
        });
        clearTimeout(deadline);
        signal.removeEventListener('abort', abort);
        unsubscribe();
        controller.abort();
        transport?.close();
        cipher?.dispose();
        finish(result);
    };
    const abort = () => close({ type: 'cancelled', message: 'Connection cancelled.' });
    const deadline = setTimeout(
        () => close({ type: 'error', error: new Error('The Bedrock login timed out.') }),
        60000,
    );
    const unsubscribe = account.subscribe((state) => {
        if (state.status === 'signed-out' || state.status === 'error') {
            queueMicrotask(() =>
                close({
                    type: 'error',
                    error: new Error('The Microsoft session is no longer available.'),
                }),
            );
        }
    });
    signal.addEventListener('abort', abort, { once: true });

    try {
        changed({
            phase: 'authenticating',
            message: `Preparing Microsoft identity for ${host}:${port}…`,
        });
        const identity = await account.connectionIdentity();
        controller.signal.throwIfAborted();
        changed({ phase: 'detecting', message: `Detecting transport for ${host}:${port}…` });
        const server = await queryServer(module, host, port, controller.signal);
        const protocol = Number(server.protocol);

        if (!Number.isInteger(protocol) || !codec.native._bp_protocol_select(protocol)) {
            throw new Error(
                `Server protocol ${server.protocol} is not supported by this Falcon build.`,
            );
        }

        controller.signal.throwIfAborted();
        changed({
            phase: 'connecting',
            message: `Connecting to ${host}:${port} with ${server.transport}…`,
        });
        debug('session', 'connecting', {
            host,
            port,
            transport: server.transport,
            protocol,
        });
        transport =
            server.transport === 'NetherNet'
                ? await connectNetherNet(codec, identity, host, port, controller.signal)
                : await connectRakNet(codec, host, port, controller.signal);
        controller.signal.throwIfAborted();
        codec.start(transport.raknet);
        const address = `${host.includes(':') ? `[${host}]` : host}:${port}`;
        const clientVersion = module.authConfig().gameVersion;
        const data = codec.clientData(
            address,
            identity.gamertag,
            clientVersion,
            identity.identity.playFabId,
            // The Xbox device token keeps its own UUID; the login claims a Windows device ID.
            createClientProfile(
                await windowsDeviceId(identity.xuid),
                identity.deviceType,
                identity.xuid,
            ),
        );
        const clientJwt = await signToken(identity, data);
        const auth = await loginIdentity(identity, clientVersion);
        controller.signal.throwIfAborted();

        const send = async (packet: Uint8Array) => {
            if (!packet.length) throw new Error('Could not encode the Bedrock packet.');
            for (const batch of codec.send(packet)) {
                const data = cipher && transport!.raknet ? await cipher.encrypt(batch) : batch;
                controller.signal.throwIfAborted();
                transport!.send(data);
            }
        };

        // Both protocol negotiation and pack requests share the session's encrypted send path.
        const packs = new PackTransfer(
            {
                response: (status, ids) => send(codec.packResponse(status, ids)),
                request: (id, version, index) => send(codec.packRequest(id, version, index)),
            },
            processPack,
            controller.signal,
            packsChanged,
            (count) =>
                changed({
                    phase: 'ready',
                    message: count
                        ? `${count} pack(s) ready. Staying connected for server transfers.`
                        : 'No resource packs. Waiting for a server transfer.',
                }),
            (error) => close({ type: 'error', error }),
        );

        let sentLogin = false;
        let handshake = false;
        const run = async () => {
            await send(codec.settings(protocol));

            while (!closed) {
                const incoming = await transport!.receive();
                const batch =
                    cipher && transport!.raknet ? await cipher.decrypt(incoming) : incoming;
                controller.signal.throwIfAborted();

                for (const packet of codec.receive(batch)) {
                    if (closed) break;
                    const event = codec.read(packet);
                    if (event.type !== 'pack-chunk') {
                        const { token: _token, ...details } = event as typeof event & {
                            token?: string;
                        };
                        debug(
                            'session',
                            `packet ${event.type}`,
                            event.type === 'packs-info' ? { count: event.packs.length } : details,
                        );
                    }

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
                                packs.start();
                                changed({
                                    phase: 'connected',
                                    message: `Connected as ${identity.gamertag}.`,
                                    server,
                                    destination: { host, port },
                                });
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
                        case 'transfer':
                            if (!sentLogin)
                                throw new Error('The server sent a transfer before login.');
                            close({
                                type: 'transfer',
                                target: transferTarget(event.host, event.port),
                            });
                            break;
                        case 'disconnect':
                            throw new Error(
                                event.message ||
                                    `Disconnected by the Bedrock server (reason ${event.reason}).`,
                            );
                        case 'invalid':
                            throw new Error('The server sent a malformed Bedrock packet.');
                        case 'packs-info':
                        case 'pack-data':
                        case 'pack-chunk':
                        case 'packs-stack':
                            if (!connected)
                                throw new Error('The server sent packs before login completed.');
                            await packs.handle(event);
                            break;
                        case 'packet':
                            break;
                    }
                }
            }
        };

        void run().catch((error: unknown) => {
            close({
                type: 'error',
                error: error instanceof Error ? error : new Error('Bedrock connection failed.'),
            });
        });
        return await finished;
    } catch (error) {
        close({
            type: 'error',
            error: error instanceof Error ? error : new Error('Bedrock connection failed.'),
        });
        return await finished;
    }
}
