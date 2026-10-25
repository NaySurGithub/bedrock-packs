import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { unzipSync } from 'fflate';
import { BrowserCodec } from '../apps/web/src/connection/codec.js';
import type { NativeConnection } from '../apps/web/src/connection/codec.js';
import { PackTransfer } from '../apps/web/src/packs/transfer.js';
import { processArchive } from '../apps/web/src/packs/archive.js';
import type { PackEvent, PackView } from '../apps/web/src/packs/types.js';
import {
    fixture,
    offer,
    dataPacket,
    infoPacket,
    chunkPacket,
    stackPacket,
    plaintext,
    sha256,
} from './pack-fixture.js';

const moduleUrl = new URL('../apps/web/public/wasm/bedrock-packs.mjs', import.meta.url);
const generated = await import(moduleUrl.href);
const native: NativeConnection = await generated.default({
    wasmBinary: await readFile(
        new URL('../apps/web/public/wasm/bedrock-packs.wasm', import.meta.url),
    ),
});
const codec = new BrowserCodec(native);

function harness(fetcher?: typeof fetch) {
    const controller = new AbortController();
    const responses: number[] = [];
    const outgoing: Uint8Array[] = [];
    const requests: number[] = [];
    let views: PackView[] = [];
    let completed = -1;
    let failure = '';
    const transfer = new PackTransfer(
        {
            async response(status, ids) {
                responses.push(status);
                outgoing.push(codec.packResponse(status, ids));
            },
            async request(id, version, index) {
                requests.push(index);
                outgoing.push(codec.packRequest(id, version, index));
            },
        },
        (bytes, pack, _signal, progress) => processArchive(bytes, pack, progress),
        controller.signal,
        (value) => {
            views = value;
        },
        (count) => {
            completed = count;
        },
        (error) => {
            failure = error.message;
        },
        fetcher,
    );
    const read = (packet: Uint8Array) => codec.read(packet) as PackEvent;
    return {
        transfer,
        responses,
        outgoing,
        requests,
        read,
        controller,
        get views() {
            return views;
        },
        get completed() {
            return completed;
        },
        get failure() {
            return failure;
        },
    };
}

test('real WASM packets negotiate, assemble out-of-order chunks, decrypt and export', async (t) => {
    const h = harness();
    t.after(() => h.controller.abort());
    const data = fixture();
    const pack = { ...offer, size: data.length };
    await h.transfer.handle(h.read(infoPacket(pack)));
    assert.deepEqual(h.responses, [2]);
    assert.equal(h.outgoing[0]![0], 8);
    assert(Buffer.from(h.outgoing[0]!).includes(Buffer.from(`${pack.id}_${pack.version}`)));
    const chunkSize = 128;
    await h.transfer.handle(h.read(dataPacket(pack, data, chunkSize)));
    assert.deepEqual(h.requests, [0, 1, 2, 3]);
    const count = Math.ceil(data.length / chunkSize);
    await h.transfer.handle(h.read(chunkPacket(pack, data, chunkSize, 1)));
    const firstProgress = h.views[0]!.received;
    await h.transfer.handle(h.read(chunkPacket(pack, data, chunkSize, 1)));
    assert.equal(h.views[0]!.received, firstProgress, 'duplicates do not increase progress');
    for (let index = 0; index < count; index++) {
        if (index !== 1) await h.transfer.handle(h.read(chunkPacket(pack, data, chunkSize, index)));
    }
    assert.deepEqual(h.responses, [2, 3]);
    assert.equal(h.views[0]!.status, 'ready');
    assert.equal(h.views[0]!.received, data.length);
    assert.deepEqual(unzipSync(h.views[0]!.archive!)['textures/terrain_texture.json'], plaintext);
    await h.transfer.handle(h.read(stackPacket()));
    assert.deepEqual(h.responses, [2, 3, 4]);
    assert.equal(h.completed, 1);
    assert.equal(h.views[0]!.status, 'ready');
});

test('empty pack lists complete negotiation', async (t) => {
    const h = harness();
    t.after(() => h.controller.abort());
    await h.transfer.handle({ type: 'packs-info', packs: [] });
    await h.transfer.handle({ type: 'packs-stack' });
    assert.deepEqual(h.responses, [3, 4]);
    assert.equal(h.completed, 0);
});

test('truncated resource-pack packets fail in the native codec', () => {
    const data = fixture();
    const pack = { ...offer, size: data.length };
    for (const packet of [
        infoPacket(pack),
        dataPacket(pack, data, 128),
        chunkPacket(pack, data, 128, 0),
    ]) {
        assert.equal(codec.read(packet.subarray(0, packet.length - 2)).type, 'invalid');
    }
});

test('corrupt chunk contents fail SHA-256 and never become downloadable', async (t) => {
    const h = harness();
    t.after(() => h.controller.abort());
    const data = fixture();
    const pack = { ...offer, size: data.length };
    await h.transfer.handle(h.read(infoPacket(pack)));
    await h.transfer.handle(h.read(dataPacket(pack, data, data.length)));
    const damaged = data.slice();
    damaged[20] = damaged[20]! ^ 255;
    await assert.rejects(
        h.transfer.handle(h.read(chunkPacket(pack, damaged, data.length, 0))),
        /SHA-256/,
    );
    assert.equal(h.views[0]!.status, 'error');
    assert.equal(h.views[0]!.archive, undefined);
});

test('rejects invalid offsets, oversized metadata and premature pack stacks', async (t) => {
    const h = harness();
    t.after(() => h.controller.abort());
    await assert.rejects(
        h.transfer.handle({ type: 'packs-info', packs: [{ ...offer, size: 129 * 1024 * 1024 }] }),
        /limit/,
    );
    const h2 = harness();
    t.after(() => h2.controller.abort());
    await h2.transfer.handle({ type: 'packs-info', packs: [{ ...offer, size: 4 }] });
    await h2.transfer.handle({
        type: 'pack-data',
        id: offer.id,
        version: offer.version,
        size: 4,
        chunkSize: 4,
        chunkCount: 1,
        hash: sha256(new Uint8Array(4)),
    });
    await assert.rejects(
        h2.transfer.handle({
            type: 'pack-chunk',
            id: offer.id,
            version: offer.version,
            index: 0,
            progress: 1,
            data: new Uint8Array(4),
        }),
        /offset/,
    );
    const h3 = harness();
    t.after(() => h3.controller.abort());
    await assert.rejects(h3.transfer.handle({ type: 'packs-stack' }), /before downloads/);
});

test('CDN downloads complete locally, and CORS failures fall back to server chunks', async (t) => {
    const data = fixture();
    const pack = { ...offer, size: data.length, cdnUrl: 'https://cdn.example.test/pack' };
    const h = harness(async (_url, options) => {
        assert.equal(options?.credentials, 'omit');
        return new Response(data);
    });
    t.after(() => h.controller.abort());
    await h.transfer.handle({ type: 'packs-info', packs: [pack] });
    assert.deepEqual(h.responses, [3]);
    assert.equal(h.views[0]!.status, 'ready');
    const fallback = harness(async () => {
        throw new TypeError('CORS blocked');
    });
    t.after(() => fallback.controller.abort());
    await fallback.transfer.handle({ type: 'packs-info', packs: [pack] });
    assert.deepEqual(fallback.responses, [2]);
    assert.equal(fallback.views[0]!.received, 0);
});

test('cancellation preserves ready packs and marks unfinished downloads', async (t) => {
    const h = harness();
    t.after(() => h.controller.abort());
    await h.transfer.handle({ type: 'packs-info', packs: [{ ...offer, size: 4 }] });
    h.controller.abort();
    assert.equal(h.views[0]!.status, 'error');
    await assert.rejects(h.transfer.handle({ type: 'packs-stack' }), /abort/i);
});

test('stalled negotiation reports an actionable timeout', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = harness();
    t.after(() => h.controller.abort());
    h.transfer.start();
    t.mock.timers.tick(45001);
    assert.match(h.failure, /timed out/);
});

test('multiple packs share a bounded request window and ready packs survive cancellation', async (t) => {
    const controller = new AbortController();
    t.after(() => controller.abort());
    const data = new Uint8Array(8);
    const second = { ...offer, id: '22222222-1234-5678-9abc-123456789abc', size: 8 };
    const requests: { id: string; index: number }[] = [];
    let views: PackView[] = [];
    const transfer = new PackTransfer(
        {
            async response() {},
            async request(id, _version, index) {
                requests.push({ id, index });
            },
        },
        async (bytes) => ({ name: 'Processed pack', archive: bytes }),
        controller.signal,
        (value) => {
            views = value;
        },
        () => {},
        () => {},
    );
    await transfer.handle({ type: 'packs-info', packs: [{ ...offer, size: 8 }, second] });
    for (const pack of [offer, second]) {
        await transfer.handle({
            type: 'pack-data',
            id: pack.id,
            version: pack.version,
            size: 8,
            chunkCount: 8,
            chunkSize: 1,
            hash: sha256(data),
        });
    }
    assert.equal(requests.length, 4, 'four requests total, not four per pack');
    assert(requests.every((request) => request.id === offer.id));
    for (let index = 0; index < 8; index++) {
        await transfer.handle({
            type: 'pack-chunk',
            id: offer.id,
            version: offer.version,
            index,
            progress: index,
            data: new Uint8Array(1),
        });
    }
    assert.equal(views[0]!.status, 'ready');
    assert(requests.some((request) => request.id === second.id));
    controller.abort();
    assert.equal(views[0]!.status, 'ready');
    assert.equal(views[1]!.status, 'error');
});

test('native pack bridge accepts full 1 MiB chunks including packet overhead', () => {
    const data = new Uint8Array(1024 * 1024);
    const event = codec.read(chunkPacket(offer, data, data.length, 0));
    assert.equal(event.type, 'pack-chunk');
    if (event.type === 'pack-chunk') assert.equal(event.data.length, data.length);
});

test('pack-data sizes that differ from the announcement are downloaded and verified', async (t) => {
    const h = harness();
    t.after(() => h.controller.abort());
    const data = fixture();
    const announced = { ...offer, size: data.length - 3 };
    await h.transfer.handle({ type: 'packs-info', packs: [announced] });
    await h.transfer.handle(h.read(dataPacket({ ...offer, size: data.length }, data, 128)));
    assert.equal(h.views[0]!.size, data.length);
    for (let index = 0; index < Math.ceil(data.length / 128); index++) {
        await h.transfer.handle(h.read(chunkPacket(offer, data, 128, index)));
    }
    assert.equal(h.views[0]!.status, 'ready');
    assert.equal(h.views[0]!.received, data.length);
    assert.deepEqual(h.responses, [2, 3]);
});

test('the CDN fetcher is called without a receiver, as browsers require for fetch', async (t) => {
    const data = fixture();
    const h = harness(async function (this: unknown) {
        assert.equal(this, undefined);
        return new Response(data);
    });
    t.after(() => h.controller.abort());
    await h.transfer.handle({
        type: 'packs-info',
        packs: [{ ...offer, size: data.length, cdnUrl: 'https://cdn.example.test/pack' }],
    });
    assert.deepEqual(h.responses, [3]);
});
