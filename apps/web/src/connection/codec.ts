import type { ClientProfile } from './profile.js';
import type { PackEvent } from '../packs/types.js';
export interface NativeConnection {
    HEAPU8: Uint8Array;
    _bp_buffer(): number;
    _bp_capacity(): number;
    _bp_output_size(): number;
    _bp_raknet_start(port: number): number;
    _bp_raknet_close(): void;
    _bp_raknet_input(length: number): number;
    _bp_raknet_output(): number;
    _bp_raknet_receive(): number;
    _bp_raknet_send(length: number): number;
    _bp_raknet_tick(): void;
    _bp_nethernet_start(): number;
    _bp_nethernet_close(): void;
    _bp_nethernet_input(kind: number, length: number): number;
    _bp_nethernet_send(length: number): number;
    _bp_nethernet_output(): number;
    _bp_nethernet_receive(): number;
    _bp_framing_start(raknet: number): void;
    _bp_compression(algorithm: number, threshold: number): number;
    _bp_frame_input(length: number): number;
    _bp_frame_output(): number;
    _bp_frame_receive(): number;
    _bp_frame_send(length: number): number;
    _bp_network_settings(protocol: number): number;
    _bp_protocol_select(protocol: number): number;
    _bp_login(length: number, protocol: number): number;
    _bp_client_data(length: number): number;
    _bp_client_handshake(): number;
    _bp_cache_status(): number;
    _bp_packet_read(length: number): number;
    _bp_pack_response(length: number): number;
    _bp_pack_request(length: number): number;
    _bp_pack_chunk(): number;
    _bp_sdp_read(length: number): number;
    _bp_sdp_identity(length: number): number;
}

export type LoginPacket =
    | PackEvent
    | { type: 'settings'; algorithm: number; threshold: number }
    | { type: 'handshake'; token: string }
    | { type: 'status'; status: number }
    | { type: 'disconnect'; message: string; reason: number }
    | { type: 'transfer'; host: string; port: number; reloadWorld: boolean }
    | { type: 'packet'; id: number }
    | { type: 'invalid' };

export interface SessionDescription {
    fingerprints: string;
    hasFingerprints: boolean;
    identity: boolean;
    error: string;
    token: string;
    signature: string;
}

export class BrowserCodec {
    constructor(readonly native: NativeConnection) {
        if (typeof native._bp_raknet_start !== 'function') {
            throw new Error('Rebuild the WebAssembly client to enable Bedrock connections.');
        }
    }

    input(data: Uint8Array): number {
        if (data.length > this.native._bp_capacity()) {
            throw new Error('The Bedrock packet exceeds the client limit.');
        }

        this.native.HEAPU8.set(data, this.native._bp_buffer());
        return data.length;
    }

    jsonInput(data: unknown): number {
        return this.input(new TextEncoder().encode(JSON.stringify(data)));
    }

    output(pointer: number): Uint8Array<ArrayBuffer> {
        return this.native.HEAPU8.slice(pointer, pointer + this.native._bp_output_size());
    }

    text(pointer: number): string {
        return new TextDecoder().decode(this.output(pointer));
    }

    start(raknet: boolean): void {
        this.native._bp_framing_start(Number(raknet));
    }

    settings(protocol: number): Uint8Array<ArrayBuffer> {
        const length = this.native._bp_network_settings(protocol);
        const pointer = this.native._bp_buffer();
        return this.native.HEAPU8.slice(pointer, pointer + length);
    }

    login(protocol: number, auth: string, client: string): Uint8Array<ArrayBuffer> {
        return this.output(this.native._bp_login(this.jsonInput({ auth, client }), protocol));
    }

    clientData(
        address: string,
        name: string,
        version: string,
        playFabId: string,
        profile: ClientProfile,
    ): string {
        const claims = this.text(
            this.native._bp_client_data(
                this.jsonInput({ address, name, version, playFabId, profile }),
            ),
        );
        if (!claims)
            throw new Error(
                'Could not create a consistent login profile. Rebuild the client and sign in again.',
            );
        return claims;
    }

    send(packet: Uint8Array): Uint8Array<ArrayBuffer>[] {
        if (!this.native._bp_frame_send(this.input(packet))) {
            throw new Error('Could not encode the outgoing Bedrock batch.');
        }

        const batches: Uint8Array<ArrayBuffer>[] = [];

        for (;;) {
            const batch = this.output(this.native._bp_frame_output());

            if (batch.length === 0) {
                return batches;
            }

            batches.push(batch);
        }
    }

    receive(batch: Uint8Array): Uint8Array<ArrayBuffer>[] {
        if (!this.native._bp_frame_input(this.input(batch))) {
            throw new Error('Could not decode the incoming Bedrock batch.');
        }

        const packets: Uint8Array<ArrayBuffer>[] = [];

        for (;;) {
            const packet = this.output(this.native._bp_frame_receive());

            if (packet.length === 0) {
                return packets;
            }

            packets.push(packet);
        }
    }

    read(packet: Uint8Array): LoginPacket {
        const event = JSON.parse(
            this.text(this.native._bp_packet_read(this.input(packet))),
        ) as LoginPacket;
        if (event.type === 'pack-chunk') {
            event.data = this.output(this.native._bp_pack_chunk());
        }
        return event;
    }

    packResponse(status: number, packs: string[] = []): Uint8Array<ArrayBuffer> {
        return this.output(this.native._bp_pack_response(this.jsonInput({ status, packs })));
    }

    packRequest(id: string, version: string, index: number): Uint8Array<ArrayBuffer> {
        return this.output(this.native._bp_pack_request(this.jsonInput({ id, version, index })));
    }

    description(sdp: string): SessionDescription {
        return JSON.parse(
            this.text(this.native._bp_sdp_read(this.input(new TextEncoder().encode(sdp)))),
        ) as SessionDescription;
    }
}
