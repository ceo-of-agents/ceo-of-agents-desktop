import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutoPusher, isNonFastForward, isRebaseConflict, shortError } from '../../src/main/git/autopush';
import { run, type Runner } from '../../src/main/system/exec';
import { waitFor as poll } from '../org/helpers';
import { cleanup, commit, makeFixture, sh, type Fixture } from './helpers';

// Real git processes plus a 1 s debounce: give every test and wait room on a busy machine.
const WAIT_MS = 20_000;
vi.setConfig({ testTimeout: 40_000 });

/** True while the pusher is inside a check (private flag), so a negative assertion can wait until its chance has passed. */
const checking = (ap: AutoPusher | undefined) => (ap as unknown as { running: boolean } | undefined)?.running ?? false;

function waitFor(ap: AutoPusher, event: string, ms = WAIT_MS): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    ap.once(event, (v) => {
      clearTimeout(to);
      resolve(v);
    });
  });
}

describe('AutoPusher', () => {
  let f: Fixture | undefined;
  let ap: AutoPusher | undefined;
  afterEach(() => {
    ap?.stop();
    ap = undefined;
    if (f) cleanup(f);
    f = undefined;
  });

  it('pushes after a commit', async () => {
    f = makeFixture();
    ap = new AutoPusher(f.hq, { enabled: () => true });
    await ap.start();
    const p = waitFor(ap, 'pushed');
    commit(f.hq, 'b.md');
    await p;
    expect(sh(f.bare, 'log', '--oneline', 'main').trim().split('\n')).toHaveLength(2);
    expect(ap.failing).toBe(false);
  });

  it('does nothing when disabled', async () => {
    f = makeFixture();
    ap = new AutoPusher(f.hq, { enabled: () => false });
    await ap.start();
    let pushed = false;
    ap.on('pushed', () => (pushed = true));
    const moved = waitFor(ap, 'head-moved');
    commit(f.hq, 'b.md');
    await moved; // the check ran: it stops at the disabled gate
    await poll(() => !checking(ap), WAIT_MS);
    expect(pushed).toBe(false);
    expect(sh(f.bare, 'log', '--oneline', 'main').trim().split('\n')).toHaveLength(1);
  });

  it('does nothing without a remote', async () => {
    f = makeFixture(false);
    ap = new AutoPusher(f.hq, { enabled: () => true });
    await ap.start();
    let events = 0;
    ap.on('pushed', () => events++);
    ap.on('push-failed', () => events++);
    const moved = waitFor(ap, 'head-moved');
    commit(f.hq, 'b.md');
    await moved; // the check ran: it stops at the missing remote
    await poll(() => !checking(ap), WAIT_MS);
    expect(events).toBe(0);
  });

  it('retries after failure and clears when fixed', async () => {
    f = makeFixture();
    sh(f.hq, 'remote', 'set-url', 'origin', `${f.root}/missing.git`);
    ap = new AutoPusher(f.hq, { enabled: () => true, retryDelaysMs: [200, 400], failureThreshold: 1 });
    await ap.start();
    const failed = waitFor(ap, 'push-failed');
    commit(f.hq, 'b.md');
    const ev = (await failed) as { error: string; nextRetryMs: number };
    expect(ev.nextRetryMs).toBe(200);
    expect(ev.error).toBeTruthy();
    expect(ap.failing).toBe(true);
    const second = (await waitFor(ap, 'push-failed')) as { nextRetryMs: number };
    expect(second.nextRetryMs).toBe(400);
    sh(f.hq, 'remote', 'set-url', 'origin', f.bare);
    await waitFor(ap, 'pushed');
    expect(ap.failing).toBe(false);
    expect(sh(f.bare, 'log', '--oneline', 'main').trim().split('\n')).toHaveLength(2);
  });

  it('markSynced clears failing', async () => {
    f = makeFixture();
    sh(f.hq, 'remote', 'set-url', 'origin', `${f.root}/missing.git`);
    ap = new AutoPusher(f.hq, { enabled: () => true, retryDelaysMs: [60000], failureThreshold: 1 });
    await ap.start();
    const failed = waitFor(ap, 'push-failed');
    commit(f.hq, 'b.md');
    await failed;
    ap.markSynced();
    expect(ap.failing).toBe(false);
  });

  /** A pusher that stays idle until we flip `on`, so a test can set up the remote first. */
  function gated(hq: string, extra: Partial<ConstructorParameters<typeof AutoPusher>[1]> = {}) {
    const state = { on: false, pushes: 0 };
    const runner: Runner = (cmd, args, o) => {
      if (cmd === 'git' && args.includes('push')) state.pushes += 1;
      return run(cmd, args, o);
    };
    const pusher = new AutoPusher(hq, { enabled: () => state.on, runner, ...extra });
    return { state, pusher };
  }

  it('treats a remote that already has HEAD as success: no push, no failure', async () => {
    f = makeFixture();
    const g = gated(f.hq);
    ap = g.pusher;
    await ap.start();
    const events: string[] = [];
    ap.on('push-failed', () => events.push('failed'));
    commit(f.hq, 'b.md');
    // Another clone (a terminal session) pushes the very same commit first.
    const other = f.clone('other');
    sh(other, 'fetch', '-q', f.hq, 'main');
    sh(other, 'push', '-q', 'origin', 'FETCH_HEAD:refs/heads/main');
    const before = sh(f.bare, 'rev-parse', 'main');
    g.state.on = true;
    const pushed = waitFor(ap, 'pushed');
    await ap.checkNow(true);
    await pushed;
    expect(g.state.pushes).toBe(0);
    expect(events).toEqual([]);
    expect(ap.failing).toBe(false);
    expect(sh(f.bare, 'rev-parse', 'main')).toBe(before);
  });

  it('rebases and pushes once when another clone pushed a different commit', async () => {
    f = makeFixture();
    const g = gated(f.hq, { failureThreshold: 1 });
    ap = g.pusher;
    await ap.start();
    const events: string[] = [];
    ap.on('push-failed', () => events.push('failed'));
    commit(f.hq, 'mine.md');
    const other = f.clone('other');
    commit(other, 'theirs.md');
    sh(other, 'push', '-q', 'origin', 'main');
    g.state.on = true;
    const pushed = waitFor(ap, 'pushed');
    await ap.checkNow(true);
    await pushed;
    expect(events).toEqual([]);
    expect(ap.failing).toBe(false);
    const files = sh(f.bare, 'ls-tree', '--name-only', 'main').trim().split('\n');
    expect(files).toEqual(expect.arrayContaining(['a.md', 'mine.md', 'theirs.md']));
    expect(sh(f.hq, 'status', '--porcelain').trim()).toBe('');
  });

  it('does not report a conflict when local edits block the rebase; it retries instead', async () => {
    f = makeFixture();
    const g = gated(f.hq, { failureThreshold: 3 });
    ap = g.pusher;
    await ap.start();
    const events: { conflict?: boolean }[] = [];
    ap.on('push-failed', (e) => events.push(e as { conflict?: boolean }));
    commit(f.hq, 'mine.md');
    const other = f.clone('other');
    commit(other, 'theirs.md');
    sh(other, 'push', '-q', 'origin', 'main');
    fs.writeFileSync(path.join(f.hq, 'a.md'), 'edit in progress\n');
    g.state.on = true;
    await ap.checkNow(true);
    expect(events).toEqual([]);
    expect(ap.failing).toBe(false);
    expect(fs.readFileSync(path.join(f.hq, 'a.md'), 'utf8')).toBe('edit in progress\n');
  });

  it('aborts the rebase and reports a conflict when the same file differs', async () => {
    f = makeFixture();
    const g = gated(f.hq, { failureThreshold: 3 });
    ap = g.pusher;
    await ap.start();
    fs.writeFileSync(path.join(f.hq, 'a.md'), 'mine\n');
    sh(f.hq, 'commit', '-q', '-am', 'mine');
    const other = f.clone('other');
    fs.writeFileSync(path.join(other, 'a.md'), 'theirs\n');
    sh(other, 'commit', '-q', '-am', 'theirs');
    sh(other, 'push', '-q', 'origin', 'main');
    g.state.on = true;
    const failed = waitFor(ap, 'push-failed');
    await ap.checkNow(true);
    const ev = (await failed) as { conflict?: boolean };
    expect(ev.conflict).toBe(true);
    expect(ap.failing).toBe(true);
    expect(fs.existsSync(path.join(f.hq, '.git', 'rebase-merge'))).toBe(false);
    expect(sh(f.hq, 'status', '--porcelain').trim()).toBe('');
  });

  it('leaves a rebase started by someone else untouched and counts no failure', async () => {
    f = makeFixture();
    const g = gated(f.hq, { failureThreshold: 1 });
    ap = g.pusher;
    await ap.start();
    fs.writeFileSync(path.join(f.hq, 'a.md'), 'mine\n');
    sh(f.hq, 'commit', '-q', '-am', 'mine');
    const other = f.clone('other');
    fs.writeFileSync(path.join(other, 'a.md'), 'theirs\n');
    sh(other, 'commit', '-q', '-am', 'theirs');
    sh(other, 'push', '-q', 'origin', 'main');
    sh(f.hq, 'fetch', '-q');
    const hq = f.hq;
    expect(() => sh(hq, 'rebase', 'origin/main')).toThrow();
    const dir = path.join(f.hq, '.git', 'rebase-merge');
    expect(fs.existsSync(dir)).toBe(true);
    const events: unknown[] = [];
    ap.on('push-failed', (e) => events.push(e));
    g.state.on = true;
    await ap.checkNow(true);
    expect(fs.existsSync(dir)).toBe(true);
    expect(events).toEqual([]);
    expect(ap.failing).toBe(false);
  });

  it('does not report a conflict when the pull fails for another reason', async () => {
    f = makeFixture();
    const real = run;
    const runner: Runner = (cmd, args, o) =>
      args.includes('pull') ? Promise.resolve({ code: 1, stdout: '', stderr: 'fatal: unable to access remote: Could not resolve host', error: null } as never) : real(cmd, args, o);
    ap = new AutoPusher(f.hq, { enabled: () => true, runner, failureThreshold: 3 });
    await ap.start();
    commit(f.hq, 'mine.md');
    const other = f.clone('other');
    commit(other, 'theirs.md');
    sh(other, 'push', '-q', 'origin', 'main');
    const events: { conflict?: boolean }[] = [];
    ap.on('push-failed', (e) => events.push(e as { conflict?: boolean }));
    await ap.checkNow(true);
    expect(events).toEqual([]);
    expect(ap.failing).toBe(false);
    expect(sh(f.hq, 'status', '--porcelain').trim()).toBe('');
  });

  it('aborts a rebase left behind by a non-conflict pull failure and counts the failure', async () => {
    f = makeFixture();
    const real = run;
    const runner: Runner = async (cmd, args, o) => {
      const r = await real(cmd, args, o);
      if (!args.includes('pull')) return r;
      return { ...r, stdout: '', stderr: 'error: cannot rewrite branches: the index is locked' } as never;
    };
    ap = new AutoPusher(f.hq, { enabled: () => true, runner, failureThreshold: 1, retryDelaysMs: [60000] });
    await ap.start();
    fs.writeFileSync(path.join(f.hq, 'a.md'), 'mine\n');
    sh(f.hq, 'commit', '-q', '-am', 'mine');
    const other = f.clone('other');
    fs.writeFileSync(path.join(other, 'a.md'), 'theirs\n');
    sh(other, 'commit', '-q', '-am', 'theirs');
    sh(other, 'push', '-q', 'origin', 'main');
    const events: { conflict?: boolean; error?: string }[] = [];
    ap.on('push-failed', (e) => events.push(e as { conflict?: boolean; error?: string }));
    await ap.checkNow(true);
    expect(fs.existsSync(path.join(f.hq, '.git', 'rebase-merge'))).toBe(false);
    expect(events.length).toBe(1);
    expect(events[0].conflict).toBeFalsy();
    expect(events[0].error).toContain('index is locked');
    expect(ap.failing).toBe(true);
    // The next attempt runs again (not skipped): a second failure is reported.
    await ap.retryNow();
    expect(events.length).toBe(2);
    expect(fs.existsSync(path.join(f.hq, '.git', 'rebase-merge'))).toBe(false);
  });

  it('skips without pulling or aborting when the user starts a rebase right before the pull', async () => {
    f = makeFixture();
    const real = run;
    const calls: string[][] = [];
    const hq = f.hq;
    const runner: Runner = async (cmd, args, o) => {
      calls.push(args);
      const r = await real(cmd, args, o);
      // The user's rebase appears after the first check and the first push, before the pull.
      if (args.includes('push')) fs.mkdirSync(path.join(hq, '.git', 'rebase-merge'), { recursive: true });
      return r;
    };
    ap = new AutoPusher(f.hq, { enabled: () => true, runner, failureThreshold: 1, retryDelaysMs: [60000] });
    await ap.start();
    fs.writeFileSync(path.join(f.hq, 'a.md'), 'mine\n');
    sh(f.hq, 'commit', '-q', '-am', 'mine');
    const other = f.clone('other');
    fs.writeFileSync(path.join(other, 'a.md'), 'theirs\n');
    sh(other, 'commit', '-q', '-am', 'theirs');
    sh(other, 'push', '-q', 'origin', 'main');
    const events: unknown[] = [];
    ap.on('push-failed', (e) => events.push(e));
    await ap.checkNow(true);
    expect(calls.some((a) => a.includes('push'))).toBe(true);
    expect(calls.some((a) => a.includes('pull'))).toBe(false);
    expect(calls.some((a) => a.includes('rebase') && a.includes('--abort'))).toBe(false);
    expect(fs.existsSync(path.join(f.hq, '.git', 'rebase-merge'))).toBe(true);
    expect(events).toEqual([]);
    expect(ap.failing).toBe(false);
  });

  it('classifies conflict output', () => {
    expect(isRebaseConflict('CONFLICT (content): Merge conflict in a.md')).toBe(true);
    expect(isRebaseConflict('error: could not apply abc123')).toBe(true);
    expect(isRebaseConflict('fatal: unable to access remote')).toBe(false);
    expect(isRebaseConflict('cannot pull with rebase: You have unstaged changes.')).toBe(false);
  });

  it('reports a failure only after the threshold of consecutive attempts, then success clears it', async () => {
    f = makeFixture();
    sh(f.hq, 'remote', 'set-url', 'origin', `${f.root}/missing.git`);
    let pushes = 0;
    const runner: Runner = (cmd, args, o) => {
      if (cmd === 'git' && args.includes('push')) pushes += 1;
      return run(cmd, args, o);
    };
    ap = new AutoPusher(f.hq, { enabled: () => true, runner, retryDelaysMs: [100], failureThreshold: 3 });
    await ap.start();
    const failures: Array<{ error: string }> = [];
    ap.on('push-failed', (e) => failures.push(e));
    const firstReport = waitFor(ap, 'push-failed');
    commit(f.hq, 'b.md');
    await firstReport;
    expect(pushes).toBe(3);
    // First attempt plus two retries have run: only now is it reported.
    expect(failures).toHaveLength(1);
    expect(ap.failing).toBe(true);
    expect(ap.lastError).toBeTruthy();
    expect(ap.lastError).not.toContain(f.root);
    sh(f.hq, 'remote', 'set-url', 'origin', f.bare);
    await waitFor(ap, 'pushed');
    expect(ap.failing).toBe(false);
    expect(ap.lastError).toBeNull();
  });

  it('does not report before the threshold is reached', async () => {
    f = makeFixture();
    sh(f.hq, 'remote', 'set-url', 'origin', `${f.root}/missing.git`);
    let pushes = 0;
    const runner: Runner = (cmd, args, o) => {
      if (cmd === 'git' && args.includes('push')) pushes += 1;
      return run(cmd, args, o);
    };
    ap = new AutoPusher(f.hq, { enabled: () => true, runner, retryDelaysMs: [60000], failureThreshold: 3 });
    await ap.start();
    let failed = false;
    ap.on('push-failed', () => (failed = true));
    commit(f.hq, 'b.md');
    await poll(() => pushes >= 1, WAIT_MS); // the first attempt ran and failed (below the threshold)
    await poll(() => !checking(ap), WAIT_MS);
    expect(failed).toBe(false);
    expect(ap.failing).toBe(false);
  });

  it('retryNow pushes right away and clears a failure', async () => {
    f = makeFixture();
    sh(f.hq, 'remote', 'set-url', 'origin', `${f.root}/missing.git`);
    ap = new AutoPusher(f.hq, { enabled: () => true, retryDelaysMs: [60000], failureThreshold: 1 });
    await ap.start();
    const failed = waitFor(ap, 'push-failed');
    commit(f.hq, 'b.md');
    await failed;
    sh(f.hq, 'remote', 'set-url', 'origin', f.bare);
    await ap.retryNow();
    expect(ap.failing).toBe(false);
    expect(sh(f.bare, 'log', '--oneline', 'main').trim().split('\n')).toHaveLength(2);
  });
});

describe('push error helpers', () => {
  it('recognises non-fast-forward text', () => {
    expect(isNonFastForward(' ! [rejected] main -> main (fetch first)')).toBe(true);
    expect(isNonFastForward('Updates were rejected because the tip is behind (non-fast-forward)')).toBe(true);
    expect(isNonFastForward('fatal: could not read from remote')).toBe(false);
  });
  it('shortens an error to one line without credentials or urls', () => {
    const raw = "fatal: unable to access 'https://user:secret@example.com/x.git/': Could not resolve host\nhint: retry";
    const s = shortError(raw);
    expect(s).not.toContain('secret');
    expect(s).not.toContain('https://');
    expect(s).not.toContain('\n');
    expect(shortError('')).toBe('push failed');
    expect(shortError('x'.repeat(500)).length).toBeLessThanOrEqual(140);
  });
});
