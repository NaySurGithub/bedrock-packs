import { zipFiles } from './archive.js';
import type { PackView } from './types.js';

function fileName(pack: PackView): string {
    const name =
        pack.name
            .replace(/§./g, '')
            .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
            .replace(/[. ]+$/, '')
            .slice(0, 100) || pack.id;
    return `${name}-${pack.version.replace(/[^\w.-]/g, '_')}-${pack.id.slice(0, 8)}.mcpack`;
}

function size(bytes: number): string {
    return bytes < 1024 * 1024
        ? `${(bytes / 1024).toFixed(1)} KiB`
        : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function mountPacks(root: HTMLElement) {
    const body = root.querySelector<HTMLTableSectionElement>('tbody')!;
    const button = root.querySelector<HTMLButtonElement>('.download-button')!;
    const footer = root.querySelector<HTMLElement>('.packs-footer')!;
    const summary = document.createElement('div');
    summary.className = 'packs-progress';
    summary.hidden = true;
    const stage = document.createElement('p');
    stage.setAttribute('role', 'status');
    const overall = document.createElement('progress');
    overall.setAttribute('aria-label', 'Overall pack download');
    const metrics = document.createElement('p');
    metrics.className = 'progress-metrics';
    summary.append(stage, overall, metrics);
    root.querySelector('.packs-toolbar')!.after(summary);
    const empty = body.innerHTML;
    const urls = new Map<string, string>();
    const rows = new Map<
        string,
        { row: HTMLTableRowElement; state: HTMLTableCellElement; previous: string }
    >();
    let packs: PackView[] = [];
    let generation = 0;
    let bundling = false;
    let busy = false;
    let started = 0;
    let stopped = 0;
    let message = '';
    let lastData = 0;
    let previousBytes = 0;
    let samples: { time: number; bytes: number }[] = [];
    const statusLabels = {
        opening: 'Opening archive',
        decrypting: 'Decrypting files',
        exporting: 'Creating .mcpack',
    };
    const refreshSummary = () => {
        if (!started) return;
        const now = Date.now();
        const received = packs.reduce((sum, pack) => sum + pack.received, 0);
        const total = packs.reduce((sum, pack) => sum + pack.size, 0);
        if (received > previousBytes) lastData = now;
        previousBytes = received;
        samples.push({ time: now, bytes: received });
        while (samples.length > 1 && samples[1]!.time < now - 10000) samples.shift();
        const first = samples[0]!;
        const rate = Math.max(0, received - first.bytes) / Math.max(1, (now - first.time) / 1000);
        const elapsed = Math.floor(((busy ? now : stopped || now) - started) / 1000);
        const ready = packs.filter((pack) => pack.status === 'ready').length;
        const processing = packs.find((pack) => pack.status === 'processing');
        const waiting = packs.some((pack) => pack.status === 'waiting');
        stage.textContent = bundling
            ? 'Preparing the download ZIP…'
            : processing
              ? `${processing.activity ? statusLabels[processing.activity.stage] : 'Preparing pack'} · ${processing.name}`
              : busy && total > received
                ? 'Receiving server packs…'
                : message;
        if (total) {
            overall.max = total;
            overall.value = received;
        } else if (busy) overall.removeAttribute('value');
        else {
            overall.max = 1;
            overall.value = 0;
        }
        summary.classList.toggle('is-working', busy || bundling);
        summary.setAttribute('aria-busy', String(busy || bundling));
        const parts = [`${elapsed}s elapsed`];
        if (total)
            parts.push(
                `${size(received)} / ${size(total)} (${Math.floor((received / total) * 100)}%)`,
                `${ready}/${packs.length} ready`,
            );
        if (busy && total > received) parts.push(`${size(rate)}/s`);
        if (busy && !processing && now - lastData >= 5000) {
            parts.push(
                `${waiting ? 'Waiting for server' : 'No new pack data'} · ${Math.floor((now - lastData) / 1000)}s`,
            );
        }
        metrics.textContent = parts.join(' · ');
    };
    const timer = setInterval(refreshSummary, 1000);

    const clearUrls = () => {
        for (const url of urls.values()) URL.revokeObjectURL(url);
        urls.clear();
    };
    const updateButton = () => {
        button.disabled =
            bundling || !packs.length || packs.some((pack) => pack.status !== 'ready');
    };
    const update = (next: PackView[]) => {
        packs = next;
        const ids = new Set(packs.map((pack) => pack.id));
        for (const [id, entry] of rows) {
            if (!ids.has(id)) {
                entry.row.remove();
                rows.delete(id);
                const url = urls.get(id);
                if (url) {
                    URL.revokeObjectURL(url);
                    urls.delete(id);
                }
            }
        }
        if (!packs.length) {
            body.innerHTML = empty;
            rows.clear();
        } else if (!rows.size) body.replaceChildren();
        for (const pack of packs) {
            const existing = rows.get(pack.id);
            const row = existing?.row ?? document.createElement('tr');
            if (existing?.previous === 'ready' && pack.status === 'ready') continue;
            row.replaceChildren();
            const name = document.createElement('td');
            name.textContent = pack.name;
            name.title = pack.id;
            const version = document.createElement('td');
            version.textContent = pack.version;
            const bytes = document.createElement('td');
            bytes.textContent =
                pack.status === 'downloading'
                    ? `${size(pack.received)} / ${size(pack.size)}`
                    : size(pack.size);
            const state = document.createElement('td');
            state.className = 'pack-state';
            if (pack.status === 'ready' && pack.archive) {
                let url = urls.get(pack.id);
                if (!url) {
                    url = URL.createObjectURL(
                        new Blob([pack.archive], { type: 'application/zip' }),
                    );
                    urls.set(pack.id, url);
                }
                const link = document.createElement('a');
                link.href = url;
                link.download = fileName(pack);
                link.textContent = 'Download .mcpack';
                state.append(link);
            } else if (pack.status === 'downloading') {
                const progress = document.createElement('progress');
                progress.max = pack.size;
                progress.value = pack.received;
                progress.setAttribute('aria-label', `Downloading ${pack.name}`);
                const label = document.createElement('span');
                label.textContent = `${Math.floor((pack.received / pack.size) * 100)}%`;
                state.append(progress, label);
            } else if (pack.status === 'processing') {
                const progress = document.createElement('progress');
                const activity = pack.activity;
                if (activity?.total) {
                    progress.max = activity.total;
                    progress.value = activity.completed;
                }
                progress.setAttribute('aria-label', `Processing ${pack.name}`);
                const label = document.createElement('span');
                label.textContent = activity
                    ? `${statusLabels[activity.stage]}${activity.total ? ` · ${activity.completed}/${activity.total}` : '…'}`
                    : 'Preparing pack…';
                state.append(progress, label);
            } else {
                state.textContent =
                    pack.status === 'error'
                        ? (pack.error ?? 'Download failed.')
                        : 'Waiting for server…';
                if (pack.status === 'error') state.classList.add('pack-error');
            }
            row.append(name, version, bytes, state);
            if (!existing) body.append(row);
            rows.set(pack.id, { row, state, previous: pack.status });
        }
        const ready = packs.filter((pack) => pack.status === 'ready').length;
        footer.textContent = `${packs.length} pack(s) · ${ready} ready`;
        updateButton();
        refreshSummary();
    };
    const downloadAll = async () => {
        const ready = packs.filter((pack) => pack.status === 'ready' && pack.archive);
        if (!ready.length || bundling) return;
        bundling = true;
        const current = generation;
        updateButton();
        footer.textContent = 'Preparing download…';
        refreshSummary();
        try {
            const files = Object.fromEntries(ready.map((pack) => [fileName(pack), pack.archive!]));
            const bundle = await zipFiles(files);
            if (current !== generation) return;
            const url = URL.createObjectURL(new Blob([bundle], { type: 'application/zip' }));
            const link = document.createElement('a');
            link.href = url;
            link.download = 'bedrock-packs.zip';
            document.body.append(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60000);
            footer.textContent = `Download started · ${ready.length} .mcpack file(s) in bedrock-packs.zip`;
        } catch {
            if (current === generation)
                footer.textContent =
                    'Could not prepare the download. Try downloading packs individually.';
        } finally {
            if (current === generation) {
                bundling = false;
                updateButton();
                refreshSummary();
            }
        }
    };
    button.addEventListener('click', downloadAll);
    return {
        update,
        connection(text: string, running: boolean) {
            message = text;
            busy = running;
            if (!running) stopped = Date.now();
            refreshSummary();
        },
        stop(text: string) {
            busy = false;
            stopped = Date.now();
            message = text;
            summary.hidden = true;
            summary.classList.remove('is-working');
            summary.setAttribute('aria-busy', 'false');
            overall.remove();
            // Drop interrupted rows and their progress controls; ready exports stay usable.
            update(packs.filter((pack) => pack.status === 'ready'));
        },
        reset() {
            generation++;
            clearUrls();
            busy = true;
            bundling = false;
            started = Date.now();
            stopped = 0;
            lastData = started;
            previousBytes = 0;
            samples = [{ time: started, bytes: 0 }];
            message = 'Preparing connection…';
            if (!overall.isConnected) stage.after(overall);
            summary.hidden = false;
            update([]);
        },
        dispose() {
            generation++;
            clearUrls();
            clearInterval(timer);
            button.removeEventListener('click', downloadAll);
            summary.remove();
        },
    };
}
