// Check 9: two orgs in parallel: separate processes (cwd) and logs.
import { start, send, sleep, shot, body, chips, waitIdle } from './b-lib.mjs';
import { execSync } from 'node:child_process';
const { app, page } = await start();
const icons = page.locator('.org-icon:not(.add)');
const n = await icons.count();
const labels = [];
for (let i = 0; i < n; i++) labels.push(await icons.nth(i).getAttribute('aria-label'));
console.log('ORG ICONS:', labels);
const procs = () => {
  let out = [];
  try {
    const pids = execSync('pgrep -f "claude.* -p .*stream-json"').toString().trim().split('\n').filter(Boolean);
    for (const pid of pids) {
      const cwd = execSync(`lsof -a -d cwd -p ${pid} -Fn 2>/dev/null | grep ^n`).toString().trim();
      out.push(pid + ' ' + cwd);
    }
  } catch (e) { out.push('none/err ' + String(e).slice(0, 60)); }
  return out;
};
await icons.nth(0).click(); await sleep(1500);
const name0 = await page.locator('.topbar h2').innerText();
await send(page, 'Write twelve short sentences about coffee. No tools.');
await sleep(1500);
console.log('org1 chips right after send:', await chips(page), '(org', name0 + ')');
await icons.nth(1).click(); await sleep(1500);
const name1 = await page.locator('.topbar h2').innerText();
await send(page, 'Reply with the single word: ok');
await sleep(2500);
console.log('PROCS during run (org1 should be busy, org2 started):', procs());
console.log('org2 chips:', await chips(page), '(org', name1 + ')');
await shot(page, 'c9-org2');
console.log('org2 idle:', await waitIdle(page));
await icons.nth(0).click(); await sleep(1500);
console.log('org1 idle:', await waitIdle(page));
console.log('ORG1 BODY:', (await body(page)).replace(/\n/g, ' / ').slice(0, 400));
await shot(page, 'c9-org1-back');
await icons.nth(1).click(); await sleep(1000);
console.log('ORG2 BODY:', (await body(page)).replace(/\n/g, ' / ').slice(0, 300));
console.log('PROCS at end:', procs());
await app.close();
