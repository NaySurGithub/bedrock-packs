import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { mountConnectionError } from '../apps/web/src/connection/error-dialog.js';
import { raknetDisconnectMessage } from '../apps/web/src/connection/transport.js';

test('error popup shows the exact reason as text, can close and reopen without duplicates', (t) => {
    const dom = new JSDOM('<main></main>');
    const previous = globalThis.document;
    globalThis.document = dom.window.document;
    // The DOM test runner models modal methods; no browser window is opened.
    dom.window.HTMLDialogElement.prototype.showModal = function () {
        this.open = true;
    };
    dom.window.HTMLDialogElement.prototype.close = function () {
        this.open = false;
    };
    const popup = mountConnectionError(document.querySelector('main')!);
    t.after(() => {
        popup.dispose();
        globalThis.document = previous;
        dom.window.close();
    });
    const reason = 'Server says: <img src=x onerror=alert(1)>\nTry again later.';
    popup.show(reason);
    const dialog = document.querySelector('dialog')!;
    assert(dialog.open);
    assert.equal(dialog.querySelector('p')!.textContent, reason);
    assert.equal(dialog.querySelector('img'), null);
    popup.show('RakNet: the server is full.');
    assert.equal(document.querySelectorAll('dialog').length, 1);
    assert.match(dialog.textContent!, /server is full/);
    dialog.querySelector('button')!.click();
    assert(!dialog.open);
    popup.show('The NetherNet data channel closed.');
    assert(dialog.open);
    popup.dismiss();
    assert(!dialog.open);
});

test('RakNet refusal and closure packets retain their specific reasons', () => {
    assert.match(raknetDisconnectMessage(0x14)!, /full/);
    assert.match(raknetDisconnectMessage(0x16)!, /lost/);
    assert.match(raknetDisconnectMessage(0x17)!, /banned/);
    assert.match(raknetDisconnectMessage(0x18)!, /password/);
    assert.match(raknetDisconnectMessage(0x19)!, /incompatible/);
    assert.match(raknetDisconnectMessage(0x1a)!, /too recently/);
    assert.equal(raknetDisconnectMessage(0xfe), undefined);
});
