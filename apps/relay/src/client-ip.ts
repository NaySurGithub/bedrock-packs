import type { IncomingMessage } from 'node:http';

// Each trusted reverse proxy appends the address it received the request from to
// X-Forwarded-For, so the client is the entry `trustedProxies` places from the end.
// Entries further left are client-controlled and never trusted.
export function clientIp(request: IncomingMessage, trustedProxies = 0): string {
    const socket = request.socket.remoteAddress ?? 'unknown';
    if (trustedProxies < 1) {
        return socket;
    }

    const header = request.headers['x-forwarded-for'];
    const entries = (Array.isArray(header) ? header.join(',') : (header ?? ''))
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
    return entries[entries.length - trustedProxies] ?? socket;
}
