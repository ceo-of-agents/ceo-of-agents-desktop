// Check 8: department tab, hand over, handoff waiting badge, past chat read-only.
import { start, send, sleep, shot, body, chips, waitIdle } from './b-lib.mjs';
const { app, page } = await start();
const tabs = () => page.locator('[role=tab]').allInnerTexts();
const dept = page.locator('.side-panel .item', { has: page.locator('.item-title', { hasText: 'Max' }) });
await dept.getByRole('button', { name: 'Chat' }).click();
await sleep(1000);
console.log('TABS:', await tabs(), '| head:', await page.locator('.thread-head h3').innerText());
await send(page, 'Say hello in five words.');
console.log('idle dept:', await waitIdle(page));
console.log('DEPT BODY:', (await body(page)).replace(/\n/g, ' / '));
await shot(page, 'c8-dept');
await page.getByRole('button', { name: /Hand over to / }).click();
await page.waitForSelector('.card.permission', { timeout: 120000 });
console.log('DEPT CARD:', (await page.locator('.card.permission').innerText()).replace(/\n/g, ' | '));
await shot(page, 'c8-dept-card');
// make the CoS busy right before the handoff lands
await page.locator('[role=tab]', { hasText: 'Chief of Staff' }).click();
await send(page, 'Write twelve short sentences about coffee. No tools.');
await sleep(500);
await page.locator('[role=tab]', { hasText: 'Max' }).click();
await page.getByRole('button', { name: 'Allow', exact: true }).click();
console.log('clicked Allow at', new Date().toISOString());
const seen = new Set();
const end = Date.now() + 180000;
let closed = false;
while (Date.now() < end) {
  const tb = await tabs();
  if (!tb.some((x) => x.startsWith('Max'))) closed = true;
  if (closed) {
    const c = await chips(page);
    c.forEach((x) => seen.add(x));
    const cards = page.locator('.card.permission');
    if (await cards.count()) { console.log('[cos card denying]', (await cards.first().innerText()).replace(/\n/g, ' | ')); await page.getByRole('button', { name: 'Deny', exact: true }).first().click(); }
    if (!c.some((x) => /Working|queued|handoff/.test(x)) && seen.size) break;
  }
  await sleep(300);
}
console.log('tab closed:', closed, '| tabs now:', await tabs(), '| chips seen:', [...seen]);
await shot(page, 'c8-after');
console.log('idle:', await waitIdle(page));
console.log('COS BODY tail:\n' + (await body(page)).split('\n').slice(-14).join('\n'));
await shot(page, 'c8-cos-final');
console.log('DEPT PANEL:', (await dept.innerText()).replace(/\n/g, ' | '));
await dept.locator('.past button').first().click();
await sleep(800);
console.log('TABS after open closed:', await tabs());
console.log('readonly textarea disabled:', await page.locator('textarea').isDisabled(), '| placeholder:', await page.locator('textarea').getAttribute('placeholder'));
console.log('closed chat body:', (await body(page)).replace(/\n/g, ' / ').slice(0, 500));
await shot(page, 'c8-closed-readonly');
await app.close();
