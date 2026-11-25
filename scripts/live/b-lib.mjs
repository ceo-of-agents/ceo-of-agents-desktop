// Helpers for the b- live checks. Env: B_ROOT (scan root), B_UD (user data), SHOTS (screenshot dir).
import { launch, sleep } from './launch.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export { sleep };
export const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'coa-live-shots');
export async function start(extra = {}) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const r = await launch({
    COA_SCAN_ROOT: process.env.B_ROOT,
    COA_USER_DATA: process.env.B_UD,
    COA_MODEL: 'haiku',
    COA_PLUGIN_DIR: path.join(os.homedir(), '.claude/plugins/cache/ceo-of-agents/ceo-of-agents/0.13.0'),
    ...extra,
  });
  await r.page.waitForSelector('textarea', { timeout: 30000 });
  await sleep(2500);
  return r;
}
export const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, name + '.png') });
export const body = (page) => page.locator('.thread-body').innerText();
export const chips = (page) => page.locator('.thread-head .chip').allInnerTexts();
export async function send(page, text) {
  await page.fill('textarea', text);
  await page.keyboard.press('Enter');
}
export async function waitIdle(page, timeout = 240000, minWait = 2500) {
  await sleep(minWait);
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const cards = page.locator('.card.permission');
    if (await cards.count()) {
      console.log('[waitIdle] permission card, denying:', (await cards.first().innerText()).replace(/\n/g, ' | '));
      await page.getByRole('button', { name: 'Deny', exact: true }).first().click();
      await sleep(1500);
      continue;
    }
    const c = (await chips(page)).join('|');
    if (!/Working|queued|waiting/.test(c)) return true;
    await sleep(1000);
  }
  return false;
}
