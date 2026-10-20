import { spawnSync } from 'node:child_process';
import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = resolve(root, 'apps/web/public/third-party');
const declarations = await readFile(resolve(root, 'cmake/Dependencies.cmake'), 'utf8');
const dependencies = [
    ...declarations.matchAll(
        /FetchContent_Declare\(\s*(falcon_\w+)\s+GIT_REPOSITORY\s+(\S+)\s+GIT_TAG\s+([a-f0-9]{40})/g,
    ),
];

await mkdir(destination, {
    recursive: true,
});

const manifest = [];

for (const [, name, repository, revision] of dependencies) {
    const environmentName = `${name.toUpperCase()}_SOURCE_DIR`;
    const source = process.env[environmentName]
        ? resolve(process.env[environmentName])
        : resolve(root, '.cache/fetchcontent', `${name}-src`);

    const clean = spawnSync('git', ['diff', '--quiet', revision, '--'], {
        cwd: source,
    });

    if (clean.error || clean.status !== 0) {
        throw new Error(`Cannot package modified ${name} sources as revision ${revision}.`);
    }

    const archive = `${name}-${revision}.tar`;
    const result = spawnSync(
        'git',
        ['archive', '--format=tar', `--output=${resolve(destination, archive)}`, revision],
        {
            cwd: source,
            stdio: 'inherit',
        },
    );

    if (result.error || result.status !== 0) {
        throw new Error(`Could not package ${name} source archive.`);
    }

    await copyFile(resolve(source, 'LICENSE'), resolve(destination, `${name}-LICENSE`));
    await copyFile(resolve(source, 'COPYING'), resolve(destination, `${name}-COPYING`));

    manifest.push({
        name,
        repository,
        revision,
        archive,
    });
}

const relinkDirectory = resolve(destination, 'relink');

for (const path of ['CMakeLists.txt', 'cmake', 'native', 'LICENSE', 'NOTICE']) {
    await cp(resolve(root, path), resolve(relinkDirectory, path), {
        recursive: true,
    });
}

await writeFile(resolve(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 4)}\n`);
await writeFile(
    resolve(destination, 'README.txt'),
    [
        'Bedrock Packs: corresponding source and relinking',
        '',
        'The WASM module statically links LGPL-3.0 Falcon components.',
        'Their exact source archives and license texts are provided beside this file.',
        'The relink/ directory contains the application C++ source and CMake build files.',
        '',
        'To rebuild or relink with modified libraries:',
        '1. Install and activate Emscripten 4.0.23, CMake 3.24+, Ninja and Git.',
        '2. Download relink/ and the three source archives listed in manifest.json.',
        '3. Extract each source archive into a separate directory.',
        '4. Configure from relink/ with:',
        '   emcmake cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release',
        '     -DFETCHCONTENT_SOURCE_DIR_FALCON_NBT=/path/to/nbt',
        '     -DFETCHCONTENT_SOURCE_DIR_FALCON_PROTOCOL=/path/to/protocol',
        '     -DFETCHCONTENT_SOURCE_DIR_FALCON_NETWORK=/path/to/network',
        '   (Join the configuration arguments onto one command.)',
        '5. Run cmake --build build --parallel 4.',
        '6. Replace wasm/bedrock-packs.mjs and wasm/bedrock-packs.wasm in the website',
        '   with the generated files from apps/web/public/wasm/.',
        '',
        'The application permits replacing these libraries with modified versions.',
        'No account credentials or Minecraft assets are required to rebuild.',
        '',
    ].join('\n'),
);
