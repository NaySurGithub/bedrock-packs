export interface PackOffer {
    id: string;
    version: string;
    size: number;
    key: string;
    cdnUrl: string;
}

export type PackEvent =
    | { type: 'packs-info'; packs: PackOffer[] }
    | {
          type: 'pack-data';
          id: string;
          version: string;
          size: number;
          chunkSize: number;
          chunkCount: number;
          hash: string;
      }
    | {
          type: 'pack-chunk';
          id: string;
          version: string;
          index: number;
          progress: number;
          data: Uint8Array<ArrayBuffer>;
      }
    | { type: 'packs-stack' };

export interface PackView {
    id: string;
    version: string;
    name: string;
    size: number;
    received: number;
    status: 'waiting' | 'downloading' | 'processing' | 'ready' | 'error';
    activity?: PackProgress;
    error?: string;
    archive?: Uint8Array<ArrayBuffer>;
}

export interface ProcessedPack {
    name: string;
    archive: Uint8Array<ArrayBuffer>;
}

export const MAX_PACK_SIZE = 128 * 1024 * 1024;
export const MAX_SESSION_SIZE = 256 * 1024 * 1024;

export interface PackProgress {
    stage: 'opening' | 'decrypting' | 'exporting';
    completed: number;
    total: number;
}
