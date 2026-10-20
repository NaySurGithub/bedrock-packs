import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { AccountClient, waitForPoll } from '../apps/web/src/auth/client.js';
import type { AccountStore } from '../apps/web/src/auth/vault.js';
import type { AuthRequest, AuthResponse, AuthTransport } from '../apps/web/src/auth/transport.js';
import type { AccountSession, AccountState, AuthConfig } from '../apps/web/src/auth/types.js';

const configuration: AuthConfig = {
    clientId: '0000000048183522',
    deviceType: 'Android',
    deviceVersion: '8.0.0',
    userAgent: 'XAL Android 2020.07.20200714.000',
    gameVersion: '1.26.52',
};

class MemoryAccountStore implements AccountStore {
    session: AccountSession | undefined;
    epoch = crypto.randomUUID();
    keys = new Map<string, CryptoKeyPair>();

    async read() {
        return {
            session: structuredClone(this.session),
            epoch: this.epoch,
        };
    }

    async save(session: AccountSession, epoch: string) {
        assert.equal(epoch, this.epoch);
        this.session = structuredClone(session);
    }

    async keyPair(name: string, namedCurve: 'P-256' | 'P-384') {
        let pair = this.keys.get(name);

        if (!pair) {
            pair = await crypto.subtle.generateKey(
                {
                    name: 'ECDSA',
                    namedCurve,
                },
                false,
                ['sign', 'verify'],
            );

            this.keys.set(name, pair);
        }

        return pair;
    }

    async clear() {
        this.session = undefined;
        this.keys.clear();
        this.epoch = crypto.randomUUID();
    }
}

function fixture(context: TestContext, store = new MemoryAccountStore()) {
    let now = Date.UTC(2026, 9, 20, 16);
    const calls: AuthRequest[] = [];
    const waits: number[] = [];
    const pendingErrors: Array<string | Error> = [];
    let refreshRejected = false;

    function response(body: unknown, status = 200): AuthResponse {
        return {
            status,
            body: JSON.stringify(body),
            date: new Date(now).toUTCString(),
            xboxError: '',
            cookies: '',
        };
    }

    function token(payload: unknown): string {
        return `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.fixture-signature`;
    }

    async function verifySignature(input: AuthRequest, path: string, proof: JsonWebKey) {
        const signature = Buffer.from(input.signature!, 'base64');
        assert.equal(signature.length, 76);
        assert.equal(signature.readUInt32BE(0), 1);
        assert.equal(
            signature.readBigUInt64BE(4),
            (BigInt(Math.floor(now / 1000)) + 11644473600n) * 10000000n,
        );

        const publicKey = await crypto.subtle.importKey(
            'jwk',
            proof,
            {
                name: 'ECDSA',
                namedCurve: 'P-256',
            },
            false,
            ['verify'],
        );

        const message = Buffer.concat([
            signature.subarray(0, 4),
            Buffer.from([0]),
            signature.subarray(4, 12),
            Buffer.from(`\0POST\0${path}\0\0${input.body}\0`),
        ]);

        assert.equal(
            await crypto.subtle.verify(
                {
                    name: 'ECDSA',
                    hash: 'SHA-256',
                },
                publicKey,
                signature.subarray(12),
                message,
            ),
            true,
        );
    }

    const transport: AuthTransport = {
        async request(input, signal) {
            signal.throwIfAborted();
            calls.push(input);
            const validUntil = new Date(now + 3600000).toISOString();

            switch (input.operation) {
                case 'device-code':
                    return {
                        ...response({
                            user_code: 'ABCD-EFGH',
                            device_code: 'fixture-device-code',
                            verification_uri: 'https://www.microsoft.com/link',
                            interval: 1,
                            expires_in: 60,
                        }),
                        cookies: 'session=fixture',
                    };

                case 'live-token': {
                    const form = new URLSearchParams(input.body);

                    if (form.get('grant_type') === 'refresh_token') {
                        if (refreshRejected) {
                            return response({ error: 'invalid_grant' }, 400);
                        }

                        assert.equal(form.get('refresh_token'), 'fixture-refresh');
                        return response({
                            access_token: 'renewed-access',
                            refresh_token: 'rotated-refresh',
                            expires_in: 3600,
                        });
                    }

                    assert.equal(input.cookies, 'session=fixture');
                    const pending = pendingErrors.shift();

                    if (pending instanceof Error) {
                        throw pending;
                    }

                    if (pending) {
                        return response({ error: pending }, 400);
                    }

                    return response({
                        access_token: 'fixture-access',
                        refresh_token: 'fixture-refresh',
                        expires_in: 3600,
                    });
                }

                case 'xbox-device': {
                    const body = JSON.parse(input.body!);
                    assert.equal(body.Properties.AuthMethod, 'ProofOfPossession');
                    assert.equal(body.Properties.DeviceType, 'Android');
                    await verifySignature(input, '/device/authenticate', body.Properties.ProofKey);

                    return response({
                        Token: 'fixture-device-token',
                        NotAfter: new Date(now + 86400000).toISOString(),
                    });
                }

                case 'xbox-authorize': {
                    const body = JSON.parse(input.body!);
                    assert.equal(body.AccessToken, 't=fixture-access');
                    assert.equal(body.DeviceToken, 'fixture-device-token');
                    await verifySignature(input, '/authorize', body.ProofKey);

                    return response({
                        AuthorizationToken: {
                            Token: `fixture-xsts:${body.RelyingParty}`,
                            NotAfter: new Date(now + 86400000).toISOString(),
                            DisplayClaims: {
                                xui: [
                                    {
                                        gtg: 'FixturePlayer',
                                        xid: '123456789',
                                        uhs: 'fixture-hash',
                                    },
                                ],
                            },
                        },
                    });
                }

                case 'discovery':
                    return response({
                        result: {
                            serviceEnvironments: {
                                auth: {
                                    prod: {
                                        serviceUri:
                                            'https://authorization.franchise.minecraft-services.net',
                                        playfabTitleId: '20CA2',
                                    },
                                },
                            },
                        },
                    });

                case 'playfab': {
                    const body = JSON.parse(input.body!);
                    assert.equal(body.TitleId, '20CA2');
                    assert.equal(
                        body.XboxToken,
                        'XBL3.0 x=fixture-hash;fixture-xsts:http://playfab.xboxlive.com/',
                    );

                    return response({
                        data: { SessionTicket: 'fixture-playfab-ticket' },
                    });
                }

                case 'service-start':
                case 'service-renew':
                    return response({
                        result: {
                            authorizationHeader: 'Bearer fixture-service-token',
                            validUntil,
                        },
                    });

                case 'multiplayer': {
                    const body = JSON.parse(input.body!);

                    await crypto.subtle.importKey(
                        'spki',
                        Buffer.from(body.publicKey, 'base64'),
                        {
                            name: 'ECDSA',
                            namedCurve: 'P-384',
                        },
                        false,
                        ['verify'],
                    );

                    return response({
                        result: {
                            signedToken: token({
                                mid: 'ABCDEF',
                                exp: Math.floor(now / 1000) + 3600,
                            }),
                            validUntil,
                        },
                    });
                }

                case 'chain':
                    return response({
                        chain: [
                            token({ exp: Math.floor(now / 1000) + 86400 }),
                            token({
                                exp: Math.floor(now / 1000) + 3600,
                                extraData: {
                                    identity: '00000000-0000-4000-8000-000000000001',
                                    XUID: '123456789',
                                },
                            }),
                        ],
                    });

                default:
                    throw new Error(`Unexpected fixture operation ${input.operation}.`);
            }
        },
    };

    const client = new AccountClient({
        config: configuration,
        store,
        transport,
        now: () => now,
        wait: async (milliseconds, signal) => {
            signal.throwIfAborted();
            waits.push(milliseconds);
            now += milliseconds;
        },
        broadcast: false,
    });

    let state: AccountState = { status: 'restoring' };
    const states: AccountState[] = [];

    client.subscribe((value) => {
        state = value;
        states.push(value);
    });

    context.after(() => client.dispose());

    return {
        client,
        store,
        calls,
        waits,
        pendingErrors,
        states,
        state: () => state,
        advance: (milliseconds: number) => {
            now += milliseconds;
        },
        rejectRefresh: () => {
            refreshRejected = true;
        },
    };
}

test('device-code sign-in obtains signed Xbox, PlayFab, and Minecraft credentials', async (context) => {
    const setup = fixture(context);
    setup.pendingErrors.push('authorization_pending', 'slow_down');

    await setup.client.signIn();

    assert.deepEqual(setup.state(), {
        status: 'signed-in',
        gamertag: 'FixturePlayer',
        xuid: '123456789',
    });
    assert.deepEqual(setup.waits, [1000, 1000, 6000]);
    assert.equal(Object.keys(setup.store.session!.xbox).length, 3);
    assert.equal(setup.store.session!.live.refreshToken, 'fixture-refresh');
    assert.equal(setup.store.session!.minecraft!.playFabId, 'abcdef');
    assert.equal(setup.store.session!.minecraft!.chain.length, 2);
    assert.equal(JSON.stringify(setup.states).includes('fixture-access'), false);
    assert.equal(JSON.stringify(setup.states).includes('fixture-device-code'), false);
});

test('restoring a valid encrypted session does not start another device-code flow', async (context) => {
    const setup = fixture(context);
    await setup.client.signIn();
    const before = setup.calls.length;

    await setup.client.restore();

    assert.equal(setup.calls.length, before);
    assert.equal(setup.state().status, 'signed-in');
});

test('expired access tokens refresh silently and rotated refresh tokens are saved', async (context) => {
    const setup = fixture(context);
    await setup.client.signIn();
    setup.advance(3600001);

    await setup.client.refresh();

    assert.equal(setup.state().status, 'signed-in');
    assert.equal(setup.store.session!.live.refreshToken, 'rotated-refresh');
    assert.equal(setup.calls.filter((call) => call.operation === 'device-code').length, 1);
    assert.equal(setup.calls.filter((call) => call.operation === 'service-renew').length, 1);
});

test('revoked refresh tokens clear the saved session without starting hidden sign-in', async (context) => {
    const setup = fixture(context);
    await setup.client.signIn();
    setup.advance(3600001);
    setup.rejectRefresh();

    await setup.client.refresh();

    assert.equal(setup.state().status, 'error');
    assert.equal(setup.store.session, undefined);
    assert.equal(setup.calls.filter((call) => call.operation === 'device-code').length, 1);
});

test('transient polling failures keep the same code and back off', async (context) => {
    const setup = fixture(context);
    setup.pendingErrors.push(new Error('Fixture network interruption.'));

    await setup.client.signIn();

    assert.equal(setup.state().status, 'signed-in');
    assert.deepEqual(setup.waits, [1000, 2000]);
    assert.equal(setup.calls.filter((call) => call.operation === 'device-code').length, 1);
});

test('cancelling the code dialog stops polling and does not save credentials', async (context) => {
    const setup = fixture(context);

    setup.client.subscribe((state) => {
        if (state.status === 'device-code') {
            setup.client.cancel();
        }
    });

    await setup.client.signIn();

    assert.equal(setup.state().status, 'signed-out');
    assert.equal(setup.store.session, undefined);
    assert.deepEqual(
        setup.calls.map((call) => call.operation),
        ['device-code'],
    );
});

test('sign-out removes cached tokens and private proof keys', async (context) => {
    const setup = fixture(context);
    await setup.client.signIn();
    assert.equal(setup.store.keys.size, 2);

    await setup.client.signOut();

    assert.equal(setup.state().status, 'signed-out');
    assert.equal(setup.store.keys.size, 0);
    assert.equal(setup.store.session, undefined);
});

test('poll waits are abortable', async () => {
    const controller = new AbortController();
    const waiting = waitForPoll(60000, controller.signal);
    controller.abort();

    await assert.rejects(waiting, { name: 'AbortError' });
});
