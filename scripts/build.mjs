// Bundles the main process, the preload script, the MCP permission server and the renderer with esbuild.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/renderer', { recursive: true });

const common = { bundle: true, sourcemap: true, logLevel: 'warning' };
await Promise.all([
  build({ ...common, entryPoints: ['src/main/index.ts'], outfile: 'dist/main.js', platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.js', platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/mcp/permission-server.ts'], outfile: 'dist/permission-server.js', platform: 'node', format: 'cjs', target: 'node22' }),
  build({ ...common, entryPoints: ['src/renderer/styles.css'], outfile: 'dist/renderer/styles.css', target: 'chrome140', loader: { '.css': 'css' } }),
  build({ ...common, entryPoints: ['src/renderer/main.tsx'], outfile: 'dist/renderer/renderer.js', platform: 'browser', format: 'iife', target: 'chrome140', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.json': 'json' } }),
]);
cpSync('src/renderer/index.html', 'dist/renderer/index.html');
cpSync('assets/icon/icon-1024.png', 'dist/icon-1024.png');
