import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
    const environment = loadEnv(mode, process.cwd(), 'VITE_');
    const connections = new Set(["'self'", 'https:']);

    for (const endpoint of [environment.VITE_RELAY_URL, environment.VITE_AUTH_URL]) {
        if (endpoint) {
            const url = new URL(endpoint);
            connections.add(url.origin);

            if (url.protocol === 'wss:') {
                url.protocol = 'https:';
                connections.add(url.origin);
            }
        }
    }

    const policy = [
        "default-src 'self'",
        "script-src 'self' 'wasm-unsafe-eval'",
        "style-src 'self'",
        `connect-src ${[...connections].join(' ')}`,
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'none'",
        "frame-src 'none'",
    ].join('; ');

    return {
        base: './',
        plugins: [
            {
                name: 'production-content-security-policy',
                apply: 'build',
                transformIndexHtml() {
                    return [
                        {
                            tag: 'meta',
                            attrs: {
                                'http-equiv': 'Content-Security-Policy',
                                content: policy,
                            },
                            injectTo: 'head-prepend',
                        },
                    ];
                },
            },
        ],
        server: {
            strictPort: true,
            proxy: {
                '/auth': {
                    target: 'http://127.0.0.1:8787',
                },
                '/signal': {
                    target: 'http://127.0.0.1:8787',
                },
                '/relay': {
                    target: 'ws://127.0.0.1:8787',
                    ws: true,
                },
            },
        },
    };
});
