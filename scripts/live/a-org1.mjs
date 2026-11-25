// Check 6 with a single copy (framework_version 0.12.0).
import fs from 'node:fs';
import { mk, cloneHq, open, text, shot, sleep, git, PLUGIN_0_13 } from './a-lib.mjs';
const root = mk(); const a = cloneHq(root, 'hq-a');
let y = fs.readFileSync(`${a}/org.yaml`, 'utf8'); y = y.replace(/framework_version:.*/, 'framework_version: 0.12.0'); fs.writeFileSync(`${a}/org.yaml`, y);
git(a, 'commit', '-qam', 'old fw');
console.log(git(a, 'show', 'HEAD:org.yaml').split('\n').slice(0, 4).join(' / '));
const { app, page } = await open({ COA_SCAN_ROOT: root, COA_PLUGIN_DIR: PLUGIN_0_13 });
await sleep(10000);
console.log('C6 topbar:', (await page.locator('.topbar').innerText()).replace(/\n+/g, ' | '));
console.log('C6 buttons:', await page.locator('.plugin-badge button').allInnerTexts());
await shot(page, '6-single');
await app.close();
