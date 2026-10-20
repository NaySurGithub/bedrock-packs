const encoder = new TextEncoder();

export function base64(bytes: Uint8Array): string {
    let value = '';

    for (const byte of bytes) {
        value += String.fromCharCode(byte);
    }

    return btoa(value);
}

export function concatenate(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
    const length = parts.reduce((total, part) => total + part.byteLength, 0);
    const result = new Uint8Array(length);
    let offset = 0;

    for (const part of parts) {
        result.set(part, offset);
        offset += part.byteLength;
    }

    return result;
}

export async function publicProof(key: CryptoKey): Promise<Record<string, string>> {
    const exported = await crypto.subtle.exportKey('jwk', key);

    if (!exported.x || !exported.y) {
        throw new Error('The Xbox proof key could not be exported.');
    }

    return {
        alg: 'ES256',
        crv: 'P-256',
        kty: 'EC',
        use: 'sig',
        x: exported.x,
        y: exported.y,
    };
}

export async function signXboxRequest(
    privateKey: CryptoKey,
    path: string,
    body: string,
    serverTime: number,
): Promise<string> {
    const timestamp = (BigInt(Math.floor(serverTime / 1000)) + 11644473600n) * 10000000n;
    const version = new Uint8Array([0, 0, 0, 1]);
    const encodedTime = new Uint8Array(8);
    new DataView(encodedTime.buffer).setBigUint64(0, timestamp);

    const separator = new Uint8Array([0]);
    const message = concatenate(
        version,
        separator,
        encodedTime,
        separator,
        encoder.encode('POST'),
        separator,
        encoder.encode(path),
        separator,
        separator,
        encoder.encode(body),
        separator,
    );

    const signature = await crypto.subtle.sign(
        {
            name: 'ECDSA',
            hash: 'SHA-256',
        },
        privateKey,
        message,
    );

    if (signature.byteLength !== 64) {
        throw new Error('The browser returned an unsupported Xbox signature.');
    }

    return base64(concatenate(version, encodedTime, new Uint8Array(signature)));
}

export function jwtClaims(token: string): Record<string, unknown> {
    const part = token.split('.')[1];

    if (!part || part.length > 1024 * 1024) {
        throw new Error('The authentication service returned an invalid identity token.');
    }

    try {
        const encoded = part.replace(/-/g, '+').replace(/_/g, '/');
        const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
        const value: unknown = JSON.parse(new TextDecoder().decode(bytes));

        if (value && typeof value === 'object' && !Array.isArray(value)) {
            return value as Record<string, unknown>;
        }
    } catch {
        // JWT signatures are checked by the receiving service, not by this metadata reader.
    }

    throw new Error('The authentication service returned an invalid identity token.');
}
