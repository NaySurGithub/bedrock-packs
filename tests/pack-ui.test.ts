import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { mountPacks } from '../apps/web/src/packs/ui.js';
import type { PackView } from '../apps/web/src/packs/types.js';
import { fixture, offer } from './pack-fixture.js';

test('site exposes real progress, processing stages, elapsed time, errors and download links', (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.UTC(2026, 9, 20) });
    const dom = new JSDOM(
        '<section><div class="packs-toolbar"></div><button class="download-button" disabled>Download all</button><table><tbody><tr><td>No packs loaded</td></tr></tbody></table><div class="packs-footer"></div></section>',
    );
    const previousDocument = globalThis.document;
    globalThis.document = dom.window.document;
    const root = document.querySelector('section')!;
    const ui = mountPacks(root);
    t.after(() => {
        ui.dispose();
        globalThis.document = previousDocument;
        dom.window.close();
    });
    ui.reset();
    ui.connection('Detecting server transport…', true);
    assert.match(root.textContent!, /Detecting server transport/);
    t.mock.timers.tick(6000);
    assert.match(root.textContent!, /6s elapsed/);
    assert.match(root.textContent!, /Waiting|No new pack data/);
    const pack: PackView = {
        id: offer.id,
        name: '<script>test</script>',
        version: '1.0.0',
        size: 1000,
        received: 250,
        status: 'downloading',
    };
    ui.update([pack]);
    assert.equal(root.querySelector('progress')!.value, 250);
    assert.match(root.textContent!, /25%/);
    assert(!root.querySelector('script'), 'server pack names are rendered as text');
    ui.update([
        {
            ...pack,
            received: 1000,
            status: 'processing',
            activity: { stage: 'decrypting', completed: 16, total: 32 },
        },
    ]);
    assert.match(root.textContent!, /Decrypting files · 16\/32/);
    assert.equal(root.querySelector<HTMLProgressElement>('td progress')!.value, 16);
    ui.update([{ ...pack, received: 1000, status: 'ready', archive: fixture(false) }]);
    assert.equal(root.querySelector<HTMLButtonElement>('button')!.disabled, false);
    assert.match(root.querySelector<HTMLAnchorElement>('a')!.download, /\.mcpack$/);
    const ready = { ...pack, received: 1000, status: 'ready' as const, archive: fixture(false) };
    const link = root.querySelector('a');
    ui.connection('Transfer 1: connecting to lobby.example.test:19133…', true);
    assert.match(root.querySelector('.packs-progress')!.textContent!, /lobby.example.test:19133/);
    assert.equal(root.querySelector('a'), link);
    ui.update([
        ready,
        { ...pack, id: '22222222-1234-5678-9abc-123456789abc', status: 'downloading' },
    ]);
    assert.equal(
        root.querySelector('a'),
        link,
        'ready links remain stable while other packs advance',
    );
    assert.equal(
        root.querySelector<HTMLButtonElement>('button')!.disabled,
        true,
        'download all waits for all packs',
    );
    ui.update([ready]);
    ui.connection('1 pack ready to download.', false);
    t.mock.timers.tick(5000);
    assert.match(root.textContent!, /6s elapsed/);
    assert(!root.querySelector('.is-working'));
    ui.reset();
    ui.update([{ ...pack, status: 'error', error: 'The server stopped sending packs.' }]);
    ui.connection('Download failed.', false);
    assert.match(root.textContent!, /server stopped/);
    assert.equal(root.querySelector<HTMLButtonElement>('button')!.disabled, true);
});

test('Download all button prepares a ZIP containing the ready .mcpack archives', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const dom = new JSDOM(
        '<section><div class="packs-toolbar"></div><button class="download-button">Download all</button><table><tbody></tbody></table><div class="packs-footer"></div></section>',
    );
    const previousDocument = globalThis.document;
    globalThis.document = dom.window.document;
    const root = document.querySelector('section')!;
    const ui = mountPacks(root);
    t.after(() => {
        ui.dispose();
        globalThis.document = previousDocument;
        dom.window.close();
    });
    const download = new Promise<HTMLAnchorElement>((resolve) => {
        dom.window.HTMLAnchorElement.prototype.click = function () {
            resolve(this);
        };
    });
    const archive = fixture(false);
    ui.reset();
    ui.update([
        {
            id: offer.id,
            version: offer.version,
            name: 'Fixture',
            size: archive.length,
            received: archive.length,
            status: 'ready',
            archive,
        },
    ]);
    ui.connection('Ready.', false);
    root.querySelector<HTMLButtonElement>('button')!.click();
    const link = await download;
    assert.equal(link.download, 'bedrock-packs.zip');
    const response = await fetch(link.href);
    const { unzipSync } = await import('fflate');
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
    assert.equal(Object.keys(files).length, 1);
    assert.match(Object.keys(files)[0]!, /\.mcpack$/);
    assert(unzipSync(Object.values(files)[0]!)['manifest.json']);
    URL.revokeObjectURL(link.href);
});

test('a failed connection removes progress controls, preserves ready packs and can retry', (t) => {
    const dom = new JSDOM(
        '<section><div class="packs-toolbar"></div><button class="download-button">Download all</button><table><tbody></tbody></table><div class="packs-footer"></div></section>',
    );
    const previous = globalThis.document;
    globalThis.document = dom.window.document;
    const root = document.querySelector('section')!;
    const ui = mountPacks(root);
    t.after(() => {
        ui.dispose();
        globalThis.document = previous;
        dom.window.close();
    });
    ui.reset();
    const ready: PackView = {
        id: offer.id,
        version: offer.version,
        name: 'Ready pack',
        size: 100,
        received: 100,
        status: 'ready',
        archive: fixture(false),
    };
    ui.update([
        ready,
        {
            ...ready,
            id: '22222222-1234-5678-9abc-123456789abc',
            name: 'Interrupted pack',
            received: 30,
            status: 'downloading',
        },
    ]);
    assert.equal(root.querySelectorAll('progress').length, 2);
    const download = root.querySelector('a');
    ui.stop('The server closed the connection.');
    assert.equal(root.querySelectorAll('progress').length, 0);
    assert.equal(root.querySelector<HTMLElement>('.packs-progress')!.hidden, true);
    assert(!root.querySelector('.is-working'));
    assert(!root.textContent!.includes('Interrupted pack'));
    assert.equal(root.querySelector('a'), download);
    ui.reset();
    assert.equal(root.querySelector<HTMLElement>('.packs-progress')!.hidden, false);
    assert.equal(root.querySelectorAll('progress').length, 1);
    assert.equal(root.querySelector('a'), null);
});
