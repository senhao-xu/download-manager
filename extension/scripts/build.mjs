import { build } from 'esbuild';
import { cp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await cp('public', 'dist', { recursive: true });
for (const name of ['background', 'offscreen', 'engine', 'content', 'popup']) {
  await build({ entryPoints: [`src/${name}.ts`], outfile: `dist/${name}.js`, bundle: true, format: name === 'content' ? 'iife' : 'esm', platform: 'browser', target: 'chrome120', minify: true, legalComments: 'eof', conditions: ['browser'], logLevel: 'warning' });
}
const variant = dirname(require.resolve('@jitl/quickjs-wasmfile-release-sync/package.json'));
await cp(resolve(variant, 'dist/emscripten-module.wasm'), 'dist/quickjs.wasm');
let notices = 'Bundled third-party licenses\n\n';
for (const name of (await readdir('node_modules')).filter(name => !name.startsWith('.'))) {
  const packages = name.startsWith('@') ? (await readdir(`node_modules/${name}`)).map(sub => `${name}/${sub}`) : [name];
  for (const pkg of packages) {
    const path = `node_modules/${pkg}`;
    for (const license of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE-MIT']) {
      try { notices += `\n--- ${pkg} ---\n${await readFile(`${path}/${license}`, 'utf8')}\n`; break; } catch {}
    }
  }
}
await writeFile('dist/THIRD_PARTY_NOTICES.txt', notices);
await cp('README.md', 'dist/安装说明.md');
