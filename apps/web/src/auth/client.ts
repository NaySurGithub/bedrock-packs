import { base64, jwtClaims, publicProof, signXboxRequest } from './crypto.js';
import type { AuthRequest, AuthResponse, AuthTransport } from './transport.js';
import type { AccountStore } from './vault.js';
import type {
    AccountSession,
    AccountState,
    AuthConfig,
    LiveToken,
    MinecraftIdentity,
    XboxToken,
} from './types.js';

const liveScope = 'service::user.auth.xboxlive.com::MBI_SSL';
const multiplayerParty = 'https://multiplayer.minecraft.net/';
const profileParty = 'http://xboxlive.com';
const playFabParty = 'http://playfab.xboxlive.com/';
const authorizationService = 'https://authorization.franchise.minecraft-services.net';

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('The authentication service returned an invalid response.');
    }

    return value as Record<string, unknown>;
}

function requiredText(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error('The authentication service returned an incomplete response.');
    }

    return value;
}

function expiry(value: unknown): number {
    const parsed = typeof value === 'string' ? Date.parse(value) : NaN;

    if (!Number.isFinite(parsed)) {
        throw new Error('The authentication service returned an invalid expiration date.');
    }

    return parsed;
}

export function waitForPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const abort = () => {
            clearTimeout(timer);
            reject(new DOMException('Sign-in cancelled.', 'AbortError'));
        };

        const timer = setTimeout(() => {
            signal.removeEventListener('abort', abort);
            resolve();
        }, milliseconds);

        signal.addEventListener('abort', abort, {
            once: true,
        });

        if (signal.aborted) {
            abort();
        }
    });
}

class SignInRequired extends Error {}

interface ClientOptions {
    config: AuthConfig;
    store: AccountStore;
    transport: AuthTransport;
    now?: () => number;
    wait?: typeof waitForPoll;
    broadcast?: boolean;
}

export class AccountClient {
    #config: AuthConfig;
    #store: AccountStore;
    #transport: AuthTransport;
    #now: () => number;
    #wait: typeof waitForPoll;
    #state: AccountState = { status: 'restoring' };
    #listeners = new Set<(state: AccountState) => void>();
    #controller = new AbortController();
    #generation = 0;
    #session: AccountSession | undefined;
    #epoch = '';
    #timeDelta = 0;
    #refreshTimer: ReturnType<typeof setTimeout> | undefined;
    #channel: BroadcastChannel | undefined;

    constructor(options: ClientOptions) {
        this.#config = options.config;
        this.#store = options.store;
        this.#transport = options.transport;
        this.#now = options.now ?? Date.now;
        this.#wait = options.wait ?? waitForPoll;

        if (options.broadcast !== false && typeof BroadcastChannel !== 'undefined') {
            this.#channel = new BroadcastChannel('bedrock-packs-account');
            this.#channel.onmessage = (event: MessageEvent<unknown>) => {
                if (event.data === 'signed-out') {
                    this.cancel();
                    this.#session = undefined;
                    this.#setState({
                        status: 'signed-out',
                    });
                }
            };
        }
    }

    subscribe(listener: (state: AccountState) => void): () => void {
        this.#listeners.add(listener);
        listener(this.#state);

        return () => this.#listeners.delete(listener);
    }

    #setState(state: AccountState): void {
        this.#state = state;

        for (const listener of this.#listeners) {
            listener(state);
        }
    }

    #valid(expiresAt: number): boolean {
        return Number.isFinite(expiresAt) && expiresAt > this.#now() + this.#timeDelta + 60000;
    }

    #begin(): { generation: number; signal: AbortSignal } {
        this.cancel();
        this.#controller = new AbortController();

        return {
            generation: this.#generation,
            signal: this.#controller.signal,
        };
    }

    #assertActive(generation: number, signal: AbortSignal): void {
        signal.throwIfAborted();

        if (generation !== this.#generation) {
            throw new DOMException('Sign-in cancelled.', 'AbortError');
        }
    }

    async #request(input: AuthRequest, signal: AbortSignal): Promise<AuthResponse> {
        signal.throwIfAborted();
        const response = await this.#transport.request(input, signal);
        signal.throwIfAborted();

        const serverTime = Date.parse(response.date);

        if (Number.isFinite(serverTime)) {
            this.#timeDelta = serverTime - this.#now();
        }

        return response;
    }

    #json(response: AuthResponse): Record<string, unknown> {
        try {
            return object(JSON.parse(response.body));
        } catch {
            throw new Error('The authentication service returned an invalid response.');
        }
    }

    #requireSuccess(response: AuthResponse, service: string): Record<string, unknown> {
        if (response.status < 200 || response.status >= 300) {
            const xboxErrors: Record<string, string> = {
                '2148916227': 'This Xbox account is banned.',
                '2148916229': 'Online play requires approval from your family organizer.',
                '2148916233': 'Create an Xbox profile for this Microsoft account, then try again.',
                '2148916234': 'Accept the Xbox terms of service, then try again.',
                '2148916235': 'Xbox services are unavailable for this account region.',
                '2148916236': 'Microsoft requires age verification for this account.',
                '2148916237': 'This account has reached its allowed playtime.',
                '2148916238': 'Add this child account to a Microsoft family before playing online.',
            };

            throw new Error(
                xboxErrors[response.xboxError] ??
                    `${service} rejected sign-in (HTTP ${response.status}).`,
            );
        }

        return this.#json(response);
    }

    #liveToken(result: Record<string, unknown>, previousRefresh = ''): LiveToken {
        const lifetime = Number(result.expires_in);

        if (!Number.isFinite(lifetime) || lifetime <= 60) {
            throw new Error('Microsoft returned an expired access token.');
        }

        return {
            accessToken: requiredText(result.access_token),
            refreshToken:
                typeof result.refresh_token === 'string' && result.refresh_token
                    ? result.refresh_token
                    : requiredText(previousRefresh),
            expiresAt: this.#now() + this.#timeDelta + lifetime * 1000,
        };
    }

    async #deviceCode(signal: AbortSignal): Promise<LiveToken> {
        const response = await this.#request(
            {
                operation: 'device-code',
                body: new URLSearchParams({
                    client_id: this.#config.clientId,
                    scope: liveScope,
                    response_type: 'device_code',
                }).toString(),
            },
            signal,
        );

        const result = this.#requireSuccess(response, 'Microsoft');
        const deviceCode = requiredText(result.device_code);
        const verification = new URL(requiredText(result.verification_uri));

        if (
            verification.protocol !== 'https:' ||
            !['microsoft.com', 'www.microsoft.com', 'login.live.com'].includes(
                verification.hostname,
            ) ||
            verification.username ||
            verification.password
        ) {
            throw new Error('Microsoft returned an unsupported verification address.');
        }

        const suppliedInterval = Number(result.interval);
        let interval =
            Number.isFinite(suppliedInterval) && suppliedInterval > 0
                ? Math.min(Math.max(suppliedInterval, 1), 60) * 1000
                : 5000;
        const lifetime = Math.min(Math.max(Number(result.expires_in) || 900, 1), 1800);
        const expiresAt = this.#now() + lifetime * 1000;
        let cookies = response.cookies;

        this.#setState({
            status: 'device-code',
            device: {
                code: requiredText(result.user_code),
                verificationUri: verification.href,
                expiresAt,
            },
        });

        while (this.#now() < expiresAt) {
            await this.#wait(Math.min(interval, expiresAt - this.#now()), signal);

            if (this.#now() >= expiresAt) {
                break;
            }

            let poll: AuthResponse;

            try {
                poll = await this.#request(
                    {
                        operation: 'live-token',
                        cookies,
                        body: new URLSearchParams({
                            client_id: this.#config.clientId,
                            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                            device_code: deviceCode,
                        }).toString(),
                    },
                    signal,
                );
            } catch {
                signal.throwIfAborted();
                interval = Math.min(interval * 2, 60000);
                continue;
            }

            if (poll.cookies) {
                const merged = new Map<string, string>();

                for (const cookie of `${cookies}; ${poll.cookies}`.split('; ')) {
                    const separator = cookie.indexOf('=');

                    if (separator > 0) {
                        merged.set(cookie.slice(0, separator), cookie.slice(separator + 1));
                    }
                }

                cookies = [...merged].map(([name, value]) => `${name}=${value}`).join('; ');
            }

            if (poll.status === 429 || poll.status >= 500) {
                interval = Math.min(interval + 5000, 60000);
                continue;
            }

            const token = this.#json(poll);

            if (poll.status === 200 && token.access_token) {
                return this.#liveToken(token);
            }

            if (token.error === 'authorization_pending') {
                continue;
            }

            if (token.error === 'slow_down') {
                interval += 5000;
                continue;
            }

            if (token.error === 'authorization_declined' || token.error === 'access_denied') {
                throw new Error('Microsoft sign-in was declined.');
            }

            if (token.error === 'expired_token' || token.error === 'code_expired') {
                break;
            }

            throw new Error(
                'Microsoft rejected this sign-in session. Start again and complete all approval steps.',
            );
        }

        throw new Error('The sign-in code expired. Start again to get a new code.');
    }

    async #refreshLive(session: AccountSession, signal: AbortSignal): Promise<void> {
        if (this.#valid(session.live.expiresAt)) {
            return;
        }

        const response = await this.#request(
            {
                operation: 'live-token',
                body: new URLSearchParams({
                    client_id: this.#config.clientId,
                    scope: liveScope,
                    grant_type: 'refresh_token',
                    refresh_token: session.live.refreshToken,
                }).toString(),
            },
            signal,
        );

        const result = this.#json(response);

        if (
            ['invalid_grant', 'interaction_required', 'invalid_token'].includes(
                String(result.error),
            )
        ) {
            throw new SignInRequired('Your Microsoft session expired. Sign in again.');
        }

        this.#requireSuccess(response, 'Microsoft');
        session.live = this.#liveToken(result, session.live.refreshToken);
    }

    async #xbox(
        session: AccountSession,
        relyingParty: string,
        signal: AbortSignal,
    ): Promise<XboxToken> {
        const cacheKey = relyingParty.replace(/\/+$/, '');
        const cached = session.xbox[cacheKey];

        if (cached && this.#valid(cached.expiresAt)) {
            return cached;
        }

        await this.#refreshLive(session, signal);
        const pair = await this.#store.keyPair('xbox-proof', 'P-256');
        const proof = await publicProof(pair.publicKey);

        if (
            !session.device ||
            !this.#valid(session.device.expiresAt) ||
            session.device.publicX !== proof.x
        ) {
            const body = JSON.stringify({
                Properties: {
                    AuthMethod: 'ProofOfPossession',
                    DeviceType: this.#config.deviceType,
                    Id: `{${session.deviceId}}`,
                    ProofKey: proof,
                    Version: this.#config.deviceVersion,
                },
                RelyingParty: 'http://auth.xboxlive.com',
                TokenType: 'JWT',
            });

            const response = await this.#request(
                {
                    operation: 'xbox-device',
                    body,
                    signature: await signXboxRequest(
                        pair.privateKey,
                        '/device/authenticate',
                        body,
                        this.#now() + this.#timeDelta,
                    ),
                },
                signal,
            );

            const device = this.#requireSuccess(response, 'Xbox device authentication');
            session.device = {
                token: requiredText(device.Token),
                expiresAt: expiry(device.NotAfter),
                publicX: requiredText(proof.x),
            };
        }

        const body = JSON.stringify({
            AccessToken: `t=${session.live.accessToken}`,
            AppId: this.#config.clientId,
            DeviceToken: session.device.token,
            ProofKey: proof,
            RelyingParty: relyingParty,
            Sandbox: 'RETAIL',
            SiteName: 'user.auth.xboxlive.com',
            UseModernGamertag: true,
        });

        const response = await this.#request(
            {
                operation: 'xbox-authorize',
                body,
                signature: await signXboxRequest(
                    pair.privateKey,
                    '/authorize',
                    body,
                    this.#now() + this.#timeDelta,
                ),
            },
            signal,
        );

        const result = this.#requireSuccess(response, 'Xbox');
        const authorization = object(result.AuthorizationToken);
        const claims = object(authorization.DisplayClaims);
        const users = claims.xui;

        if (!Array.isArray(users) || users.length === 0) {
            throw new Error('Xbox did not return an account profile.');
        }

        const user = object(users[0]);
        const token: XboxToken = {
            token: requiredText(authorization.Token),
            userHash: requiredText(user.uhs),
            xuid: typeof user.xid === 'string' ? user.xid : '',
            gamertag: typeof user.gtg === 'string' ? user.gtg : '',
            expiresAt: expiry(authorization.NotAfter),
        };

        if (!this.#valid(token.expiresAt)) {
            throw new Error('Xbox returned an expired authorization token.');
        }

        session.xbox[cacheKey] = token;
        return token;
    }

    #authorization(token: XboxToken): string {
        return `XBL3.0 x=${token.userHash};${token.token}`;
    }

    async #service(session: AccountSession, signal: AbortSignal): Promise<void> {
        if (session.service && this.#valid(session.service.expiresAt)) {
            return;
        }

        const discovery = this.#requireSuccess(
            await this.#request(
                {
                    operation: 'discovery',
                    gameVersion: this.#config.gameVersion,
                },
                signal,
            ),
            'Minecraft discovery',
        );

        const environment = object(
            object(object(object(discovery.result).serviceEnvironments).auth).prod,
        );

        if (environment.serviceUri !== authorizationService) {
            throw new Error('Minecraft returned an unsupported authorization service.');
        }

        const titleId = requiredText(environment.playfabTitleId);
        const xbox = await this.#xbox(session, playFabParty, signal);
        const playFab = this.#requireSuccess(
            await this.#request(
                {
                    operation: 'playfab',
                    titleId,
                    body: JSON.stringify({
                        TitleId: titleId,
                        CreateAccount: true,
                        XboxToken: this.#authorization(xbox),
                    }),
                },
                signal,
            ),
            'PlayFab',
        );

        const user = {
            language: 'en',
            languageCode: 'en-US',
            regionCode: 'US',
            token: requiredText(object(playFab.data).SessionTicket),
            tokenType: 'PlayFab',
        };

        const startSession = () =>
            this.#request(
                {
                    operation: 'service-start',
                    body: JSON.stringify({
                        device: {
                            applicationType: 'MinecraftPE',
                            capabilities: [],
                            gameVersion: this.#config.gameVersion,
                            id: session.deviceId,
                            memory: '17179869184',
                            platform: 'Windows10',
                            playFabTitleId: titleId,
                            storePlatform: 'uwp.store',
                            type: 'Windows10',
                        },
                        user,
                    }),
                },
                signal,
            );

        let response: AuthResponse;

        if (session.service) {
            response = await this.#request(
                {
                    operation: 'service-renew',
                    authorization: session.service.authorization,
                    body: JSON.stringify(user),
                },
                signal,
            );

            if (response.status === 401 || response.status === 403) {
                response = await startSession();
            }
        } else {
            response = await startSession();
        }

        const result = object(this.#requireSuccess(response, 'Minecraft session').result);
        session.service = {
            authorization: requiredText(result.authorizationHeader),
            expiresAt: expiry(result.validUntil),
            titleId,
        };

        if (!this.#valid(session.service.expiresAt)) {
            throw new Error('Minecraft returned an expired session.');
        }
    }

    async #minecraft(session: AccountSession, signal: AbortSignal): Promise<MinecraftIdentity> {
        await this.#service(session, signal);

        const pair = await this.#store.keyPair('minecraft-connection', 'P-384');
        const publicKey = base64(
            new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)),
        );

        if (
            session.minecraft?.publicKey === publicKey &&
            this.#valid(session.minecraft.expiresAt)
        ) {
            return session.minecraft;
        }
        const multiplayer = object(
            this.#requireSuccess(
                await this.#request(
                    {
                        operation: 'multiplayer',
                        authorization: session.service!.authorization,
                        body: JSON.stringify({
                            publicKey,
                        }),
                    },
                    signal,
                ),
                'Minecraft multiplayer',
            ).result,
        );

        const multiplayerToken = requiredText(multiplayer.signedToken);
        const xbox = await this.#xbox(session, multiplayerParty, signal);
        const chainResponse = this.#requireSuccess(
            await this.#request(
                {
                    operation: 'chain',
                    authorization: this.#authorization(xbox),
                    gameVersion: this.#config.gameVersion,
                    body: JSON.stringify({
                        identityPublicKey: publicKey,
                    }),
                },
                signal,
            ),
            'Minecraft identity',
        );

        if (
            !Array.isArray(chainResponse.chain) ||
            chainResponse.chain.length < 2 ||
            !chainResponse.chain.every((token) => typeof token === 'string')
        ) {
            throw new Error('Minecraft returned an invalid identity chain.');
        }

        const chain = chainResponse.chain as string[];
        const identity = object(jwtClaims(chain[1]!).extraData);

        const expectedXuid = session.profile?.xuid || xbox.xuid;

        if (identity.XUID && expectedXuid && identity.XUID !== expectedXuid) {
            throw new Error('Minecraft returned an identity for a different Xbox account.');
        }

        const expiresAt = Math.min(
            expiry(multiplayer.validUntil),
            ...chain.map((token) => Number(jwtClaims(token).exp) * 1000).filter(Number.isFinite),
        );

        if (!this.#valid(expiresAt)) {
            throw new Error('Minecraft returned an expired identity.');
        }

        session.minecraft = {
            publicKey,
            multiplayerToken,
            chain,
            identity: requiredText(identity.identity),
            playFabId: String(jwtClaims(multiplayerToken).mid ?? '').toLowerCase(),
            expiresAt,
        };

        return session.minecraft;
    }

    async #complete(
        session: AccountSession,
        generation: number,
        signal: AbortSignal,
    ): Promise<void> {
        this.#setState({
            status: 'connecting',
            message: 'Signing in to Xbox…',
        });

        await this.#refreshLive(session, signal);
        this.#assertActive(generation, signal);
        await this.#store.save(session, this.#epoch);

        const multiplayer = await this.#xbox(session, multiplayerParty, signal);
        const profile = await this.#xbox(session, profileParty, signal);
        let gamertag = profile.gamertag || multiplayer.gamertag;
        const accountXuid = profile.xuid || multiplayer.xuid;

        if (!/^\d{1,20}$/.test(accountXuid)) {
            throw new Error('Xbox did not return an account identifier.');
        }

        if (!gamertag) {
            const response = this.#requireSuccess(
                await this.#request(
                    {
                        operation: 'profile',
                        authorization: this.#authorization(profile),
                        xuid: accountXuid,
                    },
                    signal,
                ),
                'Xbox profile',
            );

            const profiles = response.profileUsers;

            if (Array.isArray(profiles) && profiles[0]) {
                const settings = object(profiles[0]).settings;

                if (Array.isArray(settings)) {
                    const setting = settings.map(object).find((entry) => entry.id === 'Gamertag');
                    gamertag = setting ? String(setting.value ?? '') : '';
                }
            }
        }

        session.profile = {
            gamertag: gamertag || accountXuid,
            xuid: accountXuid,
        };

        this.#setState({
            status: 'connecting',
            message: 'Preparing Minecraft session…',
        });

        await this.#minecraft(session, signal);
        this.#assertActive(generation, signal);
        await this.#store.save(session, this.#epoch);
        this.#assertActive(generation, signal);

        this.#session = session;
        this.#setState({
            status: 'signed-in',
            ...session.profile,
        });

        const refreshAt = Math.min(
            session.live.expiresAt,
            multiplayer.expiresAt,
            profile.expiresAt,
            session.service!.expiresAt,
            session.minecraft!.expiresAt,
        );

        this.#refreshTimer = setTimeout(
            () => {
                void this.refresh();
            },
            Math.min(Math.max(refreshAt - this.#now() - this.#timeDelta - 60000, 1000), 3600000),
        );
    }

    async #failure(error: unknown, generation: number, signal: AbortSignal): Promise<void> {
        if (signal.aborted || generation !== this.#generation) {
            return;
        }

        if (error instanceof SignInRequired) {
            await this.#store.clear();
            this.#session = undefined;
            this.#channel?.postMessage('signed-out');
        }

        this.#setState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Sign-in failed. Try again.',
        });
    }

    async restore(): Promise<void> {
        const { generation, signal } = this.#begin();

        this.#setState({
            status: 'restoring',
        });

        try {
            const restore = async () => {
                const stored = await this.#store.read();
                this.#assertActive(generation, signal);
                this.#epoch = stored.epoch;

                if (!stored.session || stored.session.clientId !== this.#config.clientId) {
                    this.#setState({
                        status: 'signed-out',
                    });
                    return;
                }

                await this.#complete(stored.session, generation, signal);
            };

            if (typeof navigator !== 'undefined' && navigator.locks) {
                await navigator.locks.request(
                    'bedrock-packs-account-refresh',
                    {
                        signal,
                    },
                    restore,
                );
            } else {
                await restore();
            }
        } catch (error: unknown) {
            await this.#failure(error, generation, signal);
        }
    }

    async signIn(): Promise<void> {
        const { generation, signal } = this.#begin();

        this.#setState({
            status: 'connecting',
            message: 'Requesting a Microsoft sign-in code…',
        });

        try {
            await this.#store.clear();
            this.#session = undefined;
            this.#channel?.postMessage('signed-out');
            const stored = await this.#store.read();
            this.#epoch = stored.epoch;

            const live = await this.#deviceCode(signal);
            this.#assertActive(generation, signal);

            await this.#complete(
                {
                    version: 1,
                    clientId: this.#config.clientId,
                    deviceId: crypto.randomUUID(),
                    live,
                    xbox: {},
                },
                generation,
                signal,
            );
        } catch (error: unknown) {
            await this.#failure(error, generation, signal);
        }
    }

    async refresh(): Promise<void> {
        if (this.#state.status === 'signed-in') {
            await this.restore();
        }
    }

    async minecraftIdentity(): Promise<MinecraftIdentity> {
        if (!this.#session || this.#state.status !== 'signed-in') {
            throw new Error('Sign in with Microsoft first.');
        }

        await this.refresh();

        if (!this.#session?.minecraft || this.#state.status !== 'signed-in') {
            throw new Error('The Minecraft session could not be refreshed. Sign in again.');
        }

        return structuredClone(this.#session.minecraft);
    }

    async connectionIdentity(): Promise<{
        identity: MinecraftIdentity;
        gamertag: string;
        xuid: string;
        deviceId: string;
        deviceType: string;
        sign(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>>;
        agree(publicKey: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>>;
    }> {
        const identity = await this.minecraftIdentity();
        const epoch = this.#generation;
        const pair = await this.#store.keyPair('minecraft-connection', 'P-384');
        const agreement = await this.#store.agreementKey?.('minecraft-connection');

        if (!agreement || !this.#session?.profile) {
            throw new Error('The Minecraft connection key is unavailable. Sign in again.');
        }

        const assertActive = () => {
            if (epoch !== this.#generation || this.#state.status !== 'signed-in') {
                throw new Error('The Microsoft session changed. Reconnect to the server.');
            }
        };

        return {
            identity,
            gamertag: this.#session.profile.gamertag,
            xuid: this.#session.profile.xuid,
            deviceId: this.#session.deviceId,
            deviceType: this.#config.deviceType,
            async sign(data) {
                assertActive();
                const signature = await crypto.subtle.sign(
                    { name: 'ECDSA', hash: 'SHA-384' },
                    pair.privateKey,
                    data,
                );
                assertActive();
                return new Uint8Array(signature);
            },
            async agree(publicKey) {
                assertActive();
                const remote = await crypto.subtle.importKey(
                    'spki',
                    publicKey,
                    { name: 'ECDH', namedCurve: 'P-384' },
                    false,
                    [],
                );
                const secret = await crypto.subtle.deriveBits(
                    { name: 'ECDH', public: remote },
                    agreement,
                    384,
                );
                assertActive();
                return new Uint8Array(secret);
            },
        };
    }

    cancel(): void {
        this.#generation++;
        this.#controller.abort();
        clearTimeout(this.#refreshTimer);

        if (this.#state.status === 'device-code' || this.#state.status === 'connecting') {
            this.#setState(
                this.#session?.profile
                    ? {
                          status: 'signed-in',
                          ...this.#session.profile,
                      }
                    : {
                          status: 'signed-out',
                      },
            );
        }
    }

    async signOut(): Promise<void> {
        this.cancel();
        this.#session = undefined;
        await this.#store.clear();
        this.#channel?.postMessage('signed-out');
        this.#setState({
            status: 'signed-out',
        });
    }

    dispose(): void {
        this.cancel();
        this.#session = undefined;
        this.#channel?.close();
        this.#listeners.clear();
    }
}
