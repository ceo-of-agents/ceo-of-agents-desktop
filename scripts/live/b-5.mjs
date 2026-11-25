// Check 5: permissions card, Always allow, then Deny.
import { start, send, sleep, shot, body, waitIdle, chips } from './b-lib.mjs';
import fs from 'node:fs';
const hq = process.env.HQ;
const { app, page } = await start();
await page.click('button.gear');
await sleep(500);
console.log('SETTINGS:', (await page.locator('.modal, [role=dialog]').first().innerText().catch(() => '')).replace(/\n/g, ' | '));
console.log('checked radio index:', await page.evaluate(() => [...document.querySelectorAll('input[name=permissionMode]')].findIndex((e) => e.checked)));
await shot(page, 'c5-settings');
await page.locator('.modal button', { hasText: 'Close' }).click();
await sleep(500);
await send(page, 'Use the Write tool to create the file app-live-test.txt containing hi. Do nothing else. Answer in one short sentence.');
await page.waitForSelector('.card.permission', { timeout: 120000 });
console.log('CARD:', (await page.locator('.card.permission').innerText()).replace(/\n/g, ' | '));
console.log('buttons:', await page.locator('.card.permission button').allInnerTexts());
await shot(page, 'c5-card');
await page.getByRole('button', { name: 'Always allow' }).click();
console.log('idle1:', await waitIdle(page));
console.log('file exists:', fs.existsSync(hq + '/app-live-test.txt'), fs.existsSync(hq + '/app-live-test.txt') && fs.readFileSync(hq + '/app-live-test.txt', 'utf8'));
console.log('settings.local.json:', fs.existsSync(hq + '/.claude/settings.local.json') ? fs.readFileSync(hq + '/.claude/settings.local.json', 'utf8') : 'MISSING');
await shot(page, 'c5-after-always');
await send(page, 'Use the Write tool to create the file app-live-test-2.txt containing no. Do nothing else. Answer in one short sentence.');
let card2 = true;
try { await page.waitForSelector('.card.permission', { timeout: 90000 }); } catch { card2 = false; }
console.log('second card appeared:', card2);
if (card2) {
  console.log('CARD2:', (await page.locator('.card.permission').innerText()).replace(/\n/g, ' | '));
  await shot(page, 'c5-card2');
  await page.getByRole('button', { name: 'Deny', exact: true }).click();
}
console.log('idle2:', await waitIdle(page));
console.log('file2 exists:', fs.existsSync(hq + '/app-live-test-2.txt'));
console.log('BODY tail:\n' + (await body(page)).split('\n').slice(-12).join('\n'));
await shot(page, 'c5-after-deny');
await app.close();
