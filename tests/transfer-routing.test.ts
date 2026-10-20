import assert from 'node:assert/strict';
import { test } from 'node:test';
import { followTransfers, transferTarget } from '../apps/web/src/connection/routing.js';
import type { EndpointResult, ServerTarget } from '../apps/web/src/connection/routing.js';

const initial = { host: 'entry.example.test', port: 19132 };

test('follows transfer chains sequentially using the new address and port', async () => {
    const opened: ServerTarget[] = [];
    const redirected: ServerTarget[] = [];
    let active = false;
    const destinations = [
        { host: 'lobby.example.test', port: 19133 },
        { host: 'game.example.test', port: 20000 },
    ];
    const results: EndpointResult[] = destinations.map((target) => ({ type: 'transfer', target }));
    results.push({ type: 'cancelled', message: 'Connection cancelled.' });
    const message = await followTransfers(
        initial,
        new AbortController().signal,
        async (target) => {
            assert(!active, 'the previous endpoint must finish before another opens');
            active = true;
            opened.push(target);
            await Promise.resolve();
            active = false;
            return results.shift()!;
        },
        (target, count) => {
            assert.equal(count, redirected.length + 1);
            redirected.push(target);
        },
    );
    assert.deepEqual(opened, [initial, ...destinations]);
    assert.deepEqual(redirected, destinations);
    assert.equal(message, 'Connection cancelled.');
});

test('errors at the transferred server retain the original disconnect reason', async () => {
    const reason = new Error('Server maintenance. Reconnect later.');
    let attempts = 0;
    await assert.rejects(
        followTransfers(
            initial,
            new AbortController().signal,
            async () => {
                if (++attempts === 1)
                    return { type: 'transfer', target: { host: 'game.example.test', port: 19132 } };
                return { type: 'error', error: reason };
            },
            () => {},
        ),
        (error) => error === reason,
    );
    assert.equal(attempts, 2);
});

test('cancellation prevents opening the transfer destination', async () => {
    const controller = new AbortController();
    let attempts = 0;
    await assert.rejects(
        followTransfers(
            initial,
            controller.signal,
            async () => {
                attempts++;
                controller.abort();
                return { type: 'transfer', target: { host: 'game.example.test', port: 19132 } };
            },
            () => assert.fail('no redirection should be published after cancellation'),
        ),
        /abort/i,
    );
    assert.equal(attempts, 1);
});

test('redirect loops stop after eight transfers', async () => {
    let attempts = 0;
    await assert.rejects(
        followTransfers(
            initial,
            new AbortController().signal,
            async () => {
                attempts++;
                return { type: 'transfer', target: initial };
            },
            () => {},
        ),
        /maximum 8/,
    );
    assert.equal(attempts, 9);
});

test('validates transfer hosts and ports and normalizes IPv6 literals', () => {
    assert.deepEqual(transferTarget('LOBBY.example.test', 19133), {
        host: 'lobby.example.test',
        port: 19133,
    });
    assert.deepEqual(transferTarget('[2001:4860:4860::8888]', 19132), {
        host: '2001:4860:4860::8888',
        port: 19132,
    });
    for (const host of [
        '',
        'https://example.test',
        'host/path',
        'user@host',
        'host:19132',
        'host\n.test',
    ]) {
        assert.throws(() => transferTarget(host, 19132), /invalid/i);
    }
    for (const port of [0, -1, 65536, 1.2, NaN])
        assert.throws(() => transferTarget(initial.host, port), /invalid/);
});
