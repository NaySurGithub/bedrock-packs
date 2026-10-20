export interface AuthConfig {
    clientId: string;
    deviceType: string;
    deviceVersion: string;
    userAgent: string;
    gameVersion: string;
}

export interface LiveToken {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
}

export interface XboxToken {
    token: string;
    userHash: string;
    xuid: string;
    gamertag: string;
    expiresAt: number;
}

export interface MinecraftIdentity {
    publicKey: string;
    multiplayerToken: string;
    chain: string[];
    identity: string;
    playFabId: string;
    expiresAt: number;
}

export interface AccountSession {
    version: 1;
    clientId: string;
    deviceId: string;
    live: LiveToken;
    xbox: Record<string, XboxToken>;
    profile?: {
        gamertag: string;
        xuid: string;
    };
    device?: {
        token: string;
        expiresAt: number;
        publicX: string;
    };
    service?: {
        authorization: string;
        expiresAt: number;
        titleId: string;
    };
    minecraft?: MinecraftIdentity;
}

export interface DeviceCode {
    code: string;
    verificationUri: string;
    expiresAt: number;
}

export type AccountState =
    | { status: 'restoring' }
    | { status: 'signed-out' }
    | { status: 'connecting'; message: string }
    | { status: 'device-code'; device: DeviceCode }
    | { status: 'signed-in'; gamertag: string; xuid: string }
    | { status: 'error'; message: string };
