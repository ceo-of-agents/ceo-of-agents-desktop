// Checks 5 (reachable) and 6: signed-in real config for auth/sessions, but `claude plugin ...` is routed to an EMPTY config via a wrapper.
// Usage: ROOT=<root with hq copy> CFG=<empty cfg with plugin installed for that copy> MODE=update|org node a-pluginsigned.mjs
import fs from 'node:fs';
import { mk, open, text, shot, sleep, waitText } from './a-lib.mjs';
// The real, signed-in claude binary (path from REAL_CLAUDE, else the first `claude` on PATH).
const real = process.env.REAL_CLAUDE || 'claude';
const d = mk(); const bin = `${d}/claude`;
fs.writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "plugin" ]; then echo "$@" >> ${d}/plugin-calls.log; CLAUDE_CONFIG_DIR="${process.env.CFG}" exec ${real} "$@"; fi\nexec ${real} "$@"\n`, { mode: 0o755 });
const { app, page } = await open({ COA_SCAN_ROOT: process.env.ROOT, COA_CLAUDE_BIN: bin });
await sleep(10000);
console.log('top bar:', (await page.locator('.topbar').innerText().catch(() => 'NO TOPBAR')).replace(/\n+/g, ' | '));
console.log('badge buttons:', await page.locator('.plugin-badge button').allInnerTexts());
await shot(page, `${process.env.MODE}-before`);
if (process.env.MODE === 'update') {
  await page.locator('.plugin-badge button', { hasText: 'Update' }).first().click();
  await sleep(1500);
  console.log('during:', (await page.locator('.topbar').innerText()).replace(/\n+/g, ' | '));
  await sleep(25000);
  console.log('after:', (await page.locator('.topbar').innerText().catch(() => 'NO TOPBAR')).replace(/\n+/g, ' | '));
  await shot(page, 'update-after');
  console.log('calls:', fs.readFileSync(`${d}/plugin-calls.log`, 'utf8'));
}
await app.close();
