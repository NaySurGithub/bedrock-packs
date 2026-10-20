<div align="center">
  <h1>Bedrock Packs</h1>
  <p>A browser workspace for Minecraft: Bedrock Edition resource packs.</p>
  <p>WebAssembly client · WebSocket / UDP relay · Local pack processing</p>
</div>

---

## Overview

Bedrock Packs brings the Bedrock client protocol to the browser. Its architecture keeps protocol handling and pack processing on the user's device, with a small relay connecting browser WebSockets to a server's UDP endpoint.

The product workflow is straightforward: sign in with Microsoft, enter a server address, join, and download the resource packs offered during the connection. The transport is detected automatically. Packs are decrypted using the content keys provided by that server and exported as `.mcpack` archives. The interface displays download and processing
progress for each pack. Download packs individually, or use Download all to save
one ZIP containing the ready `.mcpack` files. The connection stays open after pack
negotiation to follow server Transfer packets automatically. Ready downloads survive
transfers and disconnections, until a new connection is started manually or the page is reloaded.

For implementation coverage and development priorities, see [Development](docs/development.md).

## Architecture

```text
Browser                                 Relay              Bedrock server
┌───────────────────────────────┐       ┌───────────┐       ┌─────────────┐
│ Interface                     │       │           │       │             │
│ C++ / WebAssembly client      │──WSS───│ WebSocket │──UDP──│   RakNet    │
│ Pack decoding and export      │       │    ↕ UDP  │       │             │
└───────────────────────────────┘       └───────────┘       └─────────────┘
```

Each WebSocket session owns one connected UDP socket and one fixed destination. Binary messages preserve datagram boundaries. The relay does not interpret Bedrock packets, sign in to Microsoft, or store packs.

Falcon Network and Falcon Protocol provide the shared networking and packet code. RakNet uses the WebSocket/UDP bridge; NetherNet uses browser WebRTC with separate signaling and ICE negotiation.

Microsoft authentication and CDN requests are separate HTTP flows. Their browser integration must account for each endpoint's CORS policy; the UDP relay does not proxy HTTP.

Sign-in uses Microsoft's device-code flow. Account credentials are encrypted in browser IndexedDB and refreshed automatically. The relay provides a separate, restricted authentication route for provider requests. See [Authentication](docs/authentication.md) for storage, sign-out, and relay trust details.

## Getting started

Requirements: Node.js 24 or later, npm, and [Emscripten SDK 4.0.23](https://emscripten.org/docs/getting_started/downloads.html). Activate Emscripten in your shell, or set `EMSDK` to its installation directory.

```sh
npm ci
npm run build:wasm
npm run relay
```

In a second terminal:

```sh
npm run dev
```

Open [localhost:5173](http://localhost:5173). The default relay listens on `127.0.0.1:8787`. The web development server proxies `/relay` to it.

```sh
npm run check
npm test
npm run build
```

## Repository

```text
apps/
  relay/       WebSocket / UDP bridge and destination policy
  web/         Browser interface and WASM adapter
native/        C++ sources compiled to WebAssembly
scripts/       Cross-platform build tooling
tests/         WASM and transport integration tests
docs/          Protocol, deployment, and development documentation
```

## Self-hosting

Serve `apps/web/dist` over HTTPS and reverse-proxy `/relay` to the relay process with WebSocket upgrades enabled. The relay host needs outbound UDP connectivity. Servers see the relay's public IP address.

For GitHub Pages, the included workflow builds the WASM client and publishes the static site. Set the repository variable `VITE_RELAY_URL` to your relay's WSS endpoint. See [Deployment](docs/deployment.md) for setup and cache behavior.

Allowed browser origins, destination policy, resource limits, and deployment instructions are documented in [Deployment](docs/deployment.md). Never expose an unrestricted UDP relay to the internet.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Keep protocol code independent of the UI and cover network behavior with integration tests. Do not commit account tokens, downloaded packs, or Minecraft assets.

## License

[MIT](LICENSE). Third-party components retain their own licenses; see [NOTICE](NOTICE).

Bedrock Packs is an independent project, not affiliated with Microsoft or Mojang.
