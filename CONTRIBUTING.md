# Contributing

Use Node.js 24+ and Emscripten 4.0.23. Follow the setup in the README.

- Keep C++ protocol code in `native/`, browser code in `apps/web`, and transport policy in `apps/relay`.
- Keep changes focused. Add dependencies only when existing platform APIs are insufficient.
- Validate lengths and resource limits before decoding untrusted network or archive data.
- Add regression coverage for protocol changes and relay lifecycle changes.
- Run `npm run check`, `npm test`, and `npm run build` before submitting changes.
- Describe the behavior changed and the checks actually run in pull requests.
- Use Conventional Commits, such as `feat:`, `fix:`, `ci:`, and `docs:`.
- Do not commit credentials, server packs, proprietary assets, or generated build output.

Report security issues privately to the repository owner. Do not include tokens or private server addresses in public reports.
