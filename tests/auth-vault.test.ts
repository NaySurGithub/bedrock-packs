import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AccountVault } from '../apps/web/src/auth/vault.js';
import type { AccountSession } from '../apps/web/src/auth/types.js';

const account: AccountSession = {
    version: 1,
    clientId: 'fixture-client',
    deviceId: 'fixture-device',
    live: {
        accessToken: 'fixture-access-token',
        refreshToken: 'fixture-refresh-token',
        expiresAt: Date.now() + 3600000,
    },
    xbox: {},
};

function openDatabase(name: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function read<T>(database: IDBDatabase, store: string, key: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const request = database.transaction(store).objectStore(store).get(key);
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => reject(request.error);
    });
}

test('account vault stores authenticated ciphertext and a non-extractable AES key', async () => {
    const name = `vault-${crypto.randomUUID()}`;
    const vault = new AccountVault(name);
    const initial = await vault.read();
    await vault.save(account, initial.epoch);

    const database = await openDatabase(name);
    const stored = await read<{ iv: Uint8Array; ciphertext: ArrayBuffer }>(
        database,
        'records',
        'account',
    );
    const key = await read<CryptoKey>(database, 'keys', 'encryption');

    assert.equal(stored.iv.length, 12);
    assert.equal(
        new TextDecoder().decode(stored.ciphertext).includes(account.live.refreshToken),
        false,
    );
    assert.equal(key.extractable, false);
    await assert.rejects(crypto.subtle.exportKey('raw', key));
    assert.deepEqual((await vault.read()).session, account);

    const reloaded = new AccountVault(name);
    assert.deepEqual((await reloaded.read()).session, account);
    database.close();
});

test('vault rejects modified ciphertext instead of loading corrupted credentials', async () => {
    const name = `vault-${crypto.randomUUID()}`;
    const vault = new AccountVault(name);
    const initial = await vault.read();
    await vault.save(account, initial.epoch);

    const database = await openDatabase(name);
    const stored = await read<{ iv: Uint8Array; ciphertext: ArrayBuffer }>(
        database,
        'records',
        'account',
    );
    new Uint8Array(stored.ciphertext)[0]! ^= 1;

    await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('records', 'readwrite');
        transaction.objectStore('records').put(stored, 'account');
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    });

    await assert.rejects(vault.read(), /cannot be unlocked/);
    database.close();
});

test('logout generation prevents an in-flight refresh from restoring deleted tokens', async () => {
    const vault = new AccountVault(`vault-${crypto.randomUUID()}`);
    const previous = await vault.read();
    await vault.save(account, previous.epoch);
    await vault.clear();

    await assert.rejects(vault.save(account, previous.epoch));
    assert.equal((await vault.read()).session, undefined);
});

test('private Xbox and Minecraft signing keys remain non-extractable after reload', async () => {
    const name = `vault-${crypto.randomUUID()}`;
    const vault = new AccountVault(name);
    const pair = await vault.keyPair('xbox-proof', 'P-256');

    assert.equal(pair.privateKey.extractable, false);
    await assert.rejects(crypto.subtle.exportKey('jwk', pair.privateKey));

    const restored = await new AccountVault(name).keyPair('xbox-proof', 'P-256');
    assert.deepEqual(
        await crypto.subtle.exportKey('jwk', restored.publicKey),
        await crypto.subtle.exportKey('jwk', pair.publicKey),
    );
    assert.equal(restored.privateKey.extractable, false);
});
