import type { PackEvent, PackOffer, PackView, PackProgress, ProcessedPack } from './types.js';
import { MAX_PACK_SIZE, MAX_SESSION_SIZE } from './types.js';

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
            this.cancel('The server stopped sending resource packs.');
            this.failed(new Error('Resource-pack negotiation timed out.'));
        }, 45000);
    }

    start(): void {
        this.#touch();
    }

    cancel(message = 'Download cancelled.'): void {
        clearTimeout(this.#timer);
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
            this.cancel(failure.message);
            throw failure;
        }
    }

    async #offers(offers: PackOffer[]): Promise<void> {
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
                } catch {
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
        if (requested.length) await this.transport.response(2, requested);
        else await this.#all();
        this.#emit();
    }

    async #cdn(download: Download): Promise<Uint8Array<ArrayBuffer>> {
        const url = new URL(download.offer.cdnUrl);
        if (url.protocol !== 'https:' || url.username || url.password)
            throw new Error('Unsupported pack CDN URL.');
        const timeout = AbortSignal.timeout(10000);
        const response = await this.fetcher(url, {
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
        if (!download || (version && version !== download.offer.version))
            throw new Error('The server sent an unrequested pack.');
        return download;
    }

    async #data(info: Extract<PackEvent, { type: 'pack-data' }>): Promise<void> {
        const download = this.#find(info.id, info.version);
        if (
            download.info ||
            download.view.status === 'ready' ||
            info.size !== download.offer.size ||
            !Number.isSafeInteger(info.chunkSize) ||
            info.chunkSize < 1 ||
            info.chunkSize > 4 * 1024 * 1024 ||
            !Number.isSafeInteger(info.chunkCount) ||
            info.chunkCount < 1 ||
            info.chunkCount > 131072 ||
            Math.ceil(info.size / info.chunkSize) !== info.chunkCount ||
            !/^[0-9a-f]{64}$/i.test(info.hash)
        ) {
            throw new Error('Invalid pack chunk metadata or SHA-256 hash.');
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
                await this.transport.request(download.offer.id, download.offer.version, index);
            }
        }
    }

    async #chunk(event: Extract<PackEvent, { type: 'pack-chunk' }>): Promise<void> {
        const download = this.#find(event.id, event.version);
        const info = download.info;
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
        const result = await this.process(bytes, download.offer, this.signal, (activity) => {
            if (this.signal.aborted) return;
            download.view.activity = activity;
            this.#touch();
            this.#emit();
        });
        this.signal.throwIfAborted();
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
        await this.transport.response(3);
        this.#touch();
    }
}
