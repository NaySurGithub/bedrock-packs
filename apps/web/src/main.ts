import './style.css';
import { loadQueryModule, queryServer } from './query';

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
        <button class="account-button" type="button" disabled title="Microsoft sign-in is being integrated">
            <svg viewBox="0 0 20 20" aria-hidden="true">
                <path fill="#f35325" d="M1 1h8v8H1z" />
                <path fill="#81bc06" d="M11 1h8v8h-8z" />
                <path fill="#05a6f0" d="M1 11h8v8H1z" />
                <path fill="#ffba08" d="M11 11h8v8h-8z" />
            </svg>
            Sign in with Microsoft
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
                    Check server
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
const modulePromise = loadQueryModule();

let active: AbortController | undefined;

void modulePromise
    .then(() => {
        runtime.textContent = 'Client ready';
        button.disabled = false;
    })
    .catch(() => {
        runtime.textContent = 'Client unavailable';
        status.textContent = 'Build the WebAssembly module before connecting.';
    });

form.addEventListener('submit', (event) => {
    event.preventDefault();
    active?.abort();
    active = new AbortController();

    const host = document.querySelector<HTMLInputElement>('#host')!.value.trim();
    const port = Number(document.querySelector<HTMLInputElement>('#port')!.value);
    const signal = active.signal;

    button.disabled = true;
    button.textContent = 'Connecting…';
    result.hidden = true;
    status.textContent = 'Detecting server transport…';

    void modulePromise
        .then((module) => queryServer(module, host, port, signal))
        .then((server) => {
            status.textContent = 'Server reachable.';
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
        })
        .catch((error: unknown) => {
            status.textContent = error instanceof Error ? error.message : 'Connection failed.';
        })
        .finally(() => {
            button.disabled = false;
            button.textContent = 'Check server';
        });
});

window.addEventListener('pagehide', () => active?.abort());
