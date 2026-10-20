# Authentication

## Sign-in flow

The account button requests a Microsoft device code and displays the verification
link. The user opens that link and approves the request at Microsoft. The site
never asks for a password or opens the verification page automatically.

The browser then performs the Bedrock authentication chain:

1. Exchange the device code for Microsoft access and refresh tokens.
2. Generate a non-extractable P-256 proof key and request an Xbox device token.
3. Sign SISU authorization requests for Minecraft multiplayer, Xbox profile,
   and PlayFab relying parties.
4. Discover the Minecraft authorization environment and log in to PlayFab.
5. Start or renew the Minecraft service session.
6. Generate a non-extractable P-384 identity key and request the signed multiplayer
   token and legacy identity chain.

The client configuration comes from Falcon Network's `XboxLiveConfig` through the
WASM module. Browser HTTP, signing, scheduling, and storage are platform adapters;
Xbox request signatures preserve Falcon's version, Windows timestamp, field order,
and raw ECDSA signature format.

Device-code polling honors pending authorization, slow-down responses, expiration,
cancellation, and transient network failures. Restoring an account uses its saved
refresh token; a background refresh never starts a device-code prompt. Rotated
refresh tokens are saved before later authentication stages can fail.

## Local storage

Microsoft access and refresh tokens, Xbox authorizations, device tokens, Minecraft
service tokens, profile metadata, and identity chains are encrypted with AES-256-GCM
in IndexedDB. Every write uses a fresh 96-bit IV and authenticated version metadata.

The encryption and private signing keys are non-extractable Web Crypto keys stored
in IndexedDB. Tokens are not stored in localStorage, cookies, URLs, DOM attributes,
application logs, or BroadcastChannel messages. Microsoft device-session cookies
exist only in memory while completing the device-code flow.

The browser restores and renews the session after reload. Web Locks serialize
refreshes across tabs where supported. A storage generation prevents an in-flight
refresh from recreating credentials after sign-out. Sign-out clears the encrypted
account and keys, cancels outstanding requests, and notifies other open tabs.

Encryption hides raw token values in ordinary storage inspection and detects
modified ciphertext. It does not make tokens inaccessible to the browser owner,
a compromised same-origin script, a privileged extension, or malware. A
non-extractable key can still be used by authorized same-origin JavaScript.

## Authentication relay

Browsers cannot reliably call every provider endpoint directly because of CORS.
The relay exposes a narrow `POST /auth` route rather than an arbitrary HTTP proxy.
It supports only fixed HTTPS provider endpoints, validates parameters and headers,
does not follow redirects, limits request/response sizes and concurrency, and
returns responses with `Cache-Control: no-store`.

The relay processes credentials transiently to forward them to Microsoft, Xbox,
PlayFab, or Minecraft. It does not persist them or implement a server-side token
cache. The operator of an authentication relay is still a trusted party: TLS
terminates there, so the operator can inspect requests. Self-host the relay when
that trust is undesirable. Do not enable request-body logging in a reverse proxy.

Production builds include a content security policy allowing scripts and styles
from the site itself and connections to configured relay origins. There are no
third-party scripts or remote fonts. Use HTTPS in production.

See [Deployment](deployment.md) for the origin allowlist and endpoint variables.
