export interface ClientProfile {
    deviceId: string;
    deviceType: string;
    platformOnlineId: string;
    clientRandomId: string;
    selfSignedId: string;
    skinId: string;
    languageCode: string;
    inputMode: 1 | 2;
    memoryTier: number;
}

interface ProfileIds {
    version: 1;
    clientRandomId: string;
    selfSignedId: string;
    skinId: string;
}

interface ProfileStore {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

const key = 'bedrock-packs.client-profile.v1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let fallback: ProfileIds | undefined;

export function memoryTier(gib: number | undefined): number {
    if (!gib || !Number.isFinite(gib) || gib < 0) return 0;
    return [1.5, 2, 4, 8].filter((boundary) => gib > boundary).length;
}

function valid(value: unknown): value is ProfileIds {
    if (!value || typeof value !== 'object') return false;
    const data = value as Partial<ProfileIds>;
    if (
        data.version !== 1 ||
        typeof data.selfSignedId !== 'string' ||
        !uuid.test(data.selfSignedId) ||
        typeof data.skinId !== 'string' ||
        !uuid.test(data.skinId) ||
        typeof data.clientRandomId !== 'string' ||
        !/^-?[1-9][0-9]{0,18}$/.test(data.clientRandomId)
    )
        return false;
    const id = BigInt(data.clientRandomId);
    return id >= -(1n << 63n) && id < 1n << 63n;
}

export function profileIds(store?: ProfileStore): ProfileIds {
    if (store) {
        try {
            const saved: unknown = JSON.parse(store.getItem(key) ?? 'null');
            if (valid(saved)) return saved;
        } catch {
            /* Storage may be unavailable or contain an older/malformed profile. */
        }
    }
    if (!fallback) {
        let random = 0n;
        while (random === 0n) {
            const bytes = crypto.getRandomValues(new Uint8Array(8));
            random = new DataView(bytes.buffer).getBigInt64(0, true);
        }
        fallback = {
            version: 1,
            clientRandomId: random.toString(),
            selfSignedId: crypto.randomUUID(),
            skinId: crypto.randomUUID(),
        };
    }
    try {
        store?.setItem(key, JSON.stringify(fallback));
    } catch {
        /* Retain in memory when storage is blocked. */
    }
    return { ...fallback };
}

interface ProfileEnvironment {
    language: string;
    coarsePointer: boolean;
    deviceMemory?: number | undefined;
    store?: ProfileStore | undefined;
}

function browserEnvironment(): ProfileEnvironment {
    let store: Storage | undefined;
    try {
        store = globalThis.localStorage;
    } catch {
        /* Private browsers may block storage. */
    }
    return {
        language: navigator.language,
        coarsePointer: globalThis.matchMedia?.('(pointer: coarse)').matches ?? false,
        deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
        store,
    };
}

// Windows (DeviceOS 8) clients send 16 bytes as 32 lowercase hex digits, not a dashed UUID.
// Same derivation as SolarProxy's "Windows 10" identity, so one account keeps one stable ID.
export async function windowsDeviceId(xuid: string): Promise<string> {
    const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`solar-device:Windows 10:${xuid}`),
    );
    return Array.from(new Uint8Array(digest, 0, 16), (byte) =>
        byte.toString(16).padStart(2, '0'),
    ).join('');
}

export function createClientProfile(
    deviceId: string,
    deviceType: string,
    platformOnlineId: string,
    environment = browserEnvironment(),
): ClientProfile {
    const language = environment.language.replaceAll('-', '_');
    return {
        ...profileIds(environment.store),
        deviceId,
        deviceType,
        platformOnlineId,
        languageCode: /^[a-z]{2,3}(_[a-z0-9]{2,8})*$/i.test(language) ? language : 'en_US',
        inputMode: environment.coarsePointer ? 2 : 1,
        memoryTier: memoryTier(environment.deviceMemory),
    };
}
