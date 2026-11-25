import { afterEach, expect, it } from 'vitest';
import { AutoPusher } from '../../src/main/git/autopush';
import { cleanup, commit, makeFixture, sh, type Fixture } from './helpers';

let f: Fixture | undefined;
let ap: AutoPusher | undefined;
afterEach(() => {
  ap?.stop();
  if (f) cleanup(f);
  ap = undefined;
  f = undefined;
});

it('emits head-moved on a commit even when auto push is off, and does not push', async () => {
  f = makeFixture();
  ap = new AutoPusher(f.hq, { enabled: () => false });
  await ap.start();
  const moved = new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('timeout')), 6000);
    ap!.once('head-moved', (v) => {
      clearTimeout(to);
      resolve(v);
    });
  });
  commit(f.hq, 'c.md');
  const v = (await moved) as { head: string };
  expect(v.head).toBe(sh(f.hq, 'rev-parse', 'HEAD').trim());
  expect(sh(f.bare, 'log', '--oneline', 'main').trim().split('\n')).toHaveLength(1);
}, 10000);
