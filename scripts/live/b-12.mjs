// Checks 1 and 2: CoS thread basics, streaming growth, queue.
import { start, send, sleep, shot, body, chips } from './b-lib.mjs';
const { app, page } = await start();
console.log('HEAD:', await page.locator('.thread-head h3').innerText());
console.log('TAB:', await page.locator('[role=tab]').allInnerTexts());
await send(page, 'Write exactly three short sentences about tea. No tools.');
await sleep(300);
await send(page, 'Now reply with the single word: ok');
const samples = []; const chipLog = new Set(); const orderSeen = [];
const end = Date.now() + 240000;
let idleCount = 0;
while (Date.now() < end) {
  const s = await page.locator('.msg.streaming .text').first().innerText().catch(() => '');
  if (s) samples.push(s.length + ':' + s.slice(0, 60));
  (await chips(page)).forEach((c) => chipLog.add(c));
  const c = (await chips(page)).join('|');
  if (!/Working|queued/.test(c)) { if (++idleCount > 3) break; } else idleCount = 0;
  await sleep(250);
}
console.log('CHIPS seen:', [...chipLog]);
console.log('STREAM samples (len:prefix) first/mid/last:', samples.length, samples[0], samples[Math.floor(samples.length / 2)], samples[samples.length - 1]);
console.log('distinct lengths:', new Set(samples.map((x) => x.split(':')[0])).size);
await shot(page, 'c12-final');
console.log('BODY:\n' + (await body(page)));
await app.close();
