export type AuthOperation =
    | 'device-code'
    | 'live-token'
    | 'xbox-device'
    | 'xbox-authorize'
    | 'profile'
    | 'discovery'
    | 'playfab'
    | 'service-start'
    | 'service-renew'
    | 'multiplayer'
    | 'chain';

export interface AuthRequest {
    operation: AuthOperation;
    body?: string;
    signature?: string;
    authorization?: string;
    cookies?: string;
    gameVersion?: string;
    titleId?: string;
    xuid?: string;
}

export interface AuthResponse {
    status: number;
    body: string;
    date: string;
    xboxError: string;
    cookies: string;
}

export interface AuthTransport {
    request(input: AuthRequest, signal: AbortSignal): Promise<AuthResponse>;
}

export class BrowserAuthTransport implements AuthTransport {
    #url: URL;

    constructor(url: URL) {
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
            throw new Error('The authentication relay must use HTTP or HTTPS.');
        }

        if (location.protocol === 'https:' && url.protocol !== 'https:') {
            throw new Error('The authentication relay must use HTTPS on this site.');
        }

        this.#url = url;
    }

    async request(input: AuthRequest, signal: AbortSignal): Promise<AuthResponse> {
        const response = await fetch(this.#url, {
            method: 'POST',
            credentials: 'omit',
            cache: 'no-store',
            redirect: 'error',
            referrerPolicy: 'no-referrer',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(input),
            signal,
        });

        if (!response.ok) {
            throw new Error(
                response.status === 429
                    ? 'Too many sign-in requests. Try again shortly.'
                    : 'The authentication relay is unavailable.',
            );
        }

        const result = (await response.json()) as Partial<AuthResponse>;

        if (typeof result.status !== 'number' || typeof result.body !== 'string') {
            throw new Error('The authentication relay returned an invalid response.');
        }

        return {
            status: result.status,
            body: result.body,
            date: typeof result.date === 'string' ? result.date : '',
            xboxError: typeof result.xboxError === 'string' ? result.xboxError : '',
            cookies: typeof result.cookies === 'string' ? result.cookies : '',
        };
    }
}
