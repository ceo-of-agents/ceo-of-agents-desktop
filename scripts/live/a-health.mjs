// Check 7: hq health, auto push, sync, behind, push failure, conflict. Real config, read-only plugin dir. No chat.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mk, cloneHq, commit, open, text, shot, sleep, git, PLUGIN_0_13, waitText } from './a-lib.mjs';
import { launch } from './launch.mjs';
const log = (...a) => console.log(...a);
const hbtn = (page) => page.locator('.health-btn');
const state = async (page) => ((await hbtn(page).innerText().catch(() => 'none'))).replace(/\n/g, ' ');
async function popover(page) {
  await hbtn(page).click(); await sleep(400);
  const t = (await page.locator('.popover').innerText().catch(() => 'NO POPOVER')).replace(/\n+/g, ' | ');
  const btns = await page.locator('.popover button').evaluateAll((b) => b.map((x) => `${x.innerText}[disabled=${x.disabled},title=${x.title}]`));
  await hbtn(page).click();
  return { t, btns };
}
async function until(page, re, ms = 30000) { const e = Date.now() + ms; while (Date.now() < e) { if (re.test(await state(page))) return true; await sleep(500); } return false; }
const thread = async (page) => (await page.locator('.center-col').innerText()).replace(/\n+/g, ' | ');
const mkEnv = (root, ud) => ({ COA_SCAN_ROOT: root, COA_PLUGIN_DIR: PLUGIN_0_13, COA_USER_DATA: ud, BROWSER: '/usr/bin/true' });

// ---- A: no remote
{
  const root = mk(); cloneHq(root, 'hq-local');
  const { app, page } = await open({ COA_SCAN_ROOT: root, COA_PLUGIN_DIR: PLUGIN_0_13 });
  await until(page, /Local only/, 20000);
  log('7A state:', await state(page), JSON.stringify(await popover(page)));
  await hbtn(page).click(); await shot(page, '7a-local-only'); await app.close();
}

// ---- B..: bare remote
const root = mk(); const hq = cloneHq(root, 'hq-r'); const bare = `${mk()}/remote.git`;
git(root, 'init', '-q', '--bare', bare);
git(hq, 'remote', 'add', 'origin', bare); git(hq, 'push', '-q', '-u', 'origin', 'main');
const ud = mk(); const env = mkEnv(root, ud);
let { app, page } = await launch(env);
log('7B green after open:', await until(page, /Healthy/, 25000), await state(page));
log('7B popover:', JSON.stringify(await popover(page))); await shot(page, '7b-green');

// auto push
commit(hq, 'auto push 1');
const sha1 = git(hq, 'rev-parse', 'HEAD');
let pushed = false; const t0 = Date.now();
while (Date.now() - t0 < 20000) { if (git(bare, 'rev-parse', 'main') === sha1) { pushed = true; break; } await sleep(500); }
log('7C pushed to bare:', pushed, `${Date.now() - t0}ms`);
await sleep(2000);
log('7C state:', await state(page), '| thread has "Saved and sent":', /Saved and sent to GitHub/.test(await thread(page)));
await shot(page, '7c-autopush');

// auto push off
await page.locator('.gear').click(); await sleep(500);
const cb = page.getByLabel('Send to GitHub automatically'); if (await cb.isChecked()) await cb.click(); await sleep(1000);
log('7D autopush checked now:', await cb.isChecked());
await page.locator('.modal').getByRole('button', { name: 'Close' }).click();
commit(hq, 'auto push off');
const sha2 = git(hq, 'rev-parse', 'HEAD');
await sleep(12000);
log('7D pushed while off:', git(bare, 'rev-parse', 'main') === sha2, '| state:', await state(page));
await page.locator('.org-icon:not(.add)').first().click(); await sleep(1000); /* re-activate the org to force a health refresh */ await until(page, /Needs sync/, 20000); log('7D state after re-activating org:', await state(page), JSON.stringify(await popover(page)));
await shot(page, '7d-needs-sync');
await hbtn(page).click(); await page.locator('.popover').getByRole('button', { name: 'Sync' }).click();
await until(page, /Healthy/, 30000);
log('7D after Sync: state', await state(page), '| pushed:', git(bare, 'rev-parse', 'main') === sha2);
// turn auto push back on
await page.locator('.gear').click(); await sleep(400); await page.getByLabel('Send to GitHub automatically').click(); await sleep(800); await page.locator('.modal').getByRole('button', { name: 'Close' }).click();
await app.close();

// ---- behind
const other = `${mk()}/other`; execFileSync('git', ['clone', '-q', bare, other]); git(other, 'config', 'user.name', 'Test'); git(other, 'config', 'user.email', 'test@example.com');
commit(other, 'from other'); git(other, 'push', '-q', 'origin', 'main'); const shaO = git(other, 'rev-parse', 'HEAD');
({ app, page } = await launch(env));
await sleep(10000);
log('7E local after reopen == remote:', git(hq, 'rev-parse', 'HEAD') === shaO, '| state:', await state(page));
await shot(page, '7e-behind');

// ---- push failure
git(hq, 'remote', 'set-url', 'origin', '/tmp/does-not-exist.git');
commit(hq, 'will fail');
const shaF = git(hq, 'rev-parse', 'HEAD');
await sleep(12000);
log('7F state during failure:', await state(page), JSON.stringify(await popover(page)));
const th = await thread(page); log('7F push-failed lines:', (th.match(/sending to GitHub failed/g) || []).length);
await shot(page, '7f-failure');
git(hq, 'remote', 'set-url', 'origin', bare);
const t1 = Date.now(); let ok = false;
while (Date.now() - t1 < 40000) { if (git(bare, 'rev-parse', 'main') === shaF) { ok = true; break; } await sleep(1000); }
log('7F restored, pushed:', ok, `${Date.now() - t1}ms`);
await until(page, /Healthy/, 30000); log('7F state after:', await state(page));
await app.close();

// ---- conflict
const o2 = `${mk()}/o2`; execFileSync('git', ['clone', '-q', bare, o2]); git(o2, 'config', 'user.name', 'Test'); git(o2, 'config', 'user.email', 'test@example.com');
fs.writeFileSync(`${o2}/x.txt`, 'remote'); git(o2, 'add', '-A'); git(o2, 'commit', '-qm', 'remote side'); git(o2, 'push', '-q', 'origin', 'main');
fs.writeFileSync(`${hq}/y.txt`, 'local'); git(hq, 'add', '-A'); git(hq, 'commit', '-qm', 'local side');
({ app, page } = await launch({ ...env }));
await sleep(3000);
// open with auto push off would avoid a rejected push; it is on by default again, so a push may be tried
await until(page, /Problem/, 30000);
log('7G state:', await state(page), JSON.stringify(await popover(page)));
await shot(page, '7g-conflict');
log('7G local log:', git(hq, 'log', '--oneline', '-3'));
await app.close();
