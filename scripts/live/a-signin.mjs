// Check 3: Sign in / Cancel. Usage: ROOT=.. CFG=.. node a-signin.mjs
import { open, text, shot, waitText, sleep } from './a-lib.mjs';
import { execSync } from 'node:child_process';
const { app, page } = await open({ COA_SCAN_ROOT: process.env.ROOT, CLAUDE_CONFIG_DIR: process.env.CFG });
await waitText(page, /not signed in/i);
await page.getByRole('button', { name: 'Sign in', exact: true }).click();
await waitText(page, /https:\/\//, 30000);
await sleep(1000);
console.log('C3 body:', await text(page));
console.log('C3 links:', await page.locator('a.link').evaluateAll((a) => a.map((x) => x.href.slice(0, 60))));
console.log('C3 inputs:', await page.locator('input, textarea').count());
console.log('C3 buttons:', await page.locator('button').allInnerTexts());
console.log('C3 pgrep during:', execSync('pgrep -fl "auth login" || true', { encoding: 'utf8' }));
await shot(page, '3-signin');
await page.getByRole('button', { name: 'Cancel', exact: true }).click();
await sleep(2500);
console.log('C3 after cancel:', await text(page));
console.log('C3 pgrep after:', JSON.stringify(execSync('pgrep -fl "auth login" || true', { encoding: 'utf8' })));
await app.close();
