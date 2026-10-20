import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { probeEndpoint } from '../src/probe.js';

test('NetherNet probe rejects unrelated, oversized, and redirect responses', async (context) => {
    let body = '{}';
    let statusCode = 200;

    const server = createServer((_request, response) => {
        response.writeHead(statusCode, {
            Location: 'http://127.0.0.1/secret',
        });
        response.end(body);
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    context.after(
        () =>
            new Promise<void>((resolve) => {
                server.close(() => resolve());
            }),
    );

    const port = (server.address() as AddressInfo).port;

    for (const invalidBody of ['{}', 'not json', '[]', 'x'.repeat(65537)]) {
        body = invalidBody;
        assert.equal(await probeEndpoint('127.0.0.1', 4, 'fixture.test', port), undefined);
    }

    body = '{"name":"Fixture","protocol":2193}';
    statusCode = 302;

    assert.equal(await probeEndpoint('127.0.0.1', 4, 'fixture.test', port), undefined);
});
