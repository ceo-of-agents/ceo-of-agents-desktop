// Checks 6 and 8: org update available, two orgs, last used org reopens. Real config, read-only plugin dir.
import fs from 'node:fs';
import { mk, cloneHq, open, text, shot, waitText, sleep, git, PLUGIN_0_13 } from './a-lib.mjs';
const root = mk(); const a = cloneHq(root, 'hq-a'); const b = cloneHq(root, 'hq-b');
let y = fs.readFileSync(`${a}/org.yaml`, 'utf8'); y = y.replace(/framework_version:.*/, 'framework_version: 0.12.0'); fs.writeFileSync(`${a}/org.yaml`, y);
git(a, 'commit', '-qam', 'old fw');
const env = { COA_SCAN_ROOT: root, COA_PLUGIN_DIR: PLUGIN_0_13 };
const ud = mk();
let { app, page } = await open({ ...env, COA_USER_DATA: ud });
await waitText(page, /Local only|Healthy|Needs sync|Problem/, 30000); await sleep(3000);
console.log('C8 icons:', await page.locator('.org-icon:not(.add)').count(), await page.locator('.org-icon:not(.add)').evaluateAll((e) => e.map((x) => x.getAttribute('aria-label'))));
const n = await page.locator('.org-icon:not(.add)').count();
for (let i = 0; i < n; i++) {
  await page.locator('.org-icon:not(.add)').nth(i).click(); await sleep(4000);
  console.log('C6 icon', i, '|', (await page.locator('.topbar').innerText()).replace(/\n+/g, ' | '));
  await shot(page, `6-icon${i}`);
}
// select the second, relaunch via same ud
const last = await page.locator('.org-icon:not(.add)').evaluateAll((e) => e.findIndex((x) => x.classList.contains('active')));
console.log('C8 last selected:', last);
await app.close();
const { launch } = await import('./launch.mjs');
({ app, page } = await launch({ ...env, COA_USER_DATA: ud, BROWSER: '/usr/bin/true' }));
await sleep(6000);
console.log('C8 after relaunch active index:', await page.locator('.org-icon:not(.add)').evaluateAll((e) => e.findIndex((x) => x.classList.contains('active'))), '| header:', await page.locator('.topbar h2').innerText());
await app.close();
