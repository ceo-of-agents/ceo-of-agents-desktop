// Probe for an intermittent renderer crash: open/close Settings, send a short message, repeat. Uses COA_MODEL (haiku).
import { launch, sleep } from './launch.mjs';

const { app, page } = await launch({
  COA_SCAN_ROOT: process.env.COA_SCAN_ROOT,
  COA_USER_DATA: process.env.COA_USER_DATA,
  COA_PLUGIN_DIR: process.env.COA_PLUGIN_DIR || '',
  COA_MODEL: process.env.COA_MODEL || 'haiku',
});
app.process().stderr.on('data', (d) => process.stderr.write('[main] ' + d));
let crashed = 0;
page.on('crash', () => { crashed++; console.log('PAGE CRASH'); });
await page.waitForSelector('textarea', { timeout: 30000 });
for (let i = 0; i < Number(process.env.ROUNDS || 3); i++) {
  await page.click('button.gear');
  await sleep(400);
  await page.locator('.modal button', { hasText: 'Close' }).click();
  await sleep(300);
  await page.fill('textarea', `Reply with the single word: ok${i}`);
  await page.keyboard.press('Enter');
  const end = Date.now() + 120000;
  await sleep(1500);
  while (Date.now() < end) {
    const busy = await page.evaluate(() => document.body.innerText.includes('Working')).catch(() => true);
    if (!busy) break;
    await sleep(800);
  }
  console.log('round', i, 'done, crashes so far', crashed);
}
console.log((await page.locator('body').innerText()).split('\n').slice(-8).join(' | '));
await app.close();
