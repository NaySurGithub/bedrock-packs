import { request as httpRequest } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolveTarget } from './policy.js';
import type { DestinationPolicy } from './policy.js';
import { clientIp } from './client-ip.js';

const maximumSdpBytes = 1024 * 1024;

export function createSignalingHandler(options: {
    origins: ReadonlySet<string>;
    policy: DestinationPolicy;
    resolve?: typeof resolveTarget;
    trustedProxies?: number;
}) {
    const clients = new Map<string, number>();
    let active = 0;

    return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
        const origin = request.headers.origin;

        if (!origin || !options.origins.has(origin)) {
            response.writeHead(403).end();
            return;
        }

        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');

        if (request.method === 'OPTIONS') {
            response.setHeader('Access-Control-Allow-Methods', 'POST');
            response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            response.writeHead(204).end();
            return;
        }

        const ip = clientIp(request, options.trustedProxies);

        if (request.method !== 'POST') {
            response.writeHead(405).end();
            return;
        }

        if (active >= 64 || (clients.get(ip) ?? 0) >= 4) {
            response.writeHead(429).end();
            return;
        }

        active++;
        clients.set(ip, (clients.get(ip) ?? 0) + 1);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        const abort = () => controller.abort();
        request.once('aborted', abort);
        response.once('close', abort);

        try {
            const url = new URL(request.url ?? '', 'http://relay.invalid');
            const host = url.searchParams.get('host') ?? '';
            const portText = url.searchParams.get('port') ?? '';
            const networkId = url.searchParams.get('networkId') ?? '';

            if (!/^\d{1,5}$/.test(portText) || !/^\d{1,20}$/.test(networkId)) {
                response.writeHead(400).end();
                return;
            }

            const chunks: Buffer[] = [];
            let length = 0;

            request.setTimeout(10000, abort);

            for await (const chunk of request) {
                controller.signal.throwIfAborted();
                length += (chunk as Buffer).length;

                if (length > maximumSdpBytes) {
                    response.writeHead(413).end();
                    return;
                }

                chunks.push(chunk as Buffer);
            }

            const offer = Buffer.concat(chunks);

            if (!offer.toString('utf8', 0, 3).startsWith('v=0')) {
                response.writeHead(400).end();
                return;
            }

            const port = Number(portText);
            const target = await (options.resolve ?? resolveTarget)(host, port, options.policy);
            controller.signal.throwIfAborted();
            const answer = await new Promise<string>((resolve, reject) => {
                const upstream = httpRequest(
                    {
                        hostname: target.address,
                        family: target.family,
                        port,
                        path: `/v1/join/${networkId}`,
                        method: 'POST',
                        agent: false,
                        maxHeaderSize: 16384,
                        signal: controller.signal,
                        headers: {
                            Host: `${host.includes(':') ? `[${host}]` : host}:${port}`,
                            'Content-Type': 'application/sdp',
                            'Content-Length': offer.length,
                            'User-Agent': 'BedrockPacks/0.1.0',
                        },
                    },
                    (incoming) => {
                        if (incoming.statusCode !== 200) {
                            incoming.destroy();
                            reject(new Error('The NetherNet endpoint rejected the offer.'));
                            return;
                        }

                        const received: Buffer[] = [];
                        let size = 0;
                        incoming.on('error', reject);
                        incoming.on('data', (chunk: Buffer) => {
                            size += chunk.length;

                            if (size > maximumSdpBytes) {
                                upstream.destroy(new Error('The SDP answer is too large.'));
                                return;
                            }

                            received.push(chunk);
                        });
                        incoming.on('end', () => resolve(Buffer.concat(received).toString('utf8')));
                    },
                );
                upstream.on('error', reject);
                upstream.end(offer);
            });

            if (!answer.startsWith('v=0')) {
                throw new Error('Invalid SDP answer.');
            }

            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ sdp: answer, address: target.address }));
        } catch {
            if (!response.headersSent && !response.destroyed) {
                response.writeHead(502).end();
            }
        } finally {
            clearTimeout(timeout);
            request.off('aborted', abort);
            response.off('close', abort);
            active--;
            const remaining = (clients.get(ip) ?? 1) - 1;

            if (remaining > 0) {
                clients.set(ip, remaining);
            } else {
                clients.delete(ip);
            }
        }
    };
}
