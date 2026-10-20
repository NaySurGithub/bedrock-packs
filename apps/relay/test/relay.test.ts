import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { createRelay } from '../src/server.js';
import { isPublicAddress, resolveTarget } from '../src/policy.js';

const origin = 'http://localhost:5173';

async function fixture(context: TestContext) {
    const udp = createSocket('udp4');
    udp.bind(0, '127.0.0.1');
    await once(udp, 'listening');

    const destinationPort = udp.address().port;
    const relay = createRelay({
        origins: new Set([origin]),
        policy: {
            allowedHosts: new Set(),
            allowedPorts: new Set([destinationPort]),
        },
        resolve: async () => ({
            address: '127.0.0.1',
            family: 4,
        }),
    });

    relay.server.listen(0, '127.0.0.1');
    await once(relay.server, 'listening');

    const relayPort = (relay.server.address() as AddressInfo).port;

    context.after(async () => {
        await relay.close();
        udp.close();
    });

    return {
        udp,
        relayPort,
        url: `ws://127.0.0.1:${relayPort}/relay?host=fixture.test&port=${destinationPort}`,
    };
}

test('destination policy rejects non-public address ranges', () => {
    for (const address of [
        '127.0.0.1',
        '10.1.2.3',
        '172.16.0.1',
        '192.168.1.1',
        '169.254.169.254',
        '100.64.0.1',
        '0.0.0.0',
        '224.0.0.1',
        '192.0.2.1',
        '::1',
        '::ffff:127.0.0.1',
        '::ffff:8.8.8.8',
        '64:ff9b::7f00:1',
        '2002:7f00:1::',
        'fc00::1',
        'fe80::1',
        '2001:db8::1',
        'not-an-address',
    ]) {
        assert.equal(isPublicAddress(address), false, address);
    }

    assert.equal(isPublicAddress('8.8.8.8'), true);
    assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('resolver enforces destination ports and exact host allowlists', async () => {
    const policy = {
        allowedHosts: new Set(['allowed.example']),
        allowedPorts: new Set([19132]),
    };

    await assert.rejects(resolveTarget('allowed.example', 53, policy), /port/);
    await assert.rejects(resolveTarget('other.example', 19132, policy), /host/);
    await assert.rejects(resolveTarget('allowed.example/path', 19132, policy), /address/);
    await assert.rejects(
        resolveTarget('127.0.0.1', 19132, {
            allowedHosts: new Set(),
            allowedPorts: new Set([19132]),
        }),
        /public/,
    );
});

test(
    'relay preserves datagram boundaries in both directions',
    { timeout: 10000 },
    async (context) => {
        const setup = await fixture(context);
        const client = new WebSocket(setup.url, {
            origin,
        });
        context.after(() => client.terminate());

        const [ready, binary] = await once(client, 'message');
        assert.equal(binary, false);
        assert.deepEqual(JSON.parse(ready.toString()), {
            type: 'ready',
            version: 1,
            transport: 'raknet',
            maxDatagram: 1492,
        });

        const first = Buffer.from([0x01, 0x00, 0xff]);
        const second = Buffer.from([0x02, 0x03]);
        const datagrams: Buffer[] = [];

        setup.udp.on('message', (data, remote) => {
            datagrams.push(data);
            setup.udp.send(data, remote.port, remote.address);
        });

        const responses: Buffer[] = [];
        const complete = new Promise<void>((resolve) => {
            client.on('message', (data, isBinary) => {
                assert.equal(isBinary, true);
                responses.push(data as Buffer);

                if (responses.length === 2) {
                    resolve();
                }
            });
        });

        client.send(first);
        client.send(second);
        await complete;

        assert.deepEqual(datagrams, [first, second]);
        assert.deepEqual(responses, [first, second]);
    },
);

test(
    'relay rejects foreign origins before opening a UDP connection',
    { timeout: 10000 },
    async (context) => {
        const setup = await fixture(context);
        const client = new WebSocket(setup.url, {
            origin: 'https://untrusted.example',
        });
        client.on('error', () => {});

        const [, response] = await once(client, 'unexpected-response');
        assert.equal(response.statusCode, 403);
        response.resume();
        client.terminate();
    },
);

test(
    'relay closes sessions receiving text instead of datagrams',
    { timeout: 10000 },
    async (context) => {
        const setup = await fixture(context);
        const client = new WebSocket(setup.url, {
            origin,
        });

        await once(client, 'message');
        const closed = once(client, 'close');
        client.send('not a datagram');
        await closed;
    },
);

test('health endpoint does not expose destination or session data', async (context) => {
    const setup = await fixture(context);
    const response = await fetch(`http://127.0.0.1:${setup.relayPort}/healthz`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
        status: 'ok',
    });
});

test(
    'relay detects NetherNet through GET /v1/join before trying RakNet',
    { timeout: 10000 },
    async (context) => {
        const setup = await fixture(context);
        const destinationPort = setup.udp.address().port;
        const expected = {
            name: 'NetherNet fixture',
            protocol: 2193,
            version: '1.26.52',
            level: 'Fixture world',
            players: 2,
            maxPlayers: 20,
        };
        let receivedDatagram = false;

        setup.udp.on('message', () => {
            receivedDatagram = true;
        });

        const endpoint = createServer((request, response) => {
            assert.equal(request.method, 'GET');
            assert.equal(request.url, '/v1/join');
            assert.equal(request.headers.host, `fixture.test:${destinationPort}`);

            response.writeHead(200, {
                'Content-Type': 'application/json',
            });
            response.end(JSON.stringify(expected));
        });

        endpoint.listen(destinationPort, '127.0.0.1');
        await once(endpoint, 'listening');

        context.after(
            () =>
                new Promise<void>((resolve) => {
                    endpoint.close(() => resolve());
                }),
        );

        const client = new WebSocket(setup.url, {
            origin,
        });
        context.after(() => client.terminate());

        const [message, binary] = await once(client, 'message');

        assert.equal(binary, false);
        assert.deepEqual(JSON.parse(message.toString()), {
            type: 'ready',
            version: 1,
            transport: 'nethernet',
            status: expected,
        });
        assert.equal(receivedDatagram, false);
    },
);
