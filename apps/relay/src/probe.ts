import { request } from 'node:http';

export interface EndpointStatus {
    name: string;
    protocol: number;
    version: string;
    level: string;
    players: number;
    maxPlayers: number;
}

function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function integer(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
}

export function probeEndpoint(
    address: string,
    family: number,
    host: string,
    port: number,
): Promise<EndpointStatus | undefined> {
    return new Promise((resolve) => {
        let settled = false;

        const finish = (status?: EndpointStatus) => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(deadline);
            connection.destroy();
            resolve(status);
        };

        // Use the validated IP directly. Neither DNS nor redirects can change the destination.
        const connection = request({
            hostname: address,
            family,
            port,
            path: '/v1/join',
            method: 'GET',
            agent: false,
            maxHeaderSize: 16 * 1024,
            headers: {
                Host: `${host.includes(':') ? `[${host}]` : host}:${port}`,
                Accept: 'application/json',
                'User-Agent': 'BedrockPacks/0.1.0',
            },
        });

        const deadline = setTimeout(() => finish(), 2000);
        deadline.unref();

        connection.on('error', () => finish());
        connection.on('response', (response) => {
            if (response.statusCode !== 200) {
                finish();
                return;
            }

            let length = 0;
            const chunks: Buffer[] = [];

            response.on('error', () => finish());
            response.on('data', (chunk: Buffer) => {
                length += chunk.length;

                if (length > 64 * 1024) {
                    finish();
                    return;
                }

                chunks.push(chunk);
            });

            response.on('end', () => {
                let status: unknown;

                try {
                    status = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                } catch {
                    finish();
                    return;
                }

                if (
                    !status ||
                    typeof status !== 'object' ||
                    !('name' in status) ||
                    !('protocol' in status)
                ) {
                    finish();
                    return;
                }

                const fields = status as Record<string, unknown>;

                finish({
                    name: text(fields.name),
                    protocol: integer(fields.protocol),
                    version: text(fields.version),
                    level: text(fields.level),
                    players: integer(fields.players),
                    maxPlayers: integer(fields.maxPlayers),
                });
            });
        });

        connection.end();
    });
}
