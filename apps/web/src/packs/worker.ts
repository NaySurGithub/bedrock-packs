import { processArchive } from './archive.js';
import type { PackOffer } from './types.js';

self.onmessage = async (event: MessageEvent<{ data: Uint8Array; offer: PackOffer }>) => {
    try {
        const result = await processArchive(event.data.data, event.data.offer, (progress) =>
            self.postMessage({ progress }),
        );
        self.postMessage({ result }, { transfer: [result.archive.buffer] });
    } catch (error) {
        self.postMessage({
            error: error instanceof Error ? error.message : 'Pack processing failed.',
        });
    }
};
