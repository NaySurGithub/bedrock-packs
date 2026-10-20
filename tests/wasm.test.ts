import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const moduleUrl = new URL('../apps/web/public/wasm/bedrock-packs.mjs', import.meta.url);
const wasmUrl = new URL('../apps/web/public/wasm/bedrock-packs.wasm', import.meta.url);
const generatedModule = await import(moduleUrl.href);
const native = await generatedModule.default({
    wasmBinary: await readFile(wasmUrl),
});

function readBuffer(length: number): Buffer {
    const pointer = native._bp_buffer();
    return Buffer.from(native.HEAPU8.slice(pointer, pointer + length));
}

function writeBuffer(data: Uint8Array): void {
    native.HEAPU8.set(data, native._bp_buffer());
}

function readOutput(pointer: number): string {
    const length = native._bp_output_size();
    return new TextDecoder().decode(native.HEAPU8.subarray(pointer, pointer + length));
}

test('Falcon bitstream encodes the RakNet ping fields', () => {
    const length = native._bp_build_ping(12345, 0x11223344, 0x55667788);
    const ping = readBuffer(length);

    assert.equal(length, 33);
    assert.equal(ping[0], 0x01);
    assert.equal(ping.readBigUInt64BE(1), 12345n);
    assert.equal(ping.readBigUInt64BE(25), 0x1122334455667788n);
    assert.equal(ping.subarray(9, 25).toString('hex'), '00ffff00fefefefefdfdfdfd12345678');
});

test('browser authentication configuration comes from Falcon Network', () => {
    const configuration = JSON.parse(readOutput(native._bp_auth_config()));

    assert.equal(configuration.clientId, '0000000048183522');
    assert.equal(configuration.deviceType, 'Android');
    assert.equal(configuration.deviceVersion, '8.0.0');
    assert.match(configuration.userAgent, /^XAL Android/);
});

test('Falcon-backed pong parser rejects malformed and unrelated responses', () => {
    const timestamp = 12345;
    const pingLength = native._bp_build_ping(timestamp, 0, 1);
    const ping = readBuffer(pingLength);
    const announcement = Buffer.from(
        'MCPE;Fixture;2193;1.26.52;1;20;1;Test;Survival;1;19132;19133;',
    );
    const pong = Buffer.alloc(35 + announcement.length);
    pong[0] = 0x1c;
    pong.writeBigUInt64BE(BigInt(timestamp), 1);
    pong.writeBigUInt64BE(1n, 9);
    ping.copy(pong, 17, 9, 25);
    pong.writeUInt16BE(announcement.length, 33);
    announcement.copy(pong, 35);
    writeBuffer(pong);

    assert.equal(native._bp_read_pong(pong.length, timestamp), announcement.length);
    assert.equal(native._bp_read_pong(pong.length, timestamp + 1), -2);
    assert.equal(native._bp_read_pong(34, timestamp), -1);
    assert.equal(native._bp_read_pong(pong.length - 1, timestamp), -4);

    pong[17] = 0xff;
    writeBuffer(pong);
    assert.equal(native._bp_read_pong(pong.length, timestamp), -3);
});

test('Falcon Protocol writes RequestNetworkSettings with its packet header', () => {
    const length = native._bp_network_settings(2193);
    const encoded = readBuffer(length);

    assert.equal(encoded.subarray(0, 2).toString('hex'), 'c101');
    assert.equal(encoded.readInt32BE(2), 2193);
    assert.equal(encoded.length, 6);
});

test('Falcon NetherNet signal codec preserves 64-bit IDs and SDP', () => {
    const signal = {
        type: 'CONNECTREQUEST',
        connectionId: '18446744073709551615',
        data: 'v=0\r\na=fingerprint:sha-256 AA:BB\r\n',
    };
    const input = Buffer.from(JSON.stringify(signal));
    writeBuffer(input);

    const encoded = readOutput(native._bp_encode_signal(input.length));
    assert.equal(encoded, `CONNECTREQUEST ${signal.connectionId} ${signal.data}`);

    const encodedBytes = Buffer.from(encoded);
    writeBuffer(encodedBytes);

    const decoded = readOutput(native._bp_decode_signal(encodedBytes.length));
    assert.deepEqual(JSON.parse(decoded), signal);
});

test('NetherNet boundary rejects overflowing IDs and unknown signal types', () => {
    for (const message of [
        'CONNECTREQUEST 18446744073709551616 v=0',
        'UNKNOWN 1 v=0',
        'CONNECTREQUEST invalid v=0',
    ]) {
        const input = Buffer.from(message);
        writeBuffer(input);
        assert.equal(readOutput(native._bp_decode_signal(input.length)), '');
    }
});
