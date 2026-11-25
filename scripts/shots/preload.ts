// Preload of the screenshot harness: exposes the mock API as window.coa, like src/preload.ts does with the real one.
// The scene name comes from the `--shots-scene=<name>` argument given by main.cjs.
import { contextBridge } from 'electron';
import { createMockApi } from './mock-api';
import { buildScenes } from './scenes';

const arg = process.argv.find((a) => a.startsWith('--shots-scene='));
const name = arg ? arg.slice('--shots-scene='.length) : '';
const scene = buildScenes().find((x) => x.name === name);
if (!scene) throw new Error(`unknown scene: ${name}`);

contextBridge.exposeInMainWorld('coa', createMockApi(scene));
