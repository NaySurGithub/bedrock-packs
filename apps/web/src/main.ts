import type { ServerAnnouncement } from './query.js';
import { mountConnectionError } from './connection/error-dialog.js';
import { mountPacks } from './packs/ui.js';
import './style.css';
import { loadQueryModule } from './query.js';
import { mountAccount } from './auth/ui.js';
import type { AccountClient } from './auth/client.js';
import { connectBedrock } from './connection/session.js';

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
    <header class="app-header">
        <a class="brand" href="./" aria-label="Bedrock Packs">
            <svg viewBox="0 0 28 28" fill="none" aria-hidden="true">
                <path d="M14 2 25 8v12l-11 6L3 20V8L14 2Z" stroke="currentColor" stroke-width="1.6" />
                <path d="m3 8 11 6 11-6M14 14v12M8.5 5l11 6v6" stroke="currentColor" stroke-width="1.6" />
            </svg>
            <span>Bedrock Packs</span>
        </a>
        <button id="account" class="account-button" type="button" disabled>
            <svg viewBox="0 0 20 20" aria-hidden="true">
                <path fill="#f35325" d="M1 1h8v8H1z" />
                <path fill="#81bc06" d="M11 1h8v8h-8z" />
                <path fill="#05a6f0" d="M1 11h8v8H1z" />
                <path fill="#ffba08" d="M11 11h8v8h-8z" />
            </svg>
            <span class="account-label">Sign in with Microsoft</span>
        </button>
    </header>

    <main class="app-layout">
        <aside class="connection-panel" aria-labelledby="connection-title">
            <h1 id="connection-title">Connection</h1>

            <form id="server-form">
                <label for="host">Server address</label>
                <input
                    id="host"
                    name="host"
                    placeholder="play.example.net"
                    autocomplete="off"
                    spellcheck="false"
                    required
                    maxlength="253"
                />

                <label for="port">Port</label>
                <input
                    id="port"
                    name="port"
                    type="number"
                    value="19132"
                    min="1"
                    max="65535"
                    required
                />

                <button id="connect" class="primary-button" type="submit" disabled>
                    Join server
                </button>
            </form>

            <div class="connection-status">
                <span id="runtime">Loading client…</span>
                <p id="status" role="status" aria-live="polite"></p>
            </div>

            <dl id="result" class="server-details" hidden></dl>
        </aside>

        <section class="packs-panel" aria-labelledby="packs-title">
            <div class="packs-toolbar">
                <h2 id="packs-title">Server packs</h2>
                <button class="download-button" type="button" disabled>
                    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                        <path d="M10 3v9m-3-3 3 3 3-3M4 13v4h12v-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                    Download all
                </button>
            </div>

            <div class="pack-table-container">
                <table class="pack-table">
                    <thead>
                        <tr>
                            <th scope="col">Name</th>
                            <th scope="col">Version</th>
                            <th scope="col">Size</th>
                            <th scope="col">Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td colspan="4" class="empty-cell">
                                <div class="empty-state">
                                    <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
                                        <path d="M9 15h12l4 4h14v19H9V15Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
                                        <path d="M9 19v-8h15l4 4h11v4" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
                                    </svg>
                                    <p>No packs loaded</p>
                                    <span>Resource packs offered by the server will appear here.</span>
                                </div>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>

            <div class="packs-footer">0 packs</div>
        </section>
    </main>
`;

const form = document.querySelector<HTMLFormElement>('#server-form')!;
const button = document.querySelector<HTMLButtonElement>('#connect')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const runtime = document.querySelector<HTMLSpanElement>('#runtime')!;
const result = document.querySelector<HTMLDListElement>('#result')!;
const packList = mountPacks(document.querySelector<HTMLElement>('.packs-panel')!);
const connectionError = mountConnectionError(app);
const modulePromise = loadQueryModule();
let unmountAccount: (() => void) | undefined;
let account: AccountClient | undefined;

let active: AbortController | undefined;

void modulePromise
    .then((module) => {
        runtime.textContent = 'Client ready';
        button.disabled = false;
        const accountButton = document.querySelector<HTMLButtonElement>('#account')!;

        try {
            unmountAccount = mountAccount(accountButton, module.authConfig(), (client) => {
                account = client;
            });
        } catch (error: unknown) {
            accountButton.title =
                error instanceof Error ? error.message : 'Account services are unavailable.';
        }
    })
    .catch(() => {
        runtime.textContent = 'Client unavailable';
        status.textContent = 'Build the WebAssembly module before connecting.';
    });

function showServer(server: ServerAnnouncement): void {
    result.replaceChildren();

    for (const [label, value] of [
        ['Server', server.name],
        ['Transport', server.transport],
        ['Version', server.version],
        ['Protocol', server.protocol],
        ['Players', `${server.players} / ${server.capacity}`],
        ['Latency', `${server.latency} ms`],
    ]) {
        const term = document.createElement('dt');
        const detail = document.createElement('dd');

        term.textContent = label ?? '';
        detail.textContent = value ?? '';
        result.append(term, detail);
    }

    result.hidden = false;
}

form.addEventListener('submit', (event) => {
    event.preventDefault();

    if (active) {
        active.abort();
        active = undefined;
        button.textContent = 'Join server';
        status.textContent = 'Connection cancelled.';
        packList.stop(status.textContent);
        return;
    }

    connectionError.dismiss();
    packList.reset();
    active = new AbortController();
    const attempt = active;

    const host = document.querySelector<HTMLInputElement>('#host')!.value.trim();
    const port = Number(document.querySelector<HTMLInputElement>('#port')!.value);
    const signal = active.signal;

    button.textContent = 'Cancel';
    result.hidden = true;
    status.textContent = 'Detecting server transport…';

    void modulePromise
        .then((module) => {
            if (!account) {
                throw new Error('Microsoft sign-in is unavailable.');
            }

            return connectBedrock(
                module,
                account,
                host,
                port,
                signal,
                (state) => {
                    if (active !== attempt) {
                        return;
                    }

                    status.textContent = state.message;
                    if (state.phase !== 'disconnected')
                        packList.connection(state.message, state.phase !== 'ready');
                    if (state.destination) {
                        document.querySelector<HTMLInputElement>('#host')!.value =
                            state.destination.host;
                        document.querySelector<HTMLInputElement>('#port')!.value = String(
                            state.destination.port,
                        );
                    }
                    if (state.server) showServer(state.server);

                    if (state.phase === 'transferring') {
                        result.hidden = true;
                        button.textContent = 'Cancel';
                    } else if (state.phase === 'connected') {
                        button.textContent = 'Disconnect';
                    } else if (state.phase === 'disconnected') {
                        active = undefined;
                        button.textContent = 'Join server';
                        packList.stop(state.message);
                        result.hidden = true;
                        if (state.outcome === 'error') connectionError.show(state.message);
                    }
                },
                (packs) => {
                    if (active === attempt) packList.update(packs);
                },
            );
        })
        .catch((error: unknown) => {
            if (active !== attempt) {
                return;
            }

            active = undefined;
            button.textContent = 'Join server';
            status.textContent = error instanceof Error ? error.message : 'Connection failed.';
            packList.stop(status.textContent);
            result.hidden = true;
            if (!signal.aborted) connectionError.show(status.textContent);
        });
});

window.addEventListener('pagehide', () => active?.abort());

if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        active?.abort();
        unmountAccount?.();
        packList.dispose();
        connectionError.dispose();
    });
}
