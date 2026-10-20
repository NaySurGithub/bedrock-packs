import { base64, concatenate } from '../auth/crypto.js';
import type { AccountClient } from '../auth/client.js';

export type ConnectionIdentity = Awaited<ReturnType<AccountClient['connectionIdentity']>>;
const encoder = new TextEncoder();

export function decode64(value: string): Uint8Array<ArrayBuffer> {
    if (!/^[A-Za-z0-9+/_=-]*$/.test(value) || value.length > 1024 * 1024) {
        throw new Error('Invalid Base64 data.');
    }

    return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (character) =>
        character.charCodeAt(0),
    );
}

export function encode64(value: Uint8Array): string {
    return base64(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function tokenParts(token: string): {
    header: Record<string, unknown>;
    claims: Record<string, unknown>;
    input: Uint8Array<ArrayBuffer>;
    signature: Uint8Array<ArrayBuffer>;
} {
    const parts = token.split('.');

    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
        throw new Error('Invalid signed token.');
    }

    const parse = (part: string): Record<string, unknown> => {
        const value: unknown = JSON.parse(new TextDecoder().decode(decode64(part)));

        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('Invalid token claims.');
        }

        return value as Record<string, unknown>;
    };

    return {
        header: parse(parts[0]),
        claims: parse(parts[1]),
        input: encoder.encode(`${parts[0]}.${parts[1]}`),
        signature: decode64(parts[2]),
    };
}

export async function verify384(
    key: CryptoKey,
    input: Uint8Array<ArrayBuffer>,
    signature: Uint8Array<ArrayBuffer>,
): Promise<void> {
    if (
        signature.length !== 96 ||
        !(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-384' }, key, signature, input))
    ) {
        throw new Error('The server signature is invalid.');
    }
}

export function import384(publicKey: string): Promise<CryptoKey> {
    return crypto.subtle.importKey(
        'spki',
        decode64(publicKey),
        { name: 'ECDSA', namedCurve: 'P-384' },
        false,
        ['verify'],
    );
}

export async function signToken(identity: ConnectionIdentity, claims: string): Promise<string> {
    const header = encode64(
        encoder.encode(JSON.stringify({ alg: 'ES384', x5u: identity.identity.publicKey })),
    );
    const input = `${header}.${encode64(encoder.encode(claims))}`;
    const signature = await identity.sign(encoder.encode(input));
    return `${input}.${encode64(signature)}`;
}

export class GameCipher {
    #bytes: Uint8Array<ArrayBuffer>;
    #key: CryptoKey;
    #iv: bigint;
    #sent = 0n;
    #received = 0n;
    #sendPosition = 0;
    #receivePosition = 0;

    private constructor(bytes: Uint8Array<ArrayBuffer>, key: CryptoKey) {
        this.#bytes = bytes;
        this.#key = key;
        const iv = new Uint8Array(16);
        iv.set(bytes.subarray(0, 12));
        iv[15] = 2;
        this.#iv = BigInt(
            `0x${Array.from(iv, (byte) => byte.toString(16).padStart(2, '0')).join('')}`,
        );
    }

    static async fromHandshake(identity: ConnectionIdentity, token: string): Promise<GameCipher> {
        const parsed = tokenParts(token);

        if (
            parsed.header.alg !== 'ES384' ||
            typeof parsed.header.x5u !== 'string' ||
            typeof parsed.claims.salt !== 'string'
        ) {
            throw new Error('Invalid server encryption handshake.');
        }

        const remote = await import384(parsed.header.x5u);
        await verify384(remote, parsed.input, parsed.signature);
        const salt = decode64(parsed.claims.salt);

        if (salt.length === 0 || salt.length > 1024) {
            throw new Error('Invalid server encryption salt.');
        }

        const secret = await identity.agree(decode64(parsed.header.x5u));

        try {
            const bytes = new Uint8Array(
                await crypto.subtle.digest('SHA-256', concatenate(salt, secret)),
            );
            const key = await crypto.subtle.importKey('raw', bytes, 'AES-CTR', false, ['encrypt']);
            return new GameCipher(bytes, key);
        } finally {
            secret.fill(0);
        }
    }

    async #checksum(counter: bigint, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setBigUint64(0, counter, true);
        return new Uint8Array(
            await crypto.subtle.digest('SHA-256', concatenate(bytes, data, this.#bytes)),
        ).slice(0, 8);
    }

    async #transform(data: Uint8Array, position: number): Promise<Uint8Array<ArrayBuffer>> {
        const counterValue = this.#iv + BigInt(Math.floor(position / 16));
        const counter = new Uint8Array(16);
        const view = new DataView(counter.buffer);
        view.setBigUint64(0, counterValue >> 64n);
        view.setBigUint64(8, counterValue & 0xffffffffffffffffn);
        const skip = position % 16;
        const input = new Uint8Array(skip + data.length);
        input.set(data, skip);
        const result = await crypto.subtle.encrypt(
            { name: 'AES-CTR', counter, length: 128 },
            this.#key,
            input,
        );
        return new Uint8Array(result).slice(skip);
    }

    async encrypt(packet: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
        if (packet[0] !== 0xfe) {
            throw new Error('Invalid RakNet game packet.');
        }

        const body = packet.subarray(1);
        const checksum = await this.#checksum(this.#sent, body);
        const encrypted = await this.#transform(concatenate(body, checksum), this.#sendPosition);
        this.#sendPosition += encrypted.length;
        this.#sent++;
        return concatenate(new Uint8Array([0xfe]), encrypted);
    }

    async decrypt(packet: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
        if (packet[0] !== 0xfe || packet.length < 10) {
            throw new Error('Invalid encrypted game packet.');
        }

        const plaintext = await this.#transform(packet.subarray(1), this.#receivePosition);
        const body = plaintext.subarray(0, -8);
        const expected = await this.#checksum(this.#received, body);
        const received = plaintext.subarray(-8);
        let difference = 0;

        for (let index = 0; index < 8; index++) {
            difference |= expected[index]! ^ received[index]!;
        }

        if (difference !== 0) {
            // Falcon permits plaintext already queued before the first encrypted packet.
            if (this.#received === 0n) {
                return packet.slice();
            }

            throw new Error('The server packet checksum is invalid.');
        }

        this.#receivePosition += plaintext.length;
        this.#received++;
        return concatenate(new Uint8Array([0xfe]), body);
    }

    dispose(): void {
        this.#bytes.fill(0);
    }
}
