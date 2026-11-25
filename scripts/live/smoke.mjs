// Smoke check: the app starts, finds the hq copies, shows prerequisites or the org view. Sends no message.
import { launch, sleep } from './launch.mjs';

const { app, page } = await launch({
  COA_SCAN_ROOT: process.env.COA_SCAN_ROOT,
  COA_USER_DATA: process.env.COA_USER_DATA,
  COA_PLUGIN_DIR: process.env.COA_PLUGIN_DIR || '',
});
await sleep(Number(process.env.WAIT_MS || 8000));
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
console.log((await page.locator('body').innerText()).slice(0, 3000));
await app.close();
