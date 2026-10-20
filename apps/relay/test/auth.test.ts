import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { authTarget } from '../src/auth.js';
import type { AuthForwarder } from '../src/auth.js';
import { createRelay } from '../src/server.js';

async function fixture(context: TestContext, forward: AuthForwarder) {
    const relay = createRelay({
        origins: new Set(['http://localhost:5173']),
        policy: {
            allowedHosts: new Set(),
            allowedPorts: new Set([19132]),
        },
        authForwarder: forward,
    });

    relay.server.listen(0, '127.0.0.1');
    await once(relay.server, 'listening');
    context.after(() => relay.close());

    return `http://127.0.0.1:${(relay.server.address() as AddressInfo).port}/auth`;
}

test('auth proxy forwards only fixed provider endpoints and never sets a browser token cookie', async (context) => {
    const url = await fixture(context, async (target) => {
        assert.equal(target.url.href, 'https://login.live.com/oauth20_token.srf');
        assert.equal(target.method, 'POST');
        assert.equal(target.body, 'grant_type=refresh_token&refresh_token=fixture');
        assert.equal(target.headers.Cookie, 'session=fixture');

        return {
            status: 200,
            body: '{"access_token":"fixture-access"}',
            date: 'Tue, 20 Oct 2026 16:00:00 GMT',
            xboxError: '',
            cookies: 'session=updated',
        };
    });

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            Origin: 'http://localhost:5173',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            operation: 'live-token',
            body: 'grant_type=refresh_token&refresh_token=fixture',
            cookies: 'session=fixture',
            url: 'http://127.0.0.1/private',
        }),
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    assert.equal((await response.json()).status, 200);
});

test('auth proxy rejects foreign origins and unsupported operations without forwarding', async (context) => {
    let forwarded = false;
    const url = await fixture(context, async () => {
        forwarded = true;
        throw new Error('This request must not be forwarded.');
    });

    const denied = await fetch(url, {
        method: 'POST',
        headers: {
            Origin: 'https://untrusted.example',
            'Content-Type': 'application/json',
        },
        body: '{}',
    });

    assert.equal(denied.status, 403);

    const unsupported = await fetch(url, {
        method: 'POST',
        headers: {
            Origin: 'http://localhost:5173',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            operation: 'proxy',
            url: 'https://untrusted.example',
        }),
    });

    assert.equal(unsupported.status, 400);
    assert.equal(forwarded, false);
});

test('auth route validation rejects header injection and untrusted service destinations', () => {
    assert.throws(() =>
        authTarget({
            operation: 'xbox-device',
            signature: 'fixture\r\nAuthorization: stolen',
            body: '{}',
        }),
    );

    assert.throws(() =>
        authTarget({
            operation: 'playfab',
            titleId: 'example.com/private',
            body: '{}',
        }),
    );

    assert.throws(() =>
        authTarget({
            operation: 'profile',
            xuid: '../private',
            authorization: 'fixture',
        }),
    );

    const target = authTarget({
        operation: 'service-start',
        body: '{}',
    });

    assert.equal(
        target.url.href,
        'https://authorization.franchise.minecraft-services.net/api/v1.0/session/start',
    );
});

test('auth proxy errors do not expose provider bodies, credentials, or exception details', async (context) => {
    const url = await fixture(context, async () => {
        throw new Error('fixture-secret-access-token');
    });

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            Origin: 'http://localhost:5173',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            operation: 'device-code',
            body: 'client_id=fixture',
        }),
    });

    assert.equal(response.status, 502);
    assert.equal((await response.text()).includes('fixture-secret'), false);
});
