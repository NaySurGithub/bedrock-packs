import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { resolveTarget } from './policy.js';
import type { DestinationPolicy } from './policy.js';

export interface RelayOptions {
    origins: ReadonlySet<string>;
    policy: DestinationPolicy;
    maxSessions?: number;
    maxSessionsPerIp?: number;
    idleTimeoutMs?: number;
    sessionTimeoutMs?: number;
    resolve?: typeof resolveTarget;
}

const MAX_DATAGRAM = 1492;
const MAX_BUFFERED = 256 * 1024;
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_PACKETS_PER_SECOND = 1000;

export function createRelay(options: RelayOptions) {
    const server = createServer((request, response) => {
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        if (request.method === 'GET' && request.url === '/healthz') {
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
        const ip = request.socket.remoteAddress ?? 'unknown';
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
            .then((target) => {
                clearTimeout(timeout);
                if (socket.destroyed) {
                    return;
                }

                webSockets.handleUpgrade(request, socket as Socket, head, (ws) => {
                    socket.off('close', release);
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
    const finish = () => {
        if (closed) {
            return;
        }

        closed = true;
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
        if (++packets > MAX_PACKETS_PER_SECOND || bytes > MAX_BYTES) {
            finish();
            return false;
        }
        lastActivity = now;
        return true;
    };
    const timer = setInterval(() => {
        const now = Date.now();
        if (
            now - lastActivity > (options.idleTimeoutMs ?? 15000) ||
            now - started > (options.sessionTimeoutMs ?? 300000)
        ) {
            finish();
        }
    }, 1000);
    timer.unref();
    ws.on('error', finish);
    ws.on('close', finish);
    udp.on('error', finish);
    ws.on('message', (data, binary) => {
        if (
            !ready ||
            !binary ||
            !(data instanceof Buffer) ||
            data.length === 0 ||
            data.length > MAX_DATAGRAM
        ) {
            finish();
            return;
        }
        if (!account(data.length)) {
            return;
        }

        if (udp.getSendQueueSize() > MAX_BUFFERED) {
            finish();
            return;
        }
        udp.send(data, (error) => {
            if (error) {
                finish();
            }
        });
    });
    udp.on('message', (data) => {
        if (data.length > MAX_DATAGRAM || !account(data.length)) {
            return;
        }

        if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > MAX_BUFFERED) {
            finish();
            return;
        }
        ws.send(
            data,
            {
                binary: true,
            },
            (error) => {
                if (error) {
                    finish();
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
                maxDatagram: MAX_DATAGRAM,
            }),
        );
    });
}
