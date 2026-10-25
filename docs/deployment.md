# Deployment

## GitHub Pages

The `Build and deploy` workflow builds the C++ WebAssembly module, the browser
application, and the relay; checks formatting and TypeScript; and runs the tests.
Pull requests are verified without publishing. Pushes to `main` deploy the static
application to GitHub Pages when the repository variable `PAGES_ENABLED` is `true`.
Builds and downloadable site artifacts work without enabling Pages.

The workflow caches npm downloads, the Emscripten SDK, fetched Falcon dependency
sources, and C++ compiler output through ccache. Dependency and compiler caches
are keyed by the pinned SDK and source declarations; compiler output also uses
source hashes, with a fallback to the previous cache for incremental builds.

1. Push this repository to GitHub with `main` as its default branch.
2. Confirm that your GitHub plan supports Pages for the repository visibility.
   In **Settings → Pages → Build and deployment**, select **GitHub Actions**.
3. Host the relay on a machine with outbound UDP and a TLS reverse proxy.
4. Add the repository Actions variable `VITE_RELAY_URL`, for example
   `wss://relay.example.net/relay`.
   Authentication defaults to `/auth` on that relay's origin. Set `VITE_AUTH_URL`
   explicitly if the authentication relay uses a different address.
5. Add the Pages origin to the relay's `RELAY_ORIGINS`, for example
   `https://your-account.github.io`. Origins do not include repository paths.
6. Set the repository Actions variable `PAGES_ENABLED` to `true`.
7. Push to `main` or run the workflow manually.

GitHub Pages hosts HTML, JavaScript, and WASM; it cannot run the UDP relay.
The app uses relative asset paths and works at `/bedrock-packs/` and at a custom domain.
A deployed site without `VITE_RELAY_URL` shows an actionable configuration error.

## Relay

```sh
npm ci
npm run build --workspace @bedrock-packs/relay
npm run start --workspace @bedrock-packs/relay
```

| Variable                       | Default                   | Purpose                                                                                   |
| ------------------------------ | ------------------------- | ----------------------------------------------------------------------------------------- |
| `RELAY_HOST`                   | `127.0.0.1`               | Listening interface                                                                       |
| `RELAY_PORT`                   | `8787`                    | HTTP and WebSocket port; falls back to `PORT`                                             |
| `RELAY_ORIGINS`                | Local development origins | Comma-separated exact browser origins                                                     |
| `RELAY_ALLOWED_PORTS`          | `19132`                   | Destination UDP ports and ranges, e.g. `19132,1024-65535`                                                     |
| `RELAY_ALLOWED_HOSTS`          | Empty                     | Optional exact hostname allowlist                                                         |
| `RELAY_MAX_SESSIONS`           | `64`                      | Global concurrent session limit                                                           |
| `RELAY_MAX_PACKETS_PER_SECOND` | `20000`                   | Datagrams per session per second, both directions                                         |
| `RELAY_TRUSTED_PROXIES`        | `0`                       | Reverse proxies in front of the relay whose `X-Forwarded-For` entry identifies the client |

The process reads environment variables directly. An `.env` file is not loaded automatically.

Use WSS in production. Forward WebSocket upgrades to `/relay`, retain the browser
`Origin` header, and expose `/healthz` for readiness checks. By default the relay
permits only public destination addresses and does not trust forwarded IP headers.
DNS is resolved once; the UDP socket connects to the validated IP.

Forward `POST` and `OPTIONS` requests for `/auth` to the same process. This route
needs outbound HTTPS access to Microsoft's authentication services. It enforces
the same `RELAY_ORIGINS` allowlist, including on cross-origin requests. Credentials
remain in browser storage; the relay forwards them transiently without saving them.
See [Authentication](authentication.md) for the trust boundary and storage design.

The relay limits sessions, datagram size, packet rate, total transferred bytes,
buffered output, idle time, and total session lifetime. For public deployment,
restrict destinations to your supported servers and enforce additional admission
controls at your reverse proxy. Browser origin checks are not authentication.

NetherNet uses WebRTC rather than the RakNet UDP relay. Its signaling and ICE/TURN
configuration are separate from `VITE_RELAY_URL`; see [Development](development.md).
