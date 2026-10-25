import { parseAllowedPorts } from './policy.js';
import { createRelay } from './server.js';

function integer(name: string, fallback: number, max = 65535, min = 1): number {
    const value = process.env[name] ?? String(fallback);
    if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
        throw new Error(`Invalid ${name}.`);
    }

    return Number(value);
}

const origins = new Set(
    (process.env.RELAY_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
);
const hosts = new Set(
    (process.env.RELAY_ALLOWED_HOSTS ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
);
const ports = parseAllowedPorts(process.env.RELAY_ALLOWED_PORTS ?? '19132');
const relay = createRelay({
    origins,
    policy: {
        allowedHosts: hosts,
        allowedPorts: ports,
    },
    maxSessions: integer('RELAY_MAX_SESSIONS', 64, 4096),
    maxPacketsPerSecond: integer('RELAY_MAX_PACKETS_PER_SECOND', 20000, 1000000),
    trustedProxies: integer('RELAY_TRUSTED_PROXIES', 0, 8, 0),
});
const host = process.env.RELAY_HOST ?? '127.0.0.1';
// Hosting platforms such as Render assign the listening port through PORT.
const port = integer(process.env.RELAY_PORT ? 'RELAY_PORT' : 'PORT', 8787);
relay.server.listen(port, host, () =>
    console.info(`Bedrock Packs relay listening on ${host}:${port}`),
);
relay.server.on('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
        void relay.close().catch((error: unknown) => {
            console.error(error);
            process.exitCode = 1;
        });
    });
}
