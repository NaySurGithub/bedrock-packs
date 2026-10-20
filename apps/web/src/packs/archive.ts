import aes from 'aes-js';
import { unzip, zip } from 'fflate';
import type { Unzipped } from 'fflate';
import type { PackOffer, PackProgress, ProcessedPack } from './types.js';
import { MAX_PACK_SIZE } from './types.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_EXPANDED_SIZE = 512 * 1024 * 1024;

function safePath(path: string): string {
    if (
        !path ||
        path.includes('\\') ||
        path.startsWith('/') ||
        /^[A-Za-z]:/.test(path) ||
        path.split('/').some((part) => part === '..' || part === '.') ||
        path.includes('\0')
    ) {
        throw new Error('The pack contains an unsafe file path.');
    }
    return path;
}

function decrypt(data: Uint8Array, text: string): Uint8Array<ArrayBuffer> {
    const key = encoder.encode(text);
    if (key.length !== 32) throw new Error('The pack has an invalid content key.');
    try {
        return new Uint8Array(new aes.ModeOfOperation.cfb(key, key.slice(0, 16), 1).decrypt(data));
    } finally {
        key.fill(0);
    }
}

export function zipFiles(files: Unzipped): Promise<Uint8Array<ArrayBuffer>> {
    return new Promise((resolve, reject) => {
        zip(files, { level: 6 }, (error, result) => {
            if (error) reject(new Error('Could not create the pack archive.'));
            else resolve(new Uint8Array(result));
        });
    });
}

function unpack(data: Uint8Array): Promise<Unzipped> {
    if (data.length > MAX_PACK_SIZE) throw new Error('The pack exceeds the download limit.');
    return new Promise((resolve, reject) => {
        let total = 0;
        let count = 0;
        let invalid = false;
        unzip(
            data,
            {
                filter(file) {
                    total += file.originalSize;
                    invalid ||= total > MAX_EXPANDED_SIZE || ++count > 10000;
                    return !invalid;
                },
            },
            (error, files) => {
                if (error || invalid) reject(new Error('Invalid or oversized pack ZIP archive.'));
                else resolve(files);
            },
        );
    });
}

export async function processArchive(
    data: Uint8Array,
    offer: PackOffer,
    progress: (value: PackProgress) => void = () => {},
): Promise<ProcessedPack> {
    progress({ stage: 'opening', completed: 0, total: 0 });
    const files = await unpack(data);
    for (const name of Object.keys(files)) safePath(name);

    // Some servers distribute a ZIP containing one enclosing pack directory.
    const manifests = Object.keys(files).filter((name) => /(^|\/)manifest\.json$/.test(name));
    const manifestPath = files['manifest.json']
        ? 'manifest.json'
        : manifests.length === 1
          ? manifests[0]!
          : '';
    if (!manifestPath) throw new Error('The pack has no unambiguous manifest.json.');
    const prefix = manifestPath.slice(0, -'manifest.json'.length);
    const output: Unzipped = Object.create(null) as Unzipped;
    for (const [name, bytes] of Object.entries(files)) {
        if (name.startsWith(prefix) && name.length > prefix.length) {
            output[safePath(name.slice(prefix.length))] = bytes;
        }
    }

    const indexes = Object.keys(output).filter((name) => /(^|\/)contents\.json$/.test(name));
    const decodedFiles = new Set<string>();
    const fileCount = Object.keys(output).filter(
        (name) => !name.endsWith('/') && !indexes.includes(name),
    ).length;
    let processed = 0;
    progress({ stage: 'decrypting', completed: 0, total: fileCount });
    for (const index of indexes) {
        const bytes = output[index]!;
        const encrypted =
            bytes.length >= 8 &&
            bytes[4] === 0xfc &&
            bytes[5] === 0xb9 &&
            bytes[6] === 0xcf &&
            bytes[7] === 0x9b;
        if (encrypted && (!offer.key || bytes.length <= 256)) {
            throw new Error('The server did not provide a usable pack content key.');
        }
        let content: { content?: { path?: unknown; key?: unknown }[] };
        try {
            content = JSON.parse(
                decoder.decode(encrypted ? decrypt(bytes.subarray(256), offer.key) : bytes),
            );
        } catch {
            throw new Error('Could not decrypt the pack index. Check the server content key.');
        }
        if (!Array.isArray(content?.content)) throw new Error('Invalid pack content index.');
        const directory = index.slice(0, -'contents.json'.length);
        for (const entry of content.content) {
            if (!entry || typeof entry.path !== 'string')
                throw new Error('Invalid pack content entry.');
            const name = safePath(directory + safePath(entry.path));
            if (entry.key != null && entry.key !== '') {
                if (
                    typeof entry.key !== 'string' ||
                    !output[name] ||
                    decodedFiles.has(name) ||
                    /(^|\/)contents\.json$/.test(name)
                ) {
                    throw new Error('Invalid encrypted pack file reference.');
                }
                output[name] = decrypt(output[name]!, entry.key);
                decodedFiles.add(name);
            }
            processed++;
            if (processed % 16 === 0 || processed === fileCount)
                progress({
                    stage: 'decrypting',
                    completed: Math.min(processed, fileCount),
                    total: fileCount,
                });
        }
        // The decrypted archive no longer needs indexes containing encryption keys.
        delete output[index];
    }
    if (offer.key && !indexes.length) throw new Error('The encrypted pack has no contents.json.');

    let manifest: { header?: { name?: string; uuid?: string; version?: unknown } };
    try {
        manifest = JSON.parse(decoder.decode(output['manifest.json']!));
    } catch {
        throw new Error('The decrypted pack manifest is invalid.');
    }
    if (
        !manifest?.header ||
        typeof manifest.header.name !== 'string' ||
        typeof manifest.header.uuid !== 'string' ||
        manifest.header.uuid.toLowerCase() !== offer.id.toLowerCase()
    ) {
        throw new Error('The pack manifest does not match the server pack ID.');
    }
    let name = manifest.header.name;
    const language = output['texts/en_US.lang'];
    if (language) {
        const line = new TextDecoder()
            .decode(language)
            .split(/\r?\n/)
            .find((line) => line.startsWith(`${name}=`));
        if (line) name = line.slice(name.length + 1).trim();
    }
    progress({ stage: 'exporting', completed: 0, total: 0 });
    const archive = await zipFiles(output);
    progress({ stage: 'exporting', completed: 1, total: 1 });
    return { name, archive };
}
