import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
    createClientProfile,
    memoryTier,
    profileIds,
    windowsDeviceId,
} from '../apps/web/src/connection/profile.js';

test('client IDs survive repeated joins and transfers without storing account credentials', () => {
    const entries = new Map<string, string>();
    const store = {
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => {
            entries.set(key, value);
        },
    };
    const first = profileIds(store);
    assert.deepEqual(profileIds(store), first);
    assert.notEqual(first.selfSignedId, first.skinId);
    const id = BigInt(first.clientRandomId);
    assert(id !== 0n && id >= -(1n << 63n) && id < 1n << 63n);
    assert.deepEqual(Object.keys(JSON.parse([...entries.values()][0]!)).sort(), [
        'clientRandomId',
        'selfSignedId',
        'skinId',
        'version',
    ]);
    assert(!/token|gamertag|password|xuid/i.test([...entries.values()][0]!));
});

test('stored 64-bit client IDs retain every bit, including the signed limits', () => {
    for (const id of ['9223372036854775807', '-9223372036854775808']) {
        const saved = { ...profileIds(), clientRandomId: id };
        assert.equal(
            profileIds({
                getItem: () => JSON.stringify(saved),
                setItem: () => assert.fail('valid stored ID should not be replaced'),
            }).clientRandomId,
            id,
        );
    }
});

test('malformed or blocked profile storage falls back to a valid in-memory identity', () => {
    const saved = profileIds();
    for (const broken of [
        'invalid json',
        JSON.stringify({ ...saved, clientRandomId: '0' }),
        JSON.stringify({ ...saved, clientRandomId: '9223372036854775808' }),
        JSON.stringify({ ...saved, selfSignedId: 'not a UUID' }),
    ]) {
        assert.equal(
            profileIds({ getItem: () => broken, setItem: () => {} }).clientRandomId,
            saved.clientRandomId,
        );
    }
    const unavailable = {
        getItem(): never {
            throw new Error('blocked');
        },
        setItem(): never {
            throw new Error('blocked');
        },
    };
    assert.deepEqual(profileIds(unavailable), saved);
});

test('memory tiers use reported browser memory and keep unknown hardware unknown', () => {
    assert.deepEqual(
        [undefined, 0, NaN, -1, 1, 1.5, 2, 4, 8, 16].map(memoryTier),
        [0, 0, 0, 0, 0, 0, 1, 2, 3, 4],
    );
});

test('profile derives locale and actual input from the browser, preserving the auth device', () => {
    const profile = createClientProfile(
        '12345678-1234-4234-8234-123456789abc',
        'Android',
        '2535412345678901',
        {
            language: 'fr-FR',
            deviceMemory: 8,
            coarsePointer: false,
        },
    );
    assert.equal(profile.languageCode, 'fr_FR');
    assert.equal(profile.inputMode, 1);
    assert.equal(profile.memoryTier, 3);
    assert.equal(profile.deviceType, 'Android');
    assert.equal(profile.platformOnlineId, '2535412345678901');
    assert.equal(profile.deviceId, '12345678-1234-4234-8234-123456789abc');
    const touch = createClientProfile(
        profile.deviceId,
        profile.deviceType,
        profile.platformOnlineId,
        {
            language: 'ja-JP',
            coarsePointer: true,
        },
    );
    assert.equal(touch.inputMode, 2);
    assert.equal(touch.languageCode, 'ja_JP');
    assert.equal(touch.clientRandomId, profile.clientRandomId);
});

test('Windows device IDs are stable 32-digit lowercase hex, derived like SolarProxy', async () => {
    const xuid = '2535412345678901';
    const id = await windowsDeviceId(xuid);
    assert.match(id, /^[0-9a-f]{32}$/);
    assert.equal(
        id,
        createHash('sha256').update(`solar-device:Windows 10:${xuid}`).digest('hex').slice(0, 32),
    );
    assert.equal(await windowsDeviceId(xuid), id);
    assert.notEqual(await windowsDeviceId('2535412345678902'), id);
});
