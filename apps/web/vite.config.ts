import { defineConfig } from 'vite';

export default defineConfig({
    base: './',
    server: {
        strictPort: true,
        proxy: {
            '/relay': {
                target: 'ws://127.0.0.1:8787',
                ws: true,
            },
        },
    },
});
