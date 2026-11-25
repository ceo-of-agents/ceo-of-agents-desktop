// Sends one message to the CoS thread of the first org and waits for the reply. Uses COA_MODEL (set it to haiku).
import { launch, sleep } from './launch.mjs';

const { app, page } = await launch({
  COA_SCAN_ROOT: process.env.COA_SCAN_ROOT,
  COA_USER_DATA: process.env.COA_USER_DATA,
  COA_PLUGIN_DIR: process.env.COA_PLUGIN_DIR || '',
  COA_MODEL: process.env.COA_MODEL || 'haiku',
});
await page.waitForSelector('textarea', { timeout: 30000 });
await sleep(3000);
await page.fill('textarea', process.env.MSG || 'Reply with the single word: ok');
await page.keyboard.press('Enter');
const end = Date.now() + Number(process.env.TIMEOUT_MS || 180000);
let sawStreaming = false;
while (Date.now() < end) {
  const busy = await page.evaluate(() => document.body.innerText.includes('Working'));
  if (busy) sawStreaming = true;
  if (sawStreaming && !busy) break;
  await sleep(1000);
}
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
console.log(JSON.stringify({ sawBusy: sawStreaming }));
console.log((await page.locator('.thread, [class*=thread]').first().innerText().catch(() => '')).slice(-2500));
await app.close();
