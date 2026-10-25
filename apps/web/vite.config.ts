import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

const debugLog = fileURLToPath(new URL('../../logs/debug.log', import.meta.url));

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
                name: 'development-debug-log',
                apply: 'serve',
                configureServer(server) {
                    server.middlewares.use('/__debug-log', (request, response) => {
                        const file = new URL(
                            request.url ?? '',
                            'http://localhost',
                        ).searchParams.get('file');
                        if (
                            request.method !== 'POST' ||
                            (file !== null && !/^[\w-][\w.-]{0,199}$/.test(file))
                        ) {
                            response.statusCode = 405;
                            response.end();
                            return;
                        }
                        const chunks: Buffer[] = [];
                        request.on('data', (chunk: Buffer) => chunks.push(chunk));
                        request.on('end', () => {
                            const data = Buffer.concat(chunks);
                            const body = data.toString('utf8').trim();
                            void mkdir(dirname(debugLog), { recursive: true })
                                .then(() =>
                                    file
                                        ? writeFile(join(dirname(debugLog), file), data)
                                        : body
                                          ? appendFile(debugLog, `${body}\n`)
                                          : undefined,
                                )
                                .then(
                                    () => {
                                        response.statusCode = 204;
                                        response.end();
                                    },
                                    () => {
                                        response.statusCode = 500;
                                        response.end();
                                    },
                                );
                        });
                    });
                    server.config.logger.info(`  ➜  Debug log: ${debugLog}`);
                },
            },
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
