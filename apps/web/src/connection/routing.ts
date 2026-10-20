export interface ServerTarget {
    host: string;
    port: number;
}

export type EndpointResult =
    | { type: 'transfer'; target: ServerTarget }
    | { type: 'cancelled'; message: string }
    | { type: 'error'; error: Error };

export function transferTarget(address: string, port: number): ServerTarget {
    let host = address.trim();
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    if (
        !host ||
        host.length > 253 ||
        /[\s/\\?#@]/.test(host) ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
    ) {
        throw new Error('The server sent an invalid transfer destination.');
    }
    if (host.includes(':')) {
        try {
            host = new URL(`http://[${host}]/`).hostname.slice(1, -1);
        } catch {
            throw new Error('The server sent an invalid IPv6 transfer destination.');
        }
    } else if (!/^[a-z0-9.-]+$/i.test(host)) {
        throw new Error('The server sent an invalid transfer hostname.');
    }
    return { host: host.toLowerCase(), port };
}

export async function followTransfers(
    initial: ServerTarget,
    signal: AbortSignal,
    open: (target: ServerTarget) => Promise<EndpointResult>,
    transferring: (target: ServerTarget, count: number) => void,
): Promise<string> {
    let target = initial;
    let count = 0;
    for (;;) {
        signal.throwIfAborted();
        const result = await open(target);
        signal.throwIfAborted();
        if (result.type === 'error') throw result.error;
        if (result.type === 'cancelled') return result.message;
        target = transferTarget(result.target.host, result.target.port);
        if (++count > 8)
            throw new Error(
                'The server redirected this connection too many times (maximum 8 transfers).',
            );
        transferring(target, count);
    }
}
