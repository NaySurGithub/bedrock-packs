import './style.css';
import { loadQueryModule, queryServer } from './query';

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
    <header class="header">
        <a class="brand" href="/" aria-label="Bedrock Packs home"><span class="brand-mark">▧</span> Bedrock Packs</a>
        <span class="header-caption">Your server. Your workspace.</span>
    </header>
    <main>
        <section class="intro">
            <span class="eyebrow">BEDROCK RESOURCE PACKS</span>
            <h1>Start with<br />your server.</h1>
            <p>A direct connection to the resources behind your world.<br class="desktop-break" /> Processed in your browser, powered by WebAssembly.</p>
        </section>
        <section class="workspace" aria-labelledby="workspace-title">
            <div class="workspace-heading">
                <div><span class="step">01 / CONNECTION</span><h2 id="workspace-title">Connect to a server</h2></div>
                <span id="runtime" class="runtime">Loading client…</span>
            </div>
            <form id="server-form">
                <div class="fields">
                    <label class="address-field">Server address<input id="host" name="host" placeholder="play.example.net" autocomplete="off" spellcheck="false" required maxlength="253" /></label>
                    <label class="port-field">Port<input id="port" name="port" type="number" value="19132" min="1" max="65535" required /></label>
                </div>
                <div class="form-footer"><span>Bedrock Edition · RakNet</span><button id="connect" type="submit" disabled>Check server <span aria-hidden="true">↗</span></button></div>
            </form>
            <div id="status" role="status" aria-live="polite">Enter an address to check the server connection.</div>
            <dl id="result" class="result" hidden></dl>
        </section>
        <div class="details">
            <div><span class="detail-index">01</span><h3>Browser processing</h3><p>The WebAssembly client runs on your device.</p></div>
            <div><span class="detail-index">02</span><h3>Minimal relay</h3><p>A WebSocket bridge carries datagrams to the server.</p></div>
            <div><span class="detail-index">03</span><h3>Open by design</h3><p>A focused codebase you can inspect and self-host.</p></div>
        </div>
        <p class="development-note">Connection preview · Microsoft sign-in and pack export are under development.</p>
    </main>
    <footer><span>BEDROCK PACKS</span><span>Independent project. Not affiliated with Mojang or Microsoft.</span></footer>
`;

const form = document.querySelector<HTMLFormElement>('#server-form')!;
const button = document.querySelector<HTMLButtonElement>('#connect')!;
const status = document.querySelector<HTMLDivElement>('#status')!;
const runtime = document.querySelector<HTMLSpanElement>('#runtime')!;
const result = document.querySelector<HTMLDListElement>('#result')!;
const modulePromise = loadQueryModule();
let active: AbortController | undefined;

void modulePromise
    .then(() => {
        runtime.textContent = 'WASM ready';
        runtime.classList.add('ready');
        button.disabled = false;
    })
    .catch((error: unknown) => {
        runtime.textContent = 'Client unavailable';
        status.textContent = error instanceof Error ? error.message : 'Could not load the client.';
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
    status.textContent = 'Opening relay and waiting for the Bedrock server…';

    void modulePromise
        .then((module) => queryServer(module, host, port, signal))
        .then((server) => {
            status.textContent = 'Server reachable. The WebAssembly transport is working.';
            result.replaceChildren();

            for (const [label, value] of [
                ['Server', server.name],
                ['Version', `${server.version} · protocol ${server.protocol}`],
                ['Players', `${server.players} / ${server.capacity}`],
                ['Round trip', `${server.latency} ms`],
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
            button.innerHTML = 'Check server <span aria-hidden="true">↗</span>';
        });
});

window.addEventListener('pagehide', () => active?.abort());
