// Checks 6 and 7: Waiting panel via file watch, Approve / Answer, initiative Close.
import { start, send, sleep, shot, body, waitIdle } from './b-lib.mjs';
import fs from 'node:fs';
const hq = process.env.HQ;
const { app, page } = await start();
const panelText = () => page.locator('.side-panel').innerText();
const badge = () => page.locator('.org-icon .badge').allInnerTexts();
console.log('BEFORE badge:', await badge(), '| waiting panel:', (await page.locator('.panel-section').first().innerText()).replace(/\n/g, ' | '));
const f = hq + '/company/state.md';
let s = fs.readFileSync(f, 'utf8');
const marker = '## Waiting on the CEO';
const i = s.indexOf(marker);
const j = s.indexOf('- none', i);
s = s.slice(0, j) + '- ACME-A99 [normal]: Test action, reply only "noted" (since 2026-11-17)\n- ACME-D99 [low]: Test decision, reply only "noted" (since 2026-11-17)' + s.slice(j + 6);
const t0 = Date.now();
fs.writeFileSync(f, s);
let seen = null;
while (Date.now() - t0 < 20000) {
  const p = await panelText();
  if (p.includes('ACME-A99') && p.includes('ACME-D99')) { seen = Date.now() - t0; break; }
  await sleep(250);
}
console.log('panel shows both after ms:', seen);
await sleep(500);
console.log('badge:', await badge());
console.log('PANEL waiting:', (await page.locator('.panel-section').first().innerText()).replace(/\n/g, ' | '));
await shot(page, 'c6-waiting');
await page.locator('.item', { has: page.locator('code', { hasText: 'ACME-A99' }) }).getByRole('button', { name: 'Approve' }).click();
await sleep(800);
console.log('after approve body tail:', (await body(page)).split('\n').slice(-3).join(' / '));
console.log('idle:', await waitIdle(page));
console.log('BODY tail:', (await body(page)).split('\n').slice(-4).join(' / '));
await page.locator('.item', { has: page.locator('code', { hasText: 'ACME-D99' }) }).getByRole('button', { name: 'Answer' }).click();
await sleep(500);
console.log('textarea value:', JSON.stringify(await page.inputValue('textarea')));
await shot(page, 'c6-answer-prefill');
await page.fill('textarea', '');
// check 7
console.log('INITIATIVES:', (await page.locator('.panel-section').nth(1).innerText()).replace(/\n/g, ' | '));
await shot(page, 'c7-initiatives');
const item = page.locator('.item', { has: page.locator('.item-title', { hasText: 'Micro-org interface' }) });
await item.getByRole('button', { name: 'Close', exact: true }).click();
console.log('confirm text:', (await item.locator('.confirm').innerText()).replace(/\n/g, ' | '));
await item.getByRole('button', { name: 'Yes, send' }).click();
await sleep(800);
console.log('thread tail after close:', (await body(page)).split('\n').slice(-2).join(' / '));
console.log('idle:', await waitIdle(page));
console.log('BODY tail:', (await body(page)).split('\n').slice(-4).join(' / '));
await shot(page, 'c7-after');
await app.close();
