import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unzipSync, zipSync } from 'fflate';
import { processArchive, zipFiles } from '../apps/web/src/packs/archive.js';
import type { PackProgress } from '../apps/web/src/packs/types.js';
import { fixture, offer, plaintext, encode, packId } from './pack-fixture.js';

for (const encrypted of [false, true]) {
    test(`exports a usable ${encrypted ? 'encrypted' : 'plain'} server pack, preserving subpacks`, async () => {
        const progress: PackProgress[] = [];
        const result = await processArchive(
            fixture(encrypted),
            { ...offer, key: encrypted ? offer.key : '' },
            (value) => progress.push(value),
        );
        const files = unzipSync(result.archive);
        assert.equal(result.name, 'Fixture Pack');
        assert.deepEqual(files['textures/terrain_texture.json'], plaintext);
        assert.equal(new TextDecoder().decode(files['subpacks/low/extra.json']), '{"low":true}');
        assert.equal(
            JSON.parse(new TextDecoder().decode(files['manifest.json'])).header.uuid,
            packId,
        );
        assert(!Object.keys(files).some((name) => name.endsWith('contents.json')));
        assert.deepEqual(
            [...new Set(progress.map((value) => value.stage))],
            ['opening', 'decrypting', 'exporting'],
        );
    });
}
test('normalizes one enclosing ZIP directory', async () => {
    const files = unzipSync((await processArchive(fixture(true, true), offer)).archive);
    assert(files['manifest.json']);
    assert(!Object.keys(files).some((name) => name.startsWith('enclosing/')));
});
test('rejects missing or incorrect content keys and mismatched manifests', async () => {
    await assert.rejects(processArchive(fixture(), { ...offer, key: '' }), /content key/);
    await assert.rejects(
        processArchive(fixture(), { ...offer, key: 'x'.repeat(32) }),
        /decrypt the pack index/,
    );
    await assert.rejects(
        processArchive(fixture(), { ...offer, id: '00000000-0000-0000-0000-000000000000' }),
        /does not match/,
    );
});
test('rejects corrupt archives, unsafe paths and encrypted packs without an index', async () => {
    await assert.rejects(processArchive(encode('not a zip'), offer), /ZIP/);
    const files = unzipSync(fixture(false));
    files['../escape.json'] = encode('{}');
    await assert.rejects(processArchive(zipSync(files), { ...offer, key: '' }), /unsafe file path/);
    await assert.rejects(processArchive(fixture(false), offer), /no contents.json/);
});
test('download all archive contains importable .mcpack files', async () => {
    const result = await processArchive(fixture(), offer);
    const all = unzipSync(await zipFiles({ 'Fixture Pack.mcpack': result.archive }));
    assert.deepEqual(
        unzipSync(all['Fixture Pack.mcpack']!)['textures/terrain_texture.json'],
        plaintext,
    );
});

test('opens large packs with more than 10000 small files', async () => {
    const files = unzipSync(fixture(false));
    for (let index = 0; index < 12200; index++) {
        files[`textures/many/${index}.json`] = encode('{}');
    }
    const result = await processArchive(zipSync(files, { level: 0 }), { ...offer, key: '' });
    assert.equal(Object.keys(unzipSync(result.archive)).length, Object.keys(files).length);
});
