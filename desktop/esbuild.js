/** Bundles the Electron main process (plus the reused client services) into dist/main.js. */
const esbuild = require('esbuild');

const production = process.argv.includes('--production');

esbuild
  .build({
    entryPoints: ['src/main.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: 'dist/main.js',
    external: ['electron'],
    sourcemap: !production,
    minify: production,
  })
  .then(() => console.log('[desktop] build ok'))
  .catch(() => process.exit(1));
