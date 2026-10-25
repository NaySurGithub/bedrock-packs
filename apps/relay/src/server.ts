import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { resolveTarget } from './policy.js';
import type { DestinationPolicy } from './policy.js';
import { probeEndpoint } from './probe.js';
import { createAuthHandler } from './auth.js';
import type { AuthForwarder } from './auth.js';
import { createSignalingHandler } from './signaling.js';
import { clientIp } from './client-ip.js';

export interface RelayOptions {
    origins: ReadonlySet<string>;
    policy: DestinationPolicy;
    maxSessions?: number;
    maxSessionsPerIp?: number;
    idleTimeoutMs?: number;
    sessionTimeoutMs?: number;
    maxPacketsPerSecond?: number;
    trustedProxies?: number;
    resolve?: typeof resolveTarget;
    authForwarder?: AuthForwarder;
}

const MAX_DATAGRAM = 1492;
const MAX_BUFFERED = 256 * 1024;
const MAX_BYTES = 512 * 1024 * 1024;
// Pack downloads burst several hundred full datagrams per requested chunk window,
// plus the client's acknowledgements, so the default must sit well above that.
const MAX_PACKETS_PER_SECOND = 20000;

export function createRelay(options: RelayOptions) {
    const authenticate = createAuthHandler(
        options.origins,
        options.authForwarder,
        options.trustedProxies,
    );
    const signal = createSignalingHandler(options);

    const server = createServer((request, response) => {
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        if (request.url === '/auth') {
            void authenticate(request, response);
        } else if (request.url?.split('?')[0] === '/signal') {
            void signal(request, response);
        } else if (request.method === 'GET' && request.url === '/healthz') {
            response.writeHead(200, {
                'Content-Type': 'application/json',
            });
            response.end('{"status":"ok"}');
        } else {
            response.writeHead(404);
            response.end();
        }
    });
    const webSockets = new WebSocketServer({
        noServer: true,
        maxPayload: MAX_DATAGRAM,
        perMessageDeflate: false,
    });
    const counts = new Map<string, number>();
    let sessions = 0;

    server.on('upgrade', (request, socket, head) => {
        const reject = (status: number) => {
            socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
        };
        const ip = clientIp(request, options.trustedProxies);
        const origin = request.headers.origin;
        let url: URL;
        try {
            url = new URL(request.url ?? '/', 'http://relay.invalid');
        } catch {
            reject(400);
            return;
        }
        if (url.pathname !== '/relay') {
            reject(404);
            return;
        }
        if (!origin || !options.origins.has(origin)) {
            reject(403);
            return;
        }
        if (
            sessions >= (options.maxSessions ?? 64) ||
            (counts.get(ip) ?? 0) >= (options.maxSessionsPerIp ?? 4)
        ) {
            reject(429);
            return;
        }
        const host = url.searchParams.get('host') ?? '';
        const rawPort = url.searchParams.get('port') ?? '19132';
        if (!/^\d{1,5}$/.test(rawPort)) {
            reject(400);
            return;
        }
        sessions++;
        counts.set(ip, (counts.get(ip) ?? 0) + 1);
        let released = false;
        const release = () => {
            if (released) {
                return;
            }

            released = true;
            sessions--;
            const count = (counts.get(ip) ?? 1) - 1;
            if (count) {
                counts.set(ip, count);
            } else {
                counts.delete(ip);
            }
        };
        socket.once('close', release);
        const timeout = setTimeout(() => {
            socket.destroy();
            release();
        }, 5000);
        void (options.resolve ?? resolveTarget)(host, Number(rawPort), options.policy)
            .then(async (target) => {
                clearTimeout(timeout);

                const endpoint = await probeEndpoint(
                    target.address,
                    target.family,
                    host,
                    Number(rawPort),
                );

                if (socket.destroyed) {
                    return;
                }

                webSockets.handleUpgrade(request, socket as Socket, head, (ws) => {
                    socket.off('close', release);

                    if (endpoint) {
                        ws.on('error', () => ws.terminate());
                        ws.once('close', release);
                        ws.send(
                            JSON.stringify({
                                type: 'ready',
                                version: 1,
                                transport: 'nethernet',
                                status: endpoint,
                            }),
                        );
                        ws.close(1000);
                        return;
                    }

                    bridge(ws, target.address, target.family, Number(rawPort), options, release);
                });
            })
            .catch(() => {
                clearTimeout(timeout);
                reject(403);
                release();
            });
    });

    return {
        server,
        close: async () => {
            for (const ws of webSockets.clients) {
                ws.terminate();
            }

            await new Promise<void>((resolve) => webSockets.close(() => resolve()));
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
            );
        },
    };
}

function bridge(
    ws: WebSocket,
    address: string,
    family: number,
    port: number,
    options: RelayOptions,
    release: () => void,
) {
    const udp = createSocket(family === 6 ? 'udp6' : 'udp4');
    let ready = false;
    let closed = false;
    let lastActivity = Date.now();
    const started = lastActivity;
    let windowStart = started;
    let packets = 0;
    let bytes = 0;
    const finish = (reason: string) => {
        if (closed) {
            return;
        }

        closed = true;
        console.info(
            `Relay session to ${address}:${port} closed after ${Date.now() - started} ms: ${reason} ` +
                `(${bytes} bytes, ${packets} packets in the current second).`,
        );
        clearInterval(timer);
        try {
            udp.close();
        } catch {
            /* The socket may have failed before binding. */
        }
        ws.terminate();
        release();
    };
    const account = (length: number) => {
        const now = Date.now();
        if (now - windowStart >= 1000) {
            windowStart = now;
            packets = 0;
        }
        bytes += length;
        if (++packets > (options.maxPacketsPerSecond ?? MAX_PACKETS_PER_SECOND)) {
            finish('packet rate limit exceeded');
            return false;
        }
        if (bytes > MAX_BYTES) {
            finish('total byte limit exceeded');
            return false;
        }
        lastActivity = now;
        return true;
    };
    const timer = setInterval(() => {
        const now = Date.now();
        if (now - lastActivity > (options.idleTimeoutMs ?? 15000)) {
            finish('idle timeout');
        } else if (now - started > (options.sessionTimeoutMs ?? 300000)) {
            finish('session lifetime exceeded');
        }
    }, 1000);
    timer.unref();
    ws.on('error', (error) => finish(`WebSocket error: ${error.message}`));
    ws.on('close', (code) => finish(`browser closed the WebSocket (${code})`));
    udp.on('error', (error) => finish(`UDP error: ${error.message}`));
    ws.on('message', (data, binary) => {
        if (
            !ready ||
            !binary ||
            !(data instanceof Buffer) ||
            data.length === 0 ||
            data.length > MAX_DATAGRAM
        ) {
            finish('invalid message from the browser');
            return;
        }
        if (!account(data.length)) {
            return;
        }

        if (udp.getSendQueueSize() > MAX_BUFFERED) {
            finish('UDP send queue full');
            return;
        }
        udp.send(data, (error) => {
            if (error) {
                finish(`UDP send failed: ${error.message}`);
            }
        });
    });
    udp.on('message', (data) => {
        if (data.length > MAX_DATAGRAM || !account(data.length)) {
            return;
        }

        if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > MAX_BUFFERED) {
            finish(
                ws.readyState === WebSocket.OPEN
                    ? 'WebSocket output buffer full'
                    : 'WebSocket no longer open',
            );
            return;
        }
        ws.send(
            data,
            {
                binary: true,
            },
            (error) => {
                if (error) {
                    finish(`WebSocket send failed: ${error.message}`);
                }
            },
        );
    });
    udp.connect(port, address, () => {
        if (closed) {
            return;
        }

        ready = true;
        ws.send(
            JSON.stringify({
                type: 'ready',
                version: 1,
                transport: 'raknet',
                maxDatagram: MAX_DATAGRAM,
            }),
        );
    });
}
