import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { test } from 'node:test';
import { clientIp } from '../src/client-ip.js';

function request(forwarded?: string | string[]) {
    return {
        socket: { remoteAddress: '10.0.0.1' },
        headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
    } as unknown as IncomingMessage;
}

test('client IPs ignore X-Forwarded-For unless proxies are trusted', () => {
    assert.equal(clientIp(request('203.0.113.9')), '10.0.0.1');
    assert.equal(clientIp(request('203.0.113.9'), 0), '10.0.0.1');
});

test('trusted proxies select the entry they appended, not spoofed ones', () => {
    assert.equal(clientIp(request('198.51.100.7, 203.0.113.9'), 1), '203.0.113.9');
    assert.equal(clientIp(request(['198.51.100.7', '203.0.113.9, 10.1.1.1']), 2), '203.0.113.9');
    assert.equal(clientIp(request(), 1), '10.0.0.1');
    assert.equal(clientIp(request('203.0.113.9'), 3), '10.0.0.1');
});
