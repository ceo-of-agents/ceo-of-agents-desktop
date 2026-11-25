// Shared launcher for live checks: starts the built app with Playwright's Electron driver.
// Never point these at a real hq: COA_SCAN_ROOT must be a temp folder holding hq copies.
import { _electron as electron } from 'playwright-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function launch(env) {
  if (!env.COA_SCAN_ROOT || !env.COA_USER_DATA) throw new Error('COA_SCAN_ROOT and COA_USER_DATA are required');
  const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, ...env } });
  const page = await app.firstWindow();
  page.on('console', (m) => { if (m.type() === 'error') console.error('[renderer]', m.text()); });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  return { app, page };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
