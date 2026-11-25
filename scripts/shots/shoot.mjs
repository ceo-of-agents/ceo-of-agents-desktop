// Screenshot harness entry: node scripts/shots/shoot.mjs [--no-build] [scene ...]
// SHOTS=<folder> is required. REDUCED=1 emulates prefers-reduced-motion. See scripts/shots/README.md.
import { build } from 'esbuild';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const noBuild = args.includes('--no-build');
const scenes = args.filter((a) => !a.startsWith('--'));

const shots = process.env.SHOTS;
if (!shots) {
  console.error('SHOTS is required: the folder for the PNGs, for example SHOTS=/tmp/coa-shots node scripts/shots/shoot.mjs');
  process.exit(2);
}

if (!noBuild) {
  const r = spawnSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// The preload (with the mock) and the scene data are bundled next to the app's own build. build.mjs wipes dist/ first.
const common = { bundle: true, sourcemap: true, logLevel: 'warning', platform: 'node', format: 'cjs', target: 'node22', loader: { '.json': 'json' } };
await Promise.all([
  build({ ...common, entryPoints: ['scripts/shots/preload.ts'], outfile: 'dist/shots/preload.js', external: ['electron'] }),
  build({ ...common, entryPoints: ['scripts/shots/scenes.ts'], outfile: 'dist/shots/scenes.cjs' }),
]);

const electron = createRequire(import.meta.url)('electron');
const child = spawn(electron, ['scripts/shots/main.cjs'], {
  stdio: 'inherit',
  env: { ...process.env, SHOTS: resolve(shots), SHOTS_DIST: resolve('dist'), SHOTS_SCENES: scenes.join(',') },
});
child.on('exit', (code) => process.exit(code ?? 1));
