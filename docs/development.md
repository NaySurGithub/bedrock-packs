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
- Microsoft authentication, the complete login sequence, NetherNet session
  negotiation, and resource-pack export are not yet connected to the interface.

## Browser port

Keep Bedrock packets and shared protocol behavior in Falcon Protocol/Network.
Adapt platform I/O at the browser boundary rather than introducing a second
Bedrock protocol implementation.

RakNet needs a socket adapter that carries datagrams through the relay. NetherNet
needs an adapter for the browser's `RTCPeerConnection` and `RTCDataChannel`, retaining
Falcon's signal format, identity checks, channel labels, and segmentation rules.
The native libdatachannel transport cannot simply be linked into a browser build.

Authentication and CDN HTTP calls need a browser fetch adapter and endpoint-specific
CORS verification. Never fall back to logging account tokens or returning them in URLs.

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
