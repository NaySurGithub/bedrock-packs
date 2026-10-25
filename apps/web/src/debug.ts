// Development diagnostics. Entries go to the console and, while the Vite dev server runs,
// to logs/debug.log as JSON lines. Never pass content keys or tokens to debug().

const ENDPOINT = '/__debug-log';
const enabled = typeof window !== 'undefined' && Boolean(import.meta.env?.DEV);
export const debugging = enabled;
let queue: string[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

function flush(): void {
    timer = undefined;
    if (!queue.length) return;
    const body = queue.join('\n');
    queue = [];
    void fetch(ENDPOINT, { method: 'POST', body, keepalive: true }).catch(() => {});
}

export function debug(scope: string, message: string, data?: Record<string, unknown>): void {
    console.debug(`[${scope}] ${message}`, data ?? '');
    if (!enabled) return;
    queue.push(JSON.stringify({ time: new Date().toISOString(), scope, message, ...data }));
    timer ??= setTimeout(flush, 200);
}

// Saves a failing download to logs/<name> for inspection (development only).
export function debugFile(name: string, bytes: Uint8Array): void {
    if (!enabled) return;
    void fetch(`${ENDPOINT}?file=${encodeURIComponent(name)}`, {
        method: 'POST',
        body: new Uint8Array(bytes),
    }).catch(() => {});
}

export function redact(value: string): string {
    return value ? `<${value.length} chars>` : '';
}

if (enabled) addEventListener('pagehide', flush);
