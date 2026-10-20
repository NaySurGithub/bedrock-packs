import type { BrowserCodec } from './codec.js';
import type { ConnectionIdentity } from './crypto.js';
import { decode64, encode64, import384, tokenParts, verify384 } from './crypto.js';
import { PacketQueue, relayUrl } from './transport.js';
import type { BedrockTransport } from './transport.js';

const encoder = new TextEncoder();

async function verifyAnswer(codec: BrowserCodec, sdp: string): Promise<void> {
    const description = codec.description(sdp);

    if (!description.hasFingerprints || !description.identity || description.error) {
        throw new Error('The NetherNet server did not provide a valid signed identity.');
    }

    const parsed = tokenParts(description.token);
    const cpk = parsed.claims.cpk;

    if (
        parsed.header.alg !== 'ES384' ||
        (typeof parsed.claims.exp === 'number' && parsed.claims.exp * 1000 < Date.now())
    ) {
        throw new Error('The NetherNet server identity is invalid or expired.');
    }

    let key: CryptoKey;

    if (typeof cpk === 'string') {
        key = await import384(cpk);
    } else if (cpk && typeof cpk === 'object' && !Array.isArray(cpk)) {
        const jwk = cpk as JsonWebKey;

        if (jwk.kty !== 'EC' || jwk.crv !== 'P-384' || jwk.d) {
            throw new Error('Invalid NetherNet server public key.');
        }

        key = await crypto.subtle.importKey(
            'jwk',
            jwk,
            { name: 'ECDSA', namedCurve: 'P-384' },
            false,
            ['verify'],
        );
    } else {
        throw new Error('The NetherNet server identity has no public key.');
    }

    await verify384(key, parsed.input, parsed.signature);
    const detached = description.signature.split('.');

    if (detached.length !== 3 || !detached[0] || detached[1] !== '' || !detached[2]) {
        throw new Error('Invalid NetherNet fingerprint signature.');
    }

    const header = JSON.parse(new TextDecoder().decode(decode64(detached[0]))) as { alg?: unknown };

    if (header.alg !== 'ES384') {
        throw new Error('Unsupported NetherNet signature algorithm.');
    }

    await verify384(
        key,
        encoder.encode(`${detached[0]}.${encode64(encoder.encode(description.fingerprints))}`),
        decode64(detached[2]),
    );
}

export async function connectNetherNet(
    codec: BrowserCodec,
    identity: ConnectionIdentity,
    host: string,
    port: number,
    signal: AbortSignal,
): Promise<BedrockTransport> {
    signal.throwIfAborted();

    if (!globalThis.RTCPeerConnection) {
        throw new Error('This browser does not support WebRTC.');
    }

    const peer = new RTCPeerConnection({ iceServers: [] });
    const queue = new PacketQueue();
    const reliable = peer.createDataChannel('ReliableDataChannel', { ordered: true });
    const unreliable = peer.createDataChannel('UnreliableDataChannel', {
        ordered: false,
        maxRetransmits: 0,
    });
    let closed = false;
    let closeError: Error | undefined;
    const controller = new AbortController();
    const deadline = setTimeout(
        () => close(new Error('The NetherNet handshake timed out.')),
        30000,
    );
    let rejectPending: ((error: Error) => void) | undefined;

    function close(error = new Error('Connection closed.')): void {
        if (closed) {
            return;
        }

        closed = true;
        closeError = error;
        clearTimeout(deadline);
        signal.removeEventListener('abort', abort);
        controller.abort();
        reliable.close();
        unreliable.close();
        peer.close();
        codec.native._bp_nethernet_close();
        queue.fail(error);
        rejectPending?.(error);
    }

    const abort = () => close(new Error('Connection cancelled.'));
    signal.addEventListener('abort', abort, { once: true });

    if (!codec.native._bp_nethernet_start()) {
        close();
        throw new Error('The Falcon NetherNet client could not start.');
    }

    peer.onconnectionstatechange = () => {
        if (['failed', 'closed'].includes(peer.connectionState)) {
            close(new Error(`The NetherNet connection ${peer.connectionState}.`));
        }
    };
    peer.ondatachannel = (event) => {
        event.channel.close();
        close(new Error('The server opened an unexpected data channel.'));
    };

    for (const [kind, channel] of [reliable, unreliable].entries()) {
        channel.binaryType = 'arraybuffer';
        channel.onclose = () => close(new Error('The NetherNet data channel closed.'));
        channel.onerror = (event) => {
            const detail = (event as RTCErrorEvent).error;
            close(
                new Error(
                    detail?.message
                        ? `NetherNet: ${detail.message}${detail.errorDetail ? ` (${detail.errorDetail})` : ''}`
                        : 'The NetherNet data channel failed.',
                ),
            );
        };
        channel.onmessage = (event: MessageEvent<unknown>) => {
            try {
                if (
                    !(event.data instanceof ArrayBuffer) ||
                    !codec.native._bp_nethernet_input(kind, codec.input(new Uint8Array(event.data)))
                ) {
                    throw new Error('Invalid NetherNet data channel message.');
                }

                for (;;) {
                    const packet = codec.output(codec.native._bp_nethernet_receive());

                    if (packet.length === 0) {
                        break;
                    }

                    queue.push(packet);
                }
            } catch (error) {
                close(error instanceof Error ? error : new Error('NetherNet framing failed.'));
            }
        };
    }

    try {
        await peer.setLocalDescription(await peer.createOffer());

        if (peer.iceGatheringState !== 'complete') {
            await new Promise<void>((resolve, reject) => {
                rejectPending = reject;
                peer.onicegatheringstatechange = () => {
                    if (peer.iceGatheringState === 'complete') {
                        resolve();
                    }
                };
            });
        }

        controller.signal.throwIfAborted();
        let offer = peer.localDescription?.sdp;

        if (!offer) {
            throw new Error('The browser did not produce an SDP offer.');
        }

        const description = codec.description(offer);

        if (!description.hasFingerprints) {
            throw new Error('The WebRTC offer has no DTLS fingerprint.');
        }

        const header = encode64(encoder.encode('{"alg":"ES384"}'));
        const input = `${header}.${encode64(encoder.encode(description.fingerprints))}`;
        const signature = `${header}..${encode64(await identity.sign(encoder.encode(input)))}`;
        const domain = 'authorization.franchise.minecraft-services.net';
        const encodedIdentity = codec.text(
            codec.native._bp_sdp_identity(
                codec.jsonInput({
                    token: identity.identity.multiplayerToken,
                    signature,
                    domain,
                }),
            ),
        );
        const lines = offer.split('\r\n');
        const media = lines.findIndex((line) => line.startsWith('m='));
        lines.splice(media, 0, `a=identity:${encodedIdentity}`);
        offer = lines.join('\r\n');
        const url = relayUrl('/signal', host, port);
        const random = crypto.getRandomValues(new Uint32Array(2));
        url.searchParams.set(
            'networkId',
            ((BigInt(random[0]!) << 32n) | BigInt(random[1]!)).toString(),
        );
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: offer,
            signal: controller.signal,
            credentials: 'omit',
            cache: 'no-store',
            redirect: 'error',
        });

        if (!response.ok) {
            throw new Error(`The NetherNet signaling endpoint returned HTTP ${response.status}.`);
        }

        const body = await response.text();

        if (body.length > 2 * 1024 * 1024) {
            throw new Error('The NetherNet signaling answer is too large.');
        }

        const answer = JSON.parse(body) as { sdp?: unknown };

        if (typeof answer.sdp !== 'string' || !answer.sdp.startsWith('v=0')) {
            throw new Error('Invalid NetherNet SDP answer.');
        }

        await verifyAnswer(codec, answer.sdp);
        controller.signal.throwIfAborted();
        await peer.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
        controller.signal.throwIfAborted();

        await new Promise<void>((resolve, reject) => {
            rejectPending = reject;
            const ready = () => {
                if (reliable.readyState === 'open' && unreliable.readyState === 'open') {
                    resolve();
                }
            };
            reliable.onopen = ready;
            unreliable.onopen = ready;
            ready();
        });
        rejectPending = undefined;
        clearTimeout(deadline);

        return {
            raknet: false,
            send(data) {
                if (
                    closed ||
                    reliable.readyState !== 'open' ||
                    !codec.native._bp_nethernet_send(codec.input(data))
                ) {
                    throw new Error('The NetherNet connection is unavailable.');
                }

                for (;;) {
                    const segment = codec.output(codec.native._bp_nethernet_output());

                    if (segment.length === 0) {
                        break;
                    }

                    if (reliable.bufferedAmount > 4 * 1024 * 1024) {
                        throw new Error('The WebRTC outgoing queue is full.');
                    }

                    reliable.send(segment);
                }
            },
            receive: () => queue.receive(),
            close: () => close(),
        };
    } catch (error) {
        const failure = closeError ?? error;
        close(failure instanceof Error ? failure : new Error('NetherNet connection failed.'));
        throw failure;
    }
}
