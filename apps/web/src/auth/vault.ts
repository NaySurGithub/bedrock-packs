import type { AccountSession } from './types.js';

interface SealedAccount {
    version: 1;
    iv: Uint8Array<ArrayBuffer>;
    ciphertext: ArrayBuffer;
}

export interface AccountStore {
    read(): Promise<{ session: AccountSession | undefined; epoch: string }>;
    save(session: AccountSession, epoch: string): Promise<void>;
    keyPair(name: string, curve: 'P-256' | 'P-384'): Promise<CryptoKeyPair>;
    agreementKey?(name: string): Promise<CryptoKey>;
    clear(): Promise<void>;
}

const additionalData = new TextEncoder().encode('bedrock-packs/account/v1');

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error('Local account storage could not be read.'));
    });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () =>
            reject(new Error('Local account storage could not be updated.'));
        transaction.onabort = () => reject(new Error('Local account storage was interrupted.'));
    });
}

export class AccountVault implements AccountStore {
    #database: Promise<IDBDatabase>;

    constructor(databaseName = 'bedrock-packs-account') {
        this.#database = new Promise((resolve, reject) => {
            if (!globalThis.indexedDB || !globalThis.crypto?.subtle) {
                reject(new Error('Secure browser storage requires HTTPS or localhost.'));
                return;
            }

            const request = indexedDB.open(databaseName, 1);

            request.onupgradeneeded = () => {
                request.result.createObjectStore('keys');
                request.result.createObjectStore('records');
            };

            request.onsuccess = () => {
                request.result.onversionchange = () => request.result.close();
                resolve(request.result);
            };

            request.onerror = () => reject(new Error('Browser account storage is unavailable.'));
            request.onblocked = () =>
                reject(new Error('Close other tabs to update account storage.'));
        });
    }

    async #epoch(): Promise<string> {
        const database = await this.#database;
        const transaction = database.transaction('records', 'readwrite');
        const complete = transactionComplete(transaction);
        const records = transaction.objectStore('records');
        const request = records.get('epoch');
        let epoch = '';

        request.onsuccess = () => {
            epoch = typeof request.result === 'string' ? request.result : crypto.randomUUID();

            if (!request.result) {
                records.put(epoch, 'epoch');
            }
        };

        await complete;
        return epoch;
    }

    async #encryptionKey(): Promise<CryptoKey> {
        const database = await this.#database;
        const existing = (await requestResult(
            database.transaction('keys').objectStore('keys').get('encryption'),
        )) as CryptoKey | undefined;

        if (existing) {
            return existing;
        }

        const generated = await crypto.subtle.generateKey(
            {
                name: 'AES-GCM',
                length: 256,
            },
            false,
            ['encrypt', 'decrypt'],
        );

        const transaction = database.transaction('keys', 'readwrite');
        const complete = transactionComplete(transaction);
        const keys = transaction.objectStore('keys');
        const request = keys.get('encryption');
        let key = generated;

        request.onsuccess = () => {
            if (request.result) {
                key = request.result as CryptoKey;
            } else {
                keys.put(key, 'encryption');
            }
        };

        await complete;
        return key;
    }

    async read(): Promise<{ session: AccountSession | undefined; epoch: string }> {
        const epoch = await this.#epoch();
        const database = await this.#database;
        const transaction = database.transaction(['records', 'keys'], 'readonly');

        const [sealed, key] = (await Promise.all([
            requestResult(transaction.objectStore('records').get('account')),
            requestResult(transaction.objectStore('keys').get('encryption')),
        ])) as [SealedAccount | undefined, CryptoKey | undefined];

        if (!sealed) {
            return {
                session: undefined,
                epoch,
            };
        }

        if (!key || sealed.version !== 1) {
            throw new Error('The saved account cannot be unlocked. Sign out and try again.');
        }

        try {
            const plaintext = await crypto.subtle.decrypt(
                {
                    name: 'AES-GCM',
                    iv: sealed.iv,
                    additionalData,
                },
                key,
                sealed.ciphertext,
            );

            const session = JSON.parse(new TextDecoder().decode(plaintext)) as AccountSession;

            if (session.version !== 1 || typeof session.live?.refreshToken !== 'string') {
                throw new Error('Invalid account record.');
            }

            return {
                session,
                epoch,
            };
        } catch {
            throw new Error('The saved account cannot be unlocked. Sign out and try again.');
        }
    }

    async save(session: AccountSession, epoch: string): Promise<void> {
        const key = await this.#encryptionKey();
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await crypto.subtle.encrypt(
            {
                name: 'AES-GCM',
                iv,
                additionalData,
            },
            key,
            new TextEncoder().encode(JSON.stringify(session)),
        );

        const database = await this.#database;
        const transaction = database.transaction('records', 'readwrite');
        const complete = transactionComplete(transaction);
        const records = transaction.objectStore('records');
        const request = records.get('epoch');

        request.onsuccess = () => {
            if (request.result !== epoch) {
                transaction.abort();
                return;
            }

            records.put(
                {
                    version: 1,
                    iv,
                    ciphertext,
                } satisfies SealedAccount,
                'account',
            );
        };

        await complete;
    }

    async keyPair(name: string, curve: 'P-256' | 'P-384'): Promise<CryptoKeyPair> {
        const database = await this.#database;
        const existing = (await requestResult(
            database.transaction('keys').objectStore('keys').get(name),
        )) as CryptoKeyPair | undefined;

        if (existing) {
            return existing;
        }

        const generated = await crypto.subtle.generateKey(
            {
                name: 'ECDSA',
                namedCurve: curve,
            },
            curve === 'P-384',
            ['sign', 'verify'],
        );

        let agreement: CryptoKey | undefined;

        if (curve === 'P-384') {
            const privateBytes = await crypto.subtle.exportKey('pkcs8', generated.privateKey);

            try {
                agreement = await crypto.subtle.importKey(
                    'pkcs8',
                    privateBytes,
                    { name: 'ECDH', namedCurve: curve },
                    false,
                    ['deriveBits'],
                );
                generated.privateKey = await crypto.subtle.importKey(
                    'pkcs8',
                    privateBytes,
                    { name: 'ECDSA', namedCurve: curve },
                    false,
                    ['sign'],
                );
            } finally {
                new Uint8Array(privateBytes).fill(0);
            }
        }

        const transaction = database.transaction('keys', 'readwrite');
        const complete = transactionComplete(transaction);
        const keys = transaction.objectStore('keys');
        const request = keys.get(name);
        let pair = generated;

        request.onsuccess = () => {
            if (request.result) {
                pair = request.result as CryptoKeyPair;
            } else {
                keys.put(pair, name);

                if (agreement) {
                    keys.put(agreement, `${name}:agreement`);
                }
            }
        };

        await complete;
        return pair;
    }

    async agreementKey(name: string): Promise<CryptoKey> {
        const database = await this.#database;
        const key = (await requestResult(
            database.transaction('keys').objectStore('keys').get(`${name}:agreement`),
        )) as CryptoKey | undefined;

        if (!key) {
            throw new Error('The Minecraft key does not support key agreement. Sign in again.');
        }

        return key;
    }

    async clear(): Promise<void> {
        const database = await this.#database;
        const transaction = database.transaction(['records', 'keys'], 'readwrite');
        const complete = transactionComplete(transaction);

        transaction.objectStore('keys').clear();
        transaction.objectStore('records').clear();
        transaction.objectStore('records').put(crypto.randomUUID(), 'epoch');

        await complete;
    }
}
