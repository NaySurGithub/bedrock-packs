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
    assert.equal(configuration.gameVersion, '1.26.60');
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

test('Disconnect packets preserve the server text and numeric reason, including hidden messages', () => {
    const writeString = (text: string) =>
        Buffer.concat([Buffer.from([Buffer.byteLength(text)]), Buffer.from(text)]);
    const decode = (packet: Buffer) => {
        writeBuffer(packet);
        return JSON.parse(readOutput(native._bp_packet_read(packet.length)));
    };
    const message = 'Server maintenance\nPlease reconnect later.';
    assert.deepEqual(
        decode(
            Buffer.concat([Buffer.from([5, 84, 0]), writeString(message), writeString('filtered')]),
        ),
        { type: 'disconnect', message, reason: 42 },
    );
    assert.deepEqual(decode(Buffer.from([5, 84, 1])), {
        type: 'disconnect',
        message: '',
        reason: 42,
    });
    assert.deepEqual(
        decode(
            Buffer.concat([
                Buffer.from([5, 0, 0]),
                writeString(''),
                writeString('Filtered reason'),
            ]),
        ),
        { type: 'disconnect', message: 'Filtered reason', reason: 0 },
    );
});

test('browser RakNet sends handshake datagrams and routes replies to the same normalized peer', () => {
    const bytes = (pointer: number) =>
        Buffer.from(native.HEAPU8.slice(pointer, pointer + native._bp_output_size()));
    const outgoing = () => {
        const packets: Buffer[] = [];
        for (;;) {
            const packet = bytes(native._bp_raknet_output());
            if (!packet.length) return packets;
            packets.push(packet);
        }
    };
    try {
        assert.equal(native._bp_raknet_start(19132), 1);
        native._bp_raknet_tick();
        const initial = outgoing();
        assert(
            initial.some((packet) => packet[0] === 0x01),
            'the initial ping must reach the relay',
        );
        const request = initial.find((packet) => packet[0] === 0x05);
        assert(request, 'OpenConnectionRequest1 must not be dropped by socket address comparison');
        const magic = request.subarray(1, 17);
        const reply = Buffer.alloc(28);
        reply[0] = 0x06;
        magic.copy(reply, 1);
        reply.writeBigUInt64BE(123n, 17);
        reply[25] = 0;
        reply.writeUInt16BE(1400, 26);
        writeBuffer(reply);
        assert.equal(native._bp_raknet_input(reply.length), 1);
        native._bp_raknet_tick();
        const second = outgoing().find((packet) => packet[0] === 0x07);
        assert(
            second,
            'OpenConnectionReply1 must match the pending connection and produce request2',
        );
        assert.equal(second[17], 4, 'mapped IPv6 is serialized as an IPv4 RakNet address');
        assert.equal(second.readUInt16BE(22), 19132);
        assert.equal(second.readUInt16BE(24), 1400);
        const rejection = Buffer.concat([Buffer.from([0x19, 11]), magic, Buffer.alloc(8)]);
        writeBuffer(rejection);
        assert.equal(native._bp_raknet_input(rejection.length), 1);
        native._bp_raknet_tick();
        assert.equal(
            bytes(native._bp_raknet_receive())[0],
            0x19,
            'real server refusals must still reach the UI',
        );
    } finally {
        native._bp_raknet_close();
    }
});

test('Transfer packets decode the destination, custom port and reload-world flag', () => {
    const host = 'lobby.example.test';
    const port = Buffer.alloc(2);
    port.writeUInt16LE(19133);
    const packet = Buffer.concat([
        Buffer.from([0x55, host.length]),
        Buffer.from(host),
        port,
        Buffer.from([1, 0]),
    ]);
    writeBuffer(packet);
    assert.deepEqual(JSON.parse(readOutput(native._bp_packet_read(packet.length))), {
        type: 'transfer',
        host,
        port: 19133,
        reloadWorld: true,
    });
    writeBuffer(packet.subarray(0, packet.length - 1));
    assert.equal(JSON.parse(readOutput(native._bp_packet_read(packet.length - 1))).type, 'invalid');
});

const profileFixture = {
    deviceId: '0123456789abcdef0123456789abcdef',
    deviceType: 'Android',
    platformOnlineId: '2535412345678901',
    selfSignedId: 'abcdefab-1234-4234-8234-123456789abc',
    skinId: 'abcdefab-1234-4234-8234-abcdefabcdef',
    clientRandomId: '9223372036854775807',
    languageCode: 'fr_FR',
    inputMode: 1,
    memoryTier: 3,
};
function clientClaims(
    profile: unknown = profileFixture,
    address = 'motazmc.fr:19132',
    advertisedVersion = '1.26.52',
) {
    const input = Buffer.from(
        JSON.stringify({
            address,
            name: 'Fixture',
            version: advertisedVersion,
            playFabId: 'abc123',
            profile,
        }),
    );
    writeBuffer(input);
    return readOutput(native._bp_client_data(input.length));
}

test('browser login matches the direct Altay vanilla capture with a 64x64 skin', () => {
    const raw = clientClaims();
    assert.match(raw, /"ClientRandomId":9223372036854775807[,}]/);
    const claims = JSON.parse(raw);
    assert.equal(claims.DeviceId, profileFixture.deviceId);
    assert.equal(claims.SelfSignedId, '');
    assert.equal(claims.SkinId, `${profileFixture.skinId}.Custom`);
    assert.equal(claims.DeviceOS, 8);
    assert.equal(claims.DeviceModel, 'Unknown (Desktop)');
    assert.equal(claims.DefaultInputMode, 1);
    assert.equal(claims.CurrentInputMode, 1);
    assert.equal(claims.LanguageCode, 'fr_FR');
    assert.equal(claims.MemoryTier, 4);
    assert.equal(claims.GuiScale, -1);
    assert.equal(claims.ClientIsEditorCapable, true);
    assert.equal(claims.ClientEditorConnectionIntent, 2);
    assert.equal(claims.FilterProfanity, true);
    assert.equal(claims.MaxViewDistance, 77);
    assert.equal(claims.ThirdPartyNameOnly, false);
    assert.equal(claims.PlayFabId, '');
    assert.equal(claims.ServerAddress, 'motazmc.fr:19132');
    assert.equal(claims.SkinImageWidth, 64);
    assert.equal(claims.SkinImageHeight, 64);
    assert.equal(Buffer.from(claims.SkinData, 'base64').length, 64 * 64 * 4);
    const patch = JSON.parse(Buffer.from(claims.SkinResourcePatch, 'base64').toString());
    const geometries = JSON.parse(Buffer.from(claims.SkinGeometryData, 'base64').toString())[
        'minecraft:geometry'
    ];
    const model = geometries.find(
        (value: { description: { identifier: string } }) =>
            value.description.identifier === patch.geometry.default,
    );
    assert.equal(model.description.texture_width, claims.SkinImageWidth);
    assert.equal(model.description.texture_height, claims.SkinImageHeight);
    assert.equal(
        Buffer.from(claims.SkinGeometryDataEngineVersion, 'base64').toString(),
        claims.GameVersion,
    );
    assert.equal(claims.TrustedSkin, true);
    assert.equal(claims.PremiumSkin, true);
    assert.equal(claims.CompatibleWithClientSideChunkGen, true);
    assert.equal(claims.PlatformOfflineId, '');
    assert.equal(claims.PlatformOnlineId, '');
    assert.equal(claims.PlatformType, 0);
    assert(!('IsPartyLeader' in claims), 'Unsupported party claims must be omitted entirely');
    assert(!('PartyId' in claims), 'PartyId must be omitted entirely, including when empty');
    assert(
        !('PlatformUserId' in claims),
        'Xbox-only fields must not be fabricated for Android authentication',
    );
});

test('login profile and signed 64-bit IDs stay stable while transfer destinations change', () => {
    const first = clientClaims({ ...profileFixture, clientRandomId: '-9223372036854775808' });
    const transferred = clientClaims(
        { ...profileFixture, clientRandomId: '-9223372036854775808' },
        'lobby.example.test:19133',
    );
    assert.match(transferred, /"ClientRandomId":-9223372036854775808[,}]/);
    const before = JSON.parse(first);
    const after = JSON.parse(transferred);
    assert.equal(after.ServerAddress, 'lobby.example.test:19133');
    delete before.ServerAddress;
    delete after.ServerAddress;
    assert.deepEqual(before, after);
});

test('native client profile rejects invalid IDs, inconsistent auth devices and invalid settings', () => {
    for (const patch of [
        { clientRandomId: '0' },
        { clientRandomId: '9223372036854775808' },
        { clientRandomId: '12junk' },
        { clientRandomId: ' 12' },
        { clientRandomId: '1.5' },
        { deviceType: 'Nintendo' },
        { deviceId: 'invalid' },
        { deviceId: '12345678-1234-4234-8234-123456789abc' },
        { deviceId: '0123456789ABCDEF0123456789ABCDEF' },
        { platformOnlineId: '' },
        { platformOnlineId: 'not-a-xuid' },
        { inputMode: 0 },
        { inputMode: 1.5 },
        { memoryTier: 5 },
        { languageCode: '' },
    ])
        assert.equal(clientClaims({ ...profileFixture, ...patch }), '');
});

test('server advertisements cannot downgrade the client GameVersion or geometry engine', () => {
    const claims = JSON.parse(clientClaims(profileFixture, 'motazmc.fr:19132', '1.26.50'));
    const config = JSON.parse(readOutput(native._bp_auth_config()));
    assert.equal(claims.GameVersion, '1.26.60');
    assert.equal(claims.GameVersion, config.gameVersion);
    assert.equal(Buffer.from(claims.SkinGeometryDataEngineVersion, 'base64').toString(), '1.26.60');
    const touch = JSON.parse(clientClaims({ ...profileFixture, inputMode: 2 }));
    assert.equal(touch.CurrentInputMode, 1);
    assert.equal(touch.DefaultInputMode, 1);
});

test('login GameVersion follows the selected protocol, including 1.26.60', () => {
    try {
        for (const [protocol, version] of [
            [2225, '1.26.60'],
            [2193, '1.26.52'],
        ] as const) {
            assert.equal(native._bp_protocol_select(protocol), 1);
            const claims = JSON.parse(clientClaims());
            assert.equal(claims.GameVersion, version);
            assert.equal(
                Buffer.from(claims.SkinGeometryDataEngineVersion, 'base64').toString(),
                version,
            );
        }
        assert.equal(native._bp_protocol_select(2224), 0, 'unknown protocols are refused');
    } finally {
        native._bp_protocol_select(2225);
    }
});
