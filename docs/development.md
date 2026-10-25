# Development

## Implementation coverage

- CMake pins Falcon NBT, Falcon Protocol, and Falcon Network to exact revisions.
- The WASM module links Falcon Protocol and the portable Falcon Network sources
  used by the browser adapter. It is not yet the complete native Network target.
- The browser can query a RakNet server through the WebSocket/UDP relay.
- Transport selection is automatic. The relay first probes `GET /v1/join` on
  the validated destination with a two-second deadline and a 64 KiB response cap.
  A status containing `name` and `protocol` identifies NetherNet; otherwise the
  same destination is queried over RakNet.
- NetherNet signaling encoding and decoding use Falcon Network's `Signal` type
  in WASM. The WebRTC platform adapter is developed separately from the UDP relay.
- Microsoft device-code sign-in, Xbox authorization, Minecraft identity tokens,
  encrypted browser persistence, refresh, and sign-out are connected to the account
  interface. See [Authentication](authentication.md).
- The Bedrock login sequence and NetherNet session negotiation are connected to
  the interface. Protocol handling remains in Falcon's WASM codecs.
- Transfer packets automatically reconnect to the supplied address and port, with
  fresh transport detection, framing, encryption and Bedrock login on each hop.
  The existing Microsoft account and ready pack exports are preserved. The UI
  displays the destination and current server details; transfer failures use the
  same error modal. Up to eight transfers are followed. The relay's destination
  host/port policy is applied to every hop; include all destination ports in
  `RELAY_ALLOWED_PORTS` when deploying a server network.
- Connections stay open after pack negotiation so a later Transfer packet can be
  received. The user can disconnect manually.
- Resource-pack negotiation requests server packs, assembles up to four outstanding
  chunks across the session (4 MiB in flight), checks exact sizes/offsets and SHA-256, and acknowledges the
  completed stack. HTTPS CDN downloads fall back to protocol chunks when browser
  access fails (for example, CORS).
- A dedicated browser worker opens ZIP archives, decrypts Bedrock AES-256-CFB8
  contents indexes and per-file payloads with keys offered by the server, handles
  subpacks, and exports standalone `.mcpack` ZIP archives. Encryption indexes are
  removed from the decrypted exports. No asset or key is uploaded or persisted.
- The UI shows received/total bytes, percentage, speed, elapsed time, processing
  stages, per-pack file progress and timeout/cancellation errors. Failed or closed
  connections remove progress controls and unfinished rows, and show a modal with
  the server Disconnect reason or transport error. User cancellations and successful
  completion do not show an error modal. Ready packs
  remain downloadable after disconnection. Download all produces one ZIP of
  `.mcpack` files.
- Limits: 128 packs, 128 MiB compressed per pack, 256 MiB per session, 512 MiB
  expanded and 10,000 ZIP entries per pack. Idle pack negotiation fails after
  45 seconds. CDN requests have a 10-second deadline and omit credentials.
- Automated fixtures exercise the actual WASM packet reader/writer and complete
  encrypted pack transfer. Microsoft sign-in plus a real external Bedrock server
  still needs an end-to-end manual check; fixture tests do not prove compatibility
  with every server implementation.

## Browser port

Keep Bedrock packets and shared protocol behavior in Falcon Protocol/Network.
Adapt platform I/O at the browser boundary rather than introducing a second
Bedrock protocol implementation.

RakNet's socket adapter carries datagrams through the relay. NetherNet
uses the browser's `RTCPeerConnection` and `RTCDataChannel`, retaining
Falcon's signal format, identity checks, channel labels, and segmentation rules.
The native libdatachannel transport cannot simply be linked into a browser build.

Authentication HTTP calls use the restricted relay; CDN downloads use browser fetch
and fall back to protocol chunks when CORS prevents direct access. Never fall back to logging account tokens or returning them in URLs.

## Local dependencies

Normal builds fetch the pinned public source revisions. During development, set
`FALCON_NBT_SOURCE_DIR`, `FALCON_PROTOCOL_SOURCE_DIR`, and `FALCON_NETWORK_SOURCE_DIR`
to use local checkouts. These are explicit local overrides; CI uses pinned revisions.

Generated WASM and its loader are written to `apps/web/public/wasm/`. CMake output
lives under `.build/wasm/`. Both directories are ignored by Git.

## Verification

```sh
npm ci
npm run format:check
npm run check
npm run build
npm test
```

Integration tests use local UDP fixtures through an injected test resolver; the
production resolver always rejects private destinations. WASM tests execute the
actual compiled module, including Falcon's packet and signaling codecs.

## Pack format references

- [Mojang protocol reference](https://mojang.github.io/bedrock-protocol-docs/):
  ResourcePacksInfo, ResourcePackDataInfo, ResourcePackChunkData,
  ResourcePackChunkRequest, ResourcePackStack and ResourcePackClientResponse.
- [EncryptMyPack's format implementation](https://github.com/AllayMC/EncryptMyPack):
  256-byte contents header, AES-256-CFB8, and subpack contents indexes.
  The browser implementation is independently written.

## Browser login profile

The serialized login profile matches the user's direct vanilla capture on the
local Altay diagnostic server: DeviceOS 8, `Unknown (Desktop)`, locale `fr_FR`,
input modes 1/1, GUI scale -1, memory tier 4 and maximum view distance 77.
Editor capability, client-side chunk generation, profanity filtering and trusted
and premium skin flags match that captured profile. These are login metadata;
they do not implement an editor or local world generation in the browser.
Authentication still uses the existing Android XAL flow and its UUID device ID.
The login DeviceId is separate: 32 lowercase hex digits, as DeviceOS 8 clients
send, taken from the first 16 bytes of SHA-256(`solar-device:Windows 10:<XUID>`)
so it matches SolarProxy's Windows 10 identity and stays stable per account.

The game version and geometry engine version come from Falcon Protocol's pinned
`ProtocolInfo` (`1.26.52`), never from a server's advertised version. The site retains
its own locally generated 64x64 RGBA fallback skin and matching geometry; it does
not copy the user's skin pixels, private identifiers or authentication tokens.

The opaque client-random and skin IDs survive joins and transfers. The 64-bit
client ID crosses the JS/WASM boundary as a decimal string and is serialized as
an integer without losing precision. SelfSignedId, PlatformOnlineId and PlayFabId
are empty, matching the capture's empty-or-absent optional IDs. PlatformOfflineId
remains empty, platform type stays 0, and PlatformUserId is omitted. PartyId and
IsPartyLeader are omitted entirely, including when empty or false.

Comparison references:

- SolarProxy `src/network/session/Session.cpp` and `src/network/login/ClientData.cpp`
  retain the incoming game's profile instead of relying on empty defaults.
- [Cinnabar's login profile](https://github.com/NaySurGithub/cinnabar/blob/dev/crates/protocol/src/login/client_data.rs)
  provides independently authored client settings, persistent random IDs and a
  consistent 64x64 fallback skin.
- Kestrel's inspected local `src/client/session/Session.cpp` builds its connection
  through Falcon defaults; it is not evidence of the exact official vanilla claims.
- [Gophertunnel client-data definitions](https://github.com/Sandertv/gophertunnel/blob/master/minecraft/protocol/login/data.go)
  document optional platform identifiers and Xbox-specific PlatformUserId.

These references validate format and consistency; no successful Motaz anti-proxy
check has been demonstrated by the automated fixtures.
