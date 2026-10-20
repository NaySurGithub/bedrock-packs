import { createCipheriv, createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import type { PackOffer } from '../apps/web/src/packs/types.js';

export const packId = '12345678-1234-5678-9abc-123456789abc';
export const masterKey = '0123456789abcdef0123456789abcdef';
export const fileKey = 'abcdef0123456789abcdef0123456789';
export const offer: PackOffer = {
    id: packId,
    version: '1.0.0',
    size: 1,
    key: masterKey,
    cdnUrl: '',
};
export const encode = (value: string) => new TextEncoder().encode(value);
export const plaintext = encode('{"texture_data":{"stone":{"textures":"textures/stone"}}}');

function encrypt(data: Uint8Array, key: string): Uint8Array {
    const cipher = createCipheriv('aes-256-cfb8', Buffer.from(key), Buffer.from(key.slice(0, 16)));
    return Buffer.concat([cipher.update(data), cipher.final()]);
}

function index(entries: { path: string; key?: string }[]): Uint8Array {
    const header = new Uint8Array(256);
    header.set([0xfc, 0xb9, 0xcf, 0x9b], 4);
    const json = encrypt(encode(JSON.stringify({ content: entries })), masterKey);
    return new Uint8Array(Buffer.concat([header, json]));
}

export function fixture(encrypted = true, nested = false): Uint8Array<ArrayBuffer> {
    const files: Record<string, Uint8Array> = {
        'manifest.json': encode(
            JSON.stringify({
                format_version: 2,
                header: { name: 'pack.name', uuid: packId, version: [1, 0, 0] },
                modules: [
                    {
                        type: 'resources',
                        uuid: 'abcdefab-1234-5678-9abc-123456789abc',
                        version: [1, 0, 0],
                    },
                ],
            }),
        ),
        'texts/en_US.lang': encode('pack.name=Fixture Pack\n'),
        'textures/terrain_texture.json': encrypted ? encrypt(plaintext, fileKey) : plaintext,
        'subpacks/low/extra.json': encrypted
            ? encrypt(encode('{"low":true}'), fileKey)
            : encode('{"low":true}'),
    };
    if (encrypted) {
        files['contents.json'] = index([
            { path: 'manifest.json' },
            { path: 'texts/en_US.lang' },
            { path: 'textures/terrain_texture.json', key: fileKey },
        ]);
        files['subpacks/low/contents.json'] = index([{ path: 'extra.json', key: fileKey }]);
    }
    return new Uint8Array(
        zipSync(
            Object.fromEntries(
                Object.entries(files).map(([name, bytes]) => [
                    nested ? `enclosing/${name}` : name,
                    bytes,
                ]),
            ),
        ),
    );
}

export function sha256(data: Uint8Array): string {
    return createHash('sha256').update(data).digest('hex');
}

export function varint(value: number): Buffer {
    const bytes: number[] = [];
    do {
        const byte = value & 127;
        value >>>= 7;
        bytes.push(byte | (value ? 128 : 0));
    } while (value);
    return Buffer.from(bytes);
}
export function string(value: string): Buffer {
    const bytes = Buffer.from(value);
    return Buffer.concat([varint(bytes.length), bytes]);
}
export function i32(value: number): Buffer {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE(value);
    return bytes;
}
export function i64(value: number): Buffer {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(BigInt(value));
    return bytes;
}
export function infoPacket(pack: PackOffer): Buffer {
    const uuid = Buffer.alloc(16);
    const hex = pack.id.replaceAll('-', '');
    uuid.writeBigUInt64LE(BigInt(`0x${hex.slice(0, 16)}`), 0);
    uuid.writeBigUInt64LE(BigInt(`0x${hex.slice(16)}`), 8);
    return Buffer.concat([
        Buffer.from([6, 0, 0, 0, 0]),
        Buffer.alloc(16),
        string(''),
        varint(1),
        uuid,
        string(pack.version),
        i64(pack.size),
        string(pack.key),
        string(''),
        string(pack.id),
        Buffer.from([0, 0, 0]),
        string(pack.cdnUrl),
    ]);
}
export function dataPacket(pack: PackOffer, data: Uint8Array, chunkSize: number): Buffer {
    const hash = Buffer.from(sha256(data), 'hex');
    return Buffer.concat([
        Buffer.from([0x52]),
        string(`${pack.id}_${pack.version}`),
        i32(chunkSize),
        i32(Math.ceil(data.length / chunkSize)),
        i64(data.length),
        varint(hash.length),
        hash,
        Buffer.from([0, 6]),
    ]);
}
export function chunkPacket(
    pack: PackOffer,
    data: Uint8Array,
    chunkSize: number,
    index: number,
): Buffer {
    const bytes = data.subarray(index * chunkSize, (index + 1) * chunkSize);
    return Buffer.concat([
        Buffer.from([0x53]),
        string(`${pack.id}_${pack.version}`),
        i32(index),
        i64(index * chunkSize),
        varint(bytes.length),
        bytes,
    ]);
}
export function stackPacket(): Buffer {
    return Buffer.concat([Buffer.from([7, 0, 0]), string('1.26.52'), i32(0), Buffer.from([0, 0])]);
}
