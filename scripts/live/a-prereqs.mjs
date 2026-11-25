// Checks 1-3 (empty CLAUDE_CONFIG_DIR): prereqs screen, Install, Sign in/Cancel. Writes cfg path to $OUT.
import { mk, cloneHq, open, text, shot, waitText, sleep, git } from './a-lib.mjs';
import { execSync } from 'node:child_process';
const root = mk(); const cfg = mk(); const hq = cloneHq(root, 'hq-1');
console.log('root', root, 'cfg', cfg, 'hq', hq);
const { app, page } = await open({ COA_SCAN_ROOT: root, CLAUDE_CONFIG_DIR: cfg });
console.log('C1', await waitText(page, /Before we start/, 20000) && (await waitText(page, /plugin/i, 15000)));
await sleep(3000);
console.log('C1 body:', await text(page));
await shot(page, '1-prereqs');
await page.getByRole('button', { name: 'Install', exact: true }).click();
console.log('C2 after click:', await text(page));
const r = await waitText(page, /installed for this org|Could not|confirmation/, 120000);
await sleep(2000);
console.log('C2 result:', await text(page));
await shot(page, '2-installed');
console.log('C2 plugin list:', execSync('claude plugin list --json', { cwd: hq, env: { ...process.env, CLAUDE_CONFIG_DIR: cfg }, encoding: 'utf8' }).slice(0, 1500));
console.log('C2 git status:', JSON.stringify(git(hq, 'status', '--porcelain')));
await app.close();
