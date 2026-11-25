// Helpers for the "a-" live checks. Temp folders only; never the real hq.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, sleep } from './launch.mjs';
export { sleep };
export const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'coa-live-shots');
/** Source hq, cloned read-only into temp folders (the copy's remote is removed). Required. */
export const REAL_HQ = process.env.COA_SOURCE_HQ || '';
if (!REAL_HQ) throw new Error('Set COA_SOURCE_HQ to the hq to clone (read-only)');
export const PLUGIN_0_13 = `${process.env.HOME}/.claude/plugins/cache/ceo-of-agents/ceo-of-agents/0.13.0`;
export const mk = () => execFileSync('mktemp', ['-d', '/tmp/coa-a-XXXX'], { encoding: 'utf8' }).trim();
export const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
export function cloneHq(root, name) {
  const dest = path.join(root, name);
  execFileSync('git', ['clone', '-q', REAL_HQ, dest]);
  git(dest, 'remote', 'remove', 'origin');
  git(dest, 'config', 'user.name', 'Test');
  git(dest, 'config', 'user.email', 'test@example.com');
  return dest;
}
export function commit(dir, msg = 'test commit') {
  fs.writeFileSync(path.join(dir, `f-${Date.now()}.txt`), msg);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
}
export async function open(env) {
  const ud = mk();
  const { app, page } = await launch({ COA_USER_DATA: ud, BROWSER: '/usr/bin/true', ...env });
  return { app, page, ud };
}
export const text = async (page) => (await page.locator('body').innerText()).replace(/\n+/g, ' | ');
export const shot = (page, n) => page.screenshot({ path: `${SHOTS}/${n}.png` });
export async function waitText(page, re, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const t = await text(page); if (re.test(t)) return t; await sleep(400); }
  return null;
}
