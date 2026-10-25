import type { IncomingMessage, ServerResponse } from 'node:http';
import { request as requestHttps } from 'node:https';
import { clientIp } from './client-ip.js';

export interface AuthResponse {
    status: number;
    body: string;
    date: string;
    xboxError: string;
    cookies: string;
}

export interface AuthRequest {
    operation: string;
    body?: string;
    signature?: string;
    authorization?: string;
    cookies?: string;
    gameVersion?: string;
    titleId?: string;
    xuid?: string;
}

export interface AuthTarget {
    url: URL;
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body: string;
}

export type AuthForwarder = (target: AuthTarget, signal: AbortSignal) => Promise<AuthResponse>;

const authorizationService = 'https://authorization.franchise.minecraft-services.net';
const maximumRequestBytes = 128 * 1024;
const maximumResponseBytes = 1024 * 1024;

class AuthInputError extends Error {
    constructor(
        message: string,
        readonly status = 400,
    ) {
        super(message);
    }
}

function header(value: unknown, maximum = 32768): string {
    if (typeof value !== 'string' || value.length > maximum || /[\r\n\0]/.test(value)) {
        throw new AuthInputError('Invalid authentication header.');
    }

    return value;
}

export function authTarget(input: AuthRequest): AuthTarget {
    const headers: Record<string, string> = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'BedrockPacks/0.1.0',
    };

    let endpoint: string;
    let method: 'GET' | 'POST' = 'POST';

    switch (input.operation) {
        case 'device-code':
        case 'live-token': {
            endpoint =
                input.operation === 'device-code'
                    ? 'https://login.live.com/oauth20_connect.srf'
                    : 'https://login.live.com/oauth20_token.srf';
            headers['Content-Type'] = 'application/x-www-form-urlencoded';

            if (input.cookies) {
                headers.Cookie = header(input.cookies, 8192);
            }

            break;
        }

        case 'xbox-device':
        case 'xbox-authorize': {
            endpoint =
                input.operation === 'xbox-device'
                    ? 'https://device.auth.xboxlive.com/device/authenticate'
                    : 'https://sisu.xboxlive.com/authorize';
            headers['x-xbl-contract-version'] = '1';
            headers.Signature = header(input.signature, 256);
            break;
        }

        case 'profile': {
            if (!/^\d{1,20}$/.test(input.xuid ?? '')) {
                throw new AuthInputError('Invalid Xbox profile identifier.');
            }

            endpoint = `https://profile.xboxlive.com/users/xuid(${input.xuid})/profile/settings?settings=Gamertag`;
            headers.Authorization = header(input.authorization);
            headers['x-xbl-contract-version'] = '2';
            method = 'GET';
            break;
        }

        case 'discovery': {
            if (!/^\d{1,3}\.\d{1,3}\.\d{1,5}(?:\.\d{1,5})?$/.test(input.gameVersion ?? '')) {
                throw new AuthInputError('Invalid game version.');
            }

            endpoint = `https://client.discovery.minecraft-services.net/api/v1.0/discovery/MinecraftPE/builds/${input.gameVersion}`;
            method = 'GET';
            break;
        }

        case 'playfab': {
            if (!/^[a-fA-F0-9]{1,8}$/.test(input.titleId ?? '')) {
                throw new AuthInputError('Invalid PlayFab title.');
            }

            endpoint = `https://${input.titleId!.toLowerCase()}.playfabapi.com/Client/LoginWithXbox`;
            break;
        }

        case 'service-start':
        case 'service-renew':
        case 'multiplayer': {
            const paths = {
                'service-start': '/api/v1.0/session/start',
                'service-renew': '/api/v1.0/session/renew',
                multiplayer: '/api/v1.0/multiplayer/session/start',
            };

            endpoint = authorizationService + paths[input.operation];
            headers['User-Agent'] = 'libhttpclient/1.0.0.0';

            if (input.operation !== 'service-start') {
                headers.Authorization = header(input.authorization);
            }

            break;
        }

        case 'chain': {
            if (!/^\d{1,3}\.\d{1,3}\.\d{1,5}(?:\.\d{1,5})?$/.test(input.gameVersion ?? '')) {
                throw new AuthInputError('Invalid game version.');
            }

            endpoint = 'https://multiplayer.minecraft.net/authentication';
            headers.Authorization = header(input.authorization);
            headers['Client-Version'] = input.gameVersion!;
            headers['User-Agent'] = 'MCPE/Android';
            break;
        }

        default:
            throw new AuthInputError('Unsupported authentication operation.');
    }

    return {
        url: new URL(endpoint),
        method,
        headers,
        body: method === 'POST' ? header(input.body ?? '', maximumRequestBytes) : '',
    };
}

function sessionCookies(values: string[]): string {
    return values
        .map((value) => value.split(';', 1)[0] ?? '')
        .filter((value) => /^[^\s=;,\x00-\x1f\x7f]+=[^;\r\n\0]*$/.test(value))
        .join('; ')
        .slice(0, 8192);
}

export const forwardAuthentication: AuthForwarder = (target, signal) => {
    return new Promise((resolve, reject) => {
        const connection = requestHttps(target.url, {
            method: target.method,
            headers: target.headers,
            signal,
            agent: false,
            maxHeaderSize: 16 * 1024,
        });

        const deadline = setTimeout(() => {
            connection.destroy(new Error('Authentication request timed out.'));
        }, 15000);

        connection.once('error', () => {
            clearTimeout(deadline);
            reject(new Error('The authentication service could not be reached.'));
        });

        connection.on('response', (response) => {
            let length = 0;
            const chunks: Buffer[] = [];

            response.on('data', (chunk: Buffer) => {
                length += chunk.length;

                if (length > maximumResponseBytes) {
                    connection.destroy(
                        new Error('Authentication response exceeds the size limit.'),
                    );
                    return;
                }

                chunks.push(chunk);
            });

            response.on('error', () => {
                clearTimeout(deadline);
                reject(new Error('The authentication response was interrupted.'));
            });

            response.on('end', () => {
                clearTimeout(deadline);

                resolve({
                    status: response.statusCode ?? 502,
                    body: Buffer.concat(chunks).toString('utf8'),
                    date: String(response.headers.date ?? ''),
                    xboxError: String(response.headers['x-err'] ?? ''),
                    cookies:
                        target.url.hostname === 'login.live.com'
                            ? sessionCookies(response.headers['set-cookie'] ?? [])
                            : '',
                });
            });
        });

        connection.end(target.body);
    });
};

function readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let length = 0;
        let exceeded = false;
        const chunks: Buffer[] = [];

        request.on('data', (chunk: Buffer) => {
            length += chunk.length;

            if (length > maximumRequestBytes) {
                exceeded = true;
                chunks.length = 0;
                reject(new AuthInputError('Authentication request exceeds the size limit.', 413));
                return;
            }

            if (!exceeded) {
                chunks.push(chunk);
            }
        });

        request.once('end', () => {
            if (!exceeded) {
                resolve(Buffer.concat(chunks).toString('utf8'));
            }
        });

        request.once('error', () => reject(new Error('Authentication request interrupted.')));
    });
}

export function createAuthHandler(
    origins: ReadonlySet<string>,
    forward = forwardAuthentication,
    trustedProxies = 0,
) {
    const windows = new Map<
        string,
        {
            start: number;
            requests: number;
            active: number;
        }
    >();

    let totalActive = 0;

    return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
        const send = (status: number, value: unknown) => {
            if (!response.destroyed) {
                response.writeHead(status, {
                    'Content-Type': 'application/json',
                });
                response.end(JSON.stringify(value));
            }
        };

        const origin = request.headers.origin;
        request.setTimeout(15000, () => request.destroy());

        if (!origin || !origins.has(origin)) {
            send(403, {
                error: 'Origin is not allowed.',
            });
            return;
        }

        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
        response.setHeader('Cache-Control', 'no-store');

        if (request.method === 'OPTIONS') {
            response.writeHead(204, {
                'Access-Control-Allow-Methods': 'POST',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Max-Age': '600',
            });
            response.end();
            return;
        }

        if (request.method !== 'POST' || request.headers['content-type'] !== 'application/json') {
            send(400, {
                error: 'Send a JSON authentication request.',
            });
            return;
        }

        const now = Date.now();
        const ip = clientIp(request, trustedProxies);

        for (const [key, window] of windows) {
            if (window.active === 0 && now - window.start >= 60000) {
                windows.delete(key);
            }
        }

        const window = windows.get(ip) ?? {
            start: now,
            requests: 0,
            active: 0,
        };

        if (now - window.start >= 60000) {
            window.start = now;
            window.requests = 0;
        }

        if (
            windows.size >= 4096 ||
            window.requests >= 120 ||
            window.active >= 4 ||
            totalActive >= 64
        ) {
            send(429, {
                error: 'Too many authentication requests. Try again shortly.',
            });
            return;
        }

        windows.set(ip, window);
        window.requests++;
        window.active++;
        totalActive++;

        const cancellation = new AbortController();
        const abort = () => cancellation.abort();
        request.once('aborted', abort);
        response.once('close', abort);

        try {
            const input: unknown = JSON.parse(await readBody(request));

            if (!input || typeof input !== 'object' || !('operation' in input)) {
                throw new AuthInputError('Invalid authentication request.');
            }

            const target = authTarget(input as AuthRequest);
            const result = await forward(target, cancellation.signal);
            send(200, result);
        } catch (error: unknown) {
            const status =
                error instanceof AuthInputError
                    ? error.status
                    : error instanceof SyntaxError
                      ? 400
                      : 502;

            send(status, {
                error:
                    status < 500
                        ? 'Invalid authentication request.'
                        : 'Authentication request failed. Check the relay connection and try again.',
            });
        } finally {
            request.off('aborted', abort);
            response.off('close', abort);
            window.active--;
            totalActive--;
        }
    };
}
