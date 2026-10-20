import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const buildDirectory = resolve(root, '.build/wasm');
const sdkDirectory = process.env.EMSDK ?? resolve(root, '.tools/emsdk');
const toolchain = resolve(
    sdkDirectory,
    'upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake',
);

if (!existsSync(toolchain)) {
    console.error('Emscripten was not found. Activate emsdk or set EMSDK to its directory.');
    process.exit(1);
}

mkdirSync(resolve(root, 'apps/web/public/wasm'), {
    recursive: true,
});

function run(argumentsList) {
    const result = spawnSync('cmake', argumentsList, {
        cwd: root,
        stdio: 'inherit',
    });

    if (result.error || result.status !== 0) {
        console.error(result.error?.message ?? 'The WebAssembly build failed.');
        process.exit(result.status ?? 1);
    }
}

const configureArguments = [
    '-S',
    root,
    '-B',
    buildDirectory,
    '-G',
    'Ninja',
    `-DCMAKE_TOOLCHAIN_FILE=${toolchain}`,
    '-DCMAKE_BUILD_TYPE=Release',
    `-DFETCHCONTENT_BASE_DIR=${resolve(root, '.cache/fetchcontent')}`,
];

if (process.env.CMAKE_CXX_COMPILER_LAUNCHER) {
    configureArguments.push(
        `-DCMAKE_CXX_COMPILER_LAUNCHER=${process.env.CMAKE_CXX_COMPILER_LAUNCHER}`,
    );
}

for (const dependency of ['NBT', 'PROTOCOL', 'NETWORK']) {
    const sourceDirectory = process.env[`FALCON_${dependency}_SOURCE_DIR`];

    if (sourceDirectory) {
        configureArguments.push(
            `-DFETCHCONTENT_SOURCE_DIR_FALCON_${dependency}=${resolve(sourceDirectory)}`,
        );
    }
}

run(configureArguments);
run(['--build', buildDirectory, '--parallel', process.env.BUILD_JOBS ?? '4']);

await import('./package-sources.mjs');
