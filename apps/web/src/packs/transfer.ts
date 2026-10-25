import type { PackEvent, PackOffer, PackView, PackProgress, ProcessedPack } from './types.js';
import { MAX_PACK_SIZE, MAX_SESSION_SIZE } from './types.js';
import { debug, debugFile, debugging, redact } from '../debug.js';

interface Download {
    offer: PackOffer;
    view: PackView;
    info?: Extract<PackEvent, { type: 'pack-data' }>;
    bytes?: Uint8Array<ArrayBuffer> | undefined;
    received: Set<number>;
    requested: Set<number>;
    next: number;
}

export interface PackTransport {
    response(status: number, ids?: string[]): Promise<void>;
    request(id: string, version: string, index: number): Promise<void>;
}

type Processor = (
    bytes: Uint8Array<ArrayBuffer>,
    offer: PackOffer,
    signal: AbortSignal,
    progress: (value: PackProgress) => void,
) => Promise<ProcessedPack>;

export class PackTransfer {
    #downloads = new Map<string, Download>();
    #announced = false;
    #haveAll = false;
    #finished = false;
    #timer: ReturnType<typeof setTimeout> | undefined;

    constructor(
        private readonly transport: PackTransport,
        private readonly process: Processor,
        private readonly signal: AbortSignal,
        private readonly changed: (packs: PackView[]) => void,
        private readonly completed: (count: number) => void,
        private readonly failed: (error: Error) => void,
        private readonly fetcher: typeof fetch = fetch,
    ) {
        signal.addEventListener('abort', () => this.cancel(), { once: true });
    }

    #emit(): void {
        this.changed([...this.#downloads.values()].map(({ view }) => ({ ...view })));
    }

    #touch(): void {
        clearTimeout(this.#timer);
        if (this.#finished || this.signal.aborted) return;
        this.#timer = setTimeout(() => {
            debug('packs', 'negotiation timed out after 45 s without a pack packet');
            this.cancel('The server stopped sending resource packs.');
            this.failed(new Error('Resource-pack negotiation timed out.'));
        }, 45000);
    }

    start(): void {
        this.#touch();
    }

    cancel(message = 'Download cancelled.'): void {
        clearTimeout(this.#timer);
        debug('packs', 'cancel', { reason: message });
        for (const download of this.#downloads.values()) {
            download.bytes = undefined;
            download.offer.key = '';
            download.offer.cdnUrl = '';
            if (download.view.status !== 'ready' && download.view.status !== 'error') {
                download.view.status = 'error';
                download.view.error = message;
            }
        }
        this.#emit();
    }

    async handle(event: PackEvent): Promise<void> {
        this.signal.throwIfAborted();
        if (this.#finished) throw new Error('Unexpected pack packet after negotiation.');
        this.#touch();
        try {
            switch (event.type) {
                case 'packs-info':
                    await this.#offers(event.packs);
                    break;
                case 'pack-data':
                    await this.#data(event);
                    break;
                case 'pack-chunk':
                    await this.#chunk(event);
                    break;
                case 'packs-stack':
                    debug('packs', 'packs-stack received', { haveAll: this.#haveAll });
                    if (!this.#haveAll)
                        throw new Error(
                            'The server applied the pack stack before downloads finished.',
                        );
                    await this.transport.response(4);
                    this.#finished = true;
                    clearTimeout(this.#timer);
                    this.completed(this.#downloads.size);
                    break;
            }
        } catch (error) {
            const failure = error instanceof Error ? error : new Error('Pack download failed.');
            debug('packs', 'failed', { event: event.type, error: failure.message });
            this.cancel(failure.message);
            throw failure;
        }
    }

    async #offers(offers: PackOffer[]): Promise<void> {
        debug('packs', 'packs-info received', {
            count: offers.length,
            packs: offers.map((offer) => ({
                id: offer.id,
                version: offer.version,
                size: offer.size,
                key: redact(offer.key),
                cdnUrl: offer.cdnUrl ? safeUrl(offer.cdnUrl) : '',
            })),
        });
        if (this.#announced || offers.length > 128)
            throw new Error('Invalid or repeated pack announcement.');
        this.#announced = true;
        let total = 0;
        for (const value of offers) {
            const offer = { ...value, id: value.id.toLowerCase() };
            if (
                !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(offer.id) ||
                !offer.version ||
                offer.version.length > 128 ||
                this.#downloads.has(offer.id) ||
                !Number.isSafeInteger(offer.size) ||
                offer.size < 1 ||
                offer.size > MAX_PACK_SIZE ||
                (total += offer.size) > MAX_SESSION_SIZE
            ) {
                throw new Error(
                    'Invalid pack metadata or pack download limit exceeded (128 MiB per pack, 256 MiB total).',
                );
            }
            this.#downloads.set(offer.id, {
                offer,
                view: {
                    id: offer.id,
                    version: offer.version,
                    name: offer.id,
                    size: offer.size,
                    received: 0,
                    status: 'waiting',
                },
                received: new Set(),
                requested: new Set(),
                next: 0,
            });
        }
        this.#emit();
        const requested: string[] = [];
        for (const download of this.#downloads.values()) {
            let data: Uint8Array<ArrayBuffer> | undefined;
            if (download.offer.cdnUrl) {
                try {
                    data = await this.#cdn(download);
                    debug('packs', 'CDN download complete', {
                        id: download.offer.id,
                        bytes: data.length,
                    });
                } catch (error) {
                    debug('packs', 'CDN download failed, falling back to chunks', {
                        id: download.offer.id,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    this.signal.throwIfAborted();
                }
            }
            if (data) await this.#finish(download, data);
            else {
                download.view.received = 0;
                download.view.status = 'waiting';
                requested.push(`${download.offer.id}_${download.offer.version}`);
            }
        }
        debug('packs', 'response', { status: requested.length ? 2 : 3, requested });
        if (requested.length) await this.transport.response(2, requested);
        else await this.#all();
        this.#emit();
    }

    async #cdn(download: Download): Promise<Uint8Array<ArrayBuffer>> {
        const url = new URL(download.offer.cdnUrl);
        if (url.protocol !== 'https:' || url.username || url.password)
            throw new Error('Unsupported pack CDN URL.');
        const timeout = AbortSignal.timeout(10000);
        // Call fetch unbound: invoking it as a method of this class throws "Illegal invocation".
        const fetcher = this.fetcher;
        const response = await fetcher(url, {
            signal: AbortSignal.any([this.signal, timeout]),
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
        });
        if (!response.ok || !response.body) throw new Error('The pack CDN is unavailable.');
        const reader = response.body.getReader();
        const bytes = new Uint8Array(download.offer.size);
        let offset = 0;
        download.view.status = 'downloading';
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (offset + value.length > bytes.length)
                    throw new Error('The CDN pack exceeds its announced size.');
                bytes.set(value, offset);
                offset += value.length;
                download.view.received = offset;
                this.#touch();
                this.#emit();
            }
        } finally {
            await reader.cancel().catch(() => {});
        }
        if (offset !== bytes.length) throw new Error('The CDN pack is incomplete.');
        return bytes;
    }

    #find(id: string, version: string): Download {
        const download = this.#downloads.get(id.toLowerCase());
        if (!download || (version && version !== download.offer.version)) {
            debug('packs', 'unrequested pack', {
                id,
                version,
                known: [...this.#downloads.values()].map(
                    ({ offer }) => `${offer.id}_${offer.version}`,
                ),
            });
            throw new Error('The server sent an unrequested pack.');
        }
        return download;
    }

    async #data(info: Extract<PackEvent, { type: 'pack-data' }>): Promise<void> {
        const download = this.#find(info.id, info.version);
        debug('packs', 'pack-data received', {
            ...info,
            offerSize: download.offer.size,
            status: download.view.status,
            repeated: Boolean(download.info),
        });
        // Some servers announce a slightly different size in ResourcePacksInfo than the archive
        // they actually stream. The data info size is what the chunks and hash cover, so use it.
        let total = info.size;
        for (const other of this.#downloads.values())
            if (other !== download) total += other.offer.size;
        const problem = download.info
            ? 'the server sent the data info twice'
            : download.view.status === 'ready'
              ? 'the pack was already downloaded'
              : !Number.isSafeInteger(info.size) || info.size < 1 || info.size > MAX_PACK_SIZE
                ? `size ${info.size} is outside 1 B–128 MiB`
                : total > MAX_SESSION_SIZE
                  ? `size ${info.size} pushes the session past 256 MiB`
                  : !Number.isSafeInteger(info.chunkSize) ||
                      info.chunkSize < 1 ||
                      info.chunkSize > 4 * 1024 * 1024
                    ? `chunk size ${info.chunkSize} is outside 1 B–4 MiB`
                    : !Number.isSafeInteger(info.chunkCount) ||
                        info.chunkCount < 1 ||
                        info.chunkCount > 131072
                      ? `chunk count ${info.chunkCount} is outside 1–131072`
                      : Math.ceil(info.size / info.chunkSize) !== info.chunkCount
                        ? `chunk count ${info.chunkCount} does not match ${Math.ceil(info.size / info.chunkSize)} expected from size ${info.size} / chunk size ${info.chunkSize}`
                        : !/^[0-9a-f]{64}$/i.test(info.hash)
                          ? `hash "${info.hash}" is not a 32-byte SHA-256 (${info.hash.length / 2} bytes)`
                          : undefined;
        if (problem) {
            debug('packs', 'pack-data rejected', { id: info.id, problem });
            throw new Error(`Invalid pack chunk metadata for ${info.id}: ${problem}.`);
        }
        if (info.size !== download.offer.size) {
            debug('packs', 'pack-data size differs from the announcement, using pack-data', {
                id: info.id,
                announced: download.offer.size,
                actual: info.size,
            });
            download.offer.size = info.size;
            download.view.size = info.size;
        }
        download.info = info;
        download.bytes = new Uint8Array(info.size);
        download.view.status = 'downloading';
        this.#emit();
        await this.#request();
    }

    async #request(): Promise<void> {
        // Bound the entire session, rather than opening a window for every pack.
        // Incoming chunks can then fit in the transport queue while a worker processes a pack.
        let pending = 0;
        let bytes = 0;
        for (const download of this.#downloads.values()) {
            pending += download.requested.size;
            for (const index of download.requested) {
                bytes += Math.min(
                    download.info!.chunkSize,
                    download.offer.size - index * download.info!.chunkSize,
                );
            }
        }
        for (const download of this.#downloads.values()) {
            const info = download.info;
            if (!info || download.view.status !== 'downloading') continue;
            while (pending < 4 && download.next < info.chunkCount) {
                const size = Math.min(info.chunkSize, info.size - download.next * info.chunkSize);
                if (bytes + size > 4 * 1024 * 1024) break;
                const index = download.next++;
                download.requested.add(index);
                pending++;
                bytes += size;
                debug('packs', 'chunk requested', {
                    id: download.offer.id,
                    index,
                    of: info.chunkCount,
                    size,
                });
                await this.transport.request(download.offer.id, download.offer.version, index);
            }
        }
    }

    async #chunk(event: Extract<PackEvent, { type: 'pack-chunk' }>): Promise<void> {
        const download = this.#find(event.id, event.version);
        const info = download.info;
        debug('packs', 'chunk received', {
            id: event.id,
            index: event.index,
            progress: event.progress,
            bytes: event.data.length,
            expectedOffset: info ? event.index * info.chunkSize : undefined,
            expectedBytes: info
                ? Math.min(info.chunkSize, info.size - event.index * info.chunkSize)
                : undefined,
            requested: download.requested.has(event.index),
            duplicate: download.received.has(event.index),
        });
        if (
            !info ||
            !Number.isInteger(event.index) ||
            event.index < 0 ||
            event.index >= info.chunkCount
        ) {
            throw new Error('Unexpected pack chunk.');
        }
        if (download.received.has(event.index)) return;
        const offset = event.index * info.chunkSize;
        const length = Math.min(info.chunkSize, info.size - offset);
        if (
            !download.requested.has(event.index) ||
            !download.bytes ||
            event.data.length !== length ||
            event.progress !== offset
        ) {
            throw new Error('Invalid pack chunk size, offset, or sequence.');
        }
        download.bytes.set(event.data, offset);
        download.received.add(event.index);
        download.requested.delete(event.index);
        download.view.received += length;
        this.#emit();
        if (download.received.size === info.chunkCount) {
            const bytes = download.bytes;
            download.bytes = undefined;
            const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
            const actual = Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
            debug('packs', 'SHA-256 check', {
                id: info.id,
                expected: info.hash.toLowerCase(),
                actual,
                match: actual === info.hash.toLowerCase(),
            });
            if (actual !== info.hash.toLowerCase())
                throw new Error('The downloaded pack failed its SHA-256 integrity check.');
            await this.#finish(download, bytes);
            if ([...this.#downloads.values()].every(({ view }) => view.status === 'ready'))
                await this.#all();
            else await this.#request();
        } else await this.#request();
    }

    async #finish(download: Download, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
        download.view.status = 'processing';
        this.#emit();
        // The processor transfers the buffer to a worker, so keep a copy to save on failure.
        const copy = debugging ? bytes.slice() : undefined;
        let result: ProcessedPack;
        try {
            result = await this.process(bytes, download.offer, this.signal, (activity) => {
                if (this.signal.aborted) return;
                download.view.activity = activity;
                this.#touch();
                this.#emit();
            });
        } catch (error) {
            if (copy) {
                const file = `failed-${download.offer.id}_${download.offer.version}.zip`;
                debug('packs', 'processing failed, archive saved', {
                    id: download.offer.id,
                    file: `logs/${file}`,
                    bytes: copy.length,
                    error: error instanceof Error ? error.message : String(error),
                });
                debugFile(file, copy);
            }
            throw error;
        }
        this.signal.throwIfAborted();
        debug('packs', 'pack ready', { id: download.offer.id, name: result.name });
        download.view.name = result.name;
        download.view.archive = result.archive;
        download.view.received = download.offer.size;
        download.view.status = 'ready';
        download.offer.key = '';
        download.offer.cdnUrl = '';
        this.#touch();
        this.#emit();
    }

    async #all(): Promise<void> {
        this.#haveAll = true;
        debug('packs', 'response', { status: 3 });
        await this.transport.response(3);
        this.#touch();
    }
}

function safeUrl(value: string): string {
    try {
        const url = new URL(value);
        return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
        return '<invalid URL>';
    }
}
