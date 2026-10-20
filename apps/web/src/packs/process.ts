import type { PackOffer, PackProgress, ProcessedPack } from './types.js';

export function processPack(
    data: Uint8Array<ArrayBuffer>,
    offer: PackOffer,
    signal: AbortSignal,
    progress: (value: PackProgress) => void = () => {},
): Promise<ProcessedPack> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
        const finish = () => {
            worker.terminate();
            signal.removeEventListener('abort', abort);
        };
        const abort = () => {
            finish();
            reject(new Error('Pack processing cancelled.'));
        };
        signal.addEventListener('abort', abort, { once: true });
        worker.onerror = () => {
            finish();
            reject(new Error('The pack worker failed.'));
        };
        worker.onmessage = (
            event: MessageEvent<{
                result?: ProcessedPack;
                error?: string;
                progress?: PackProgress;
            }>,
        ) => {
            if (event.data.progress) {
                progress(event.data.progress);
                return;
            }
            finish();
            if (event.data.result) resolve(event.data.result);
            else reject(new Error(event.data.error ?? 'Pack processing failed.'));
        };
        worker.postMessage({ data, offer }, [data.buffer]);
    });
}
