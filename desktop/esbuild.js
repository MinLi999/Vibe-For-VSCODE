/**
 * Bundles the Electron app into dist/:
 *   main.ts     -> dist/main.js      (main process, reuses client services)
 *   preload.ts  -> dist/preload.js   (settings window bridge)
 *   ui/settings.ts -> dist/settings.js (renderer, browser target)
 * plus copies ui/settings.html alongside.
 */
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const production = process.argv.includes('--production');

const common = { bundle: true, sourcemap: !production, minify: production };

Promise.all([
  esbuild.build({
    ...common,
    entryPoints: ['src/main.ts'],
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: 'dist/main.js',
    external: ['electron'],
  }),
  esbuild.build({
    ...common,
    entryPoints: ['src/preload.ts'],
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: 'dist/preload.js',
    external: ['electron'],
  }),
  esbuild.build({
    ...common,
    entryPoints: ['src/ui/settings.ts'],
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
    outfile: 'dist/settings.js',
  }),
])
  .then(() => {
    fs.copyFileSync(path.join(__dirname, 'src/ui/settings.html'), path.join(__dirname, 'dist/settings.html'));
    console.log('[desktop] build ok');
  })
  .catch(() => process.exit(1));
