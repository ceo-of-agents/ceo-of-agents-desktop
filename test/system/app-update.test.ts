import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppUpdater, INSTALL_SCRIPT, assetName, classifyRelease, fetchLatestApp, helperArgs, isNewer, parseRelease, resolveBundle, stageUpdate, type BundleFs, type StageFs } from '../../src/main/system/app-update';
import type { Runner } from '../../src/main/system/exec';
import type { AppUpdateStatus } from '../../src/shared/types';
import { fail, mockRunner, ok } from './helpers';

const release = (tag: string, names: string[]) => JSON.stringify({ tagName: tag, assets: names.map((name) => ({ name })) });

describe('parseRelease', () => {
  it('reads the tag with or without a leading v', () => {
    expect(parseRelease(release('v1.2.3', [assetName('1.2.3')]))).toEqual({ version: '1.2.3', tag: 'v1.2.3' });
    expect(parseRelease(release('1.2.3', [assetName('1.2.3')]))).toEqual({ version: '1.2.3', tag: '1.2.3' });
  });
  it('needs the exact .dmg asset', () => {
    expect(parseRelease(release('v1.2.3', []))).toBeNull();
    expect(parseRelease(release('v1.2.3', [assetName('1.2.2'), 'CEO-of-Agents-1.2.3.zip']))).toBeNull();
  });
  it('rejects bad JSON and odd tags', () => {
    expect(parseRelease('not json')).toBeNull();
    expect(parseRelease('null')).toBeNull();
    expect(parseRelease(JSON.stringify({ tagName: 'nightly', assets: [] }))).toBeNull();
    expect(parseRelease(JSON.stringify({ tagName: 'v1.2.3' }))).toBeNull();
  });
});

describe('fetchLatestApp', () => {
  it('runs gh release view with the repo and a timeout', async () => {
    const calls: Array<{ line: string; timeout?: number }> = [];
    const runner: Runner = async (cmd, args, o) => {
      calls.push({ line: [cmd, ...args].join(' '), timeout: o?.timeoutMs });
      return ok(release('v0.5.0', [assetName('0.5.0')]));
    };
    expect(await fetchLatestApp(runner, 'o/r')).toEqual({ version: '0.5.0', tag: 'v0.5.0' });
    expect(calls[0]).toEqual({ line: 'gh release view --repo o/r --json tagName,assets', timeout: 10000 });
  });
  it('is null when gh is missing, fails or the runner throws', async () => {
    expect(await fetchLatestApp(async () => ({ code: null, stdout: '', stderr: '', error: 'spawn gh ENOENT' }))).toBeNull();
    expect(await fetchLatestApp(async () => fail('not logged in'))).toBeNull();
    expect(await fetchLatestApp(async () => { throw new Error('x'); })).toBeNull();
  });
});

describe('classifyRelease', () => {
  it('sorts each way gh release view can end', () => {
    expect(classifyRelease(ok(release('v1.2.3', [assetName('1.2.3')])))).toEqual({ kind: 'release', release: { version: '1.2.3', tag: 'v1.2.3' } });
    expect(classifyRelease(ok(release('v1.2.3', [])))).toEqual({ kind: 'noRelease' });
    expect(classifyRelease(ok('garbage'))).toEqual({ kind: 'noRelease' });
    expect(classifyRelease({ code: null, stdout: '', stderr: '', error: 'spawn gh ENOENT' })).toEqual({ kind: 'ghMissing' });
    expect(classifyRelease(fail('To get started with GitHub CLI, please run:  gh auth login'))).toEqual({ kind: 'notSignedIn' });
    expect(classifyRelease(fail('HTTP 401: Bad credentials'))).toEqual({ kind: 'notSignedIn' });
    expect(classifyRelease(fail('dial tcp: lookup api.github.com: no such host'))).toEqual({ kind: 'failed' });
    expect(classifyRelease({ code: null, stdout: '', stderr: '', error: 'timeout' })).toEqual({ kind: 'failed' });
  });
});

describe('isNewer', () => {
  it('compares versions', () => {
    expect(isNewer('0.2.0', '0.1.9')).toBe(true);
    expect(isNewer('0.2.0', '0.2.0')).toBe(false);
    expect(isNewer('0.1.0', '0.2.0')).toBe(false);
    expect(isNewer(null, '0.2.0')).toBe(false);
  });
});

const bfs = (o: { real?: string; writable?: boolean } = {}): BundleFs => ({
  realpath: (p) => {
    if (o.real === 'throw') throw new Error('x');
    return o.real ?? p;
  },
  accessWritable: () => {
    if (o.writable === false) throw new Error('EACCES');
  },
});

describe('resolveBundle', () => {
  const exec = '/Applications/CEO of Agents.app/Contents/MacOS/CEO of Agents';
  it('finds the nearest .app ancestor', () => {
    expect(resolveBundle(exec, bfs())).toEqual({ ok: true, app: '/Applications/CEO of Agents.app' });
    expect(resolveBundle('/x/Outer.app/Contents/Frameworks/Inner.app/Contents/MacOS/h', bfs())).toMatchObject({ app: '/x/Outer.app/Contents/Frameworks/Inner.app' });
  });
  it('follows a link to the real bundle', () => {
    expect(resolveBundle(exec, bfs({ real: '/Volumes/Data/CEO.app' }))).toEqual({ ok: true, app: '/Volumes/Data/CEO.app' });
  });
  it('refuses without a bundle, a missing path, translocation or a read-only folder', () => {
    expect(resolveBundle('/usr/local/bin/node', bfs())).toEqual({ ok: false, error: 'notFound' });
    expect(resolveBundle(exec, bfs({ real: 'throw' }))).toEqual({ ok: false, error: 'notFound' });
    expect(resolveBundle('/private/var/folders/x/AppTranslocation/ID/d/CEO.app/Contents/MacOS/h', bfs())).toEqual({ ok: false, error: 'translocated' });
    expect(resolveBundle(exec, bfs({ writable: false }))).toEqual({ ok: false, error: 'notWritable' });
  });
});

describe('helper', () => {
  it('passes every value as an argument, in order', () => {
    const args = helperArgs('/t/install.sh', 42, { stagedApp: '/t/staged/A.app', targetApp: '/Applications/A B.app', tmpDir: '/t' }, true);
    expect(args).toEqual(['/t/install.sh', '42', '/t/staged/A.app', '/Applications/A B.app', '1', '/t']);
    expect(helperArgs('/s', 1, { stagedApp: 'a', targetApp: 'b', tmpDir: 'c' }, false)[4]).toBe('0');
  });
  it('script holds no path and deletes its folder last', () => {
    expect(INSTALL_SCRIPT).not.toMatch(/\/Applications|\/tmp|\/var/);
    expect(INSTALL_SCRIPT.startsWith('set -u')).toBe(true);
    expect(INSTALL_SCRIPT.trim().split('\n').pop()).toBe('rm -rf "$5"');
  });
});

describe('install script (run for real with shims)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const write = (p: string, body: string, mode?: number) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body, mode ? { mode } : undefined);
  };
  function world(o: { dittoFails?: boolean } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-install-test-'));
    dirs.push(root);
    const shims = path.join(root, 'shims');
    write(path.join(shims, 'ditto'), o.dittoFails ? '#!/bin/sh\nmkdir -p "$2"\necho partial > "$2/partial"\nexit 1\n' : '#!/bin/sh\ncp -R "$1" "$2"\n', 0o755);
    write(path.join(shims, 'sleep'), '#!/bin/sh\nexit 0\n', 0o755);
    const opened = path.join(root, 'opened.txt');
    write(path.join(shims, 'open'), `#!/bin/sh\necho "$1" >> '${opened}'\n`, 0o755);
    const apps = path.join(root, 'apps');
    const target = path.join(apps, 'X.app');
    const staged = path.join(root, 'tmp', 'staged', 'X.app');
    const tmp = path.join(root, 'tmp');
    write(path.join(target, 'v'), 'old');
    write(path.join(staged, 'v'), 'new');
    const run = (pid: number, relaunch: boolean) => {
      const script = path.join(root, 'install.sh');
      // sleep is a no-op function: the wait loop would otherwise fork the shim 120 times (production script unchanged).
      write(script, `sleep() { :; }\n${INSTALL_SCRIPT}`);
      return spawnSync('/bin/sh', helperArgs(script, pid, { stagedApp: staged, targetApp: target, tmpDir: tmp }, relaunch), { env: { ...process.env, PATH: `${shims}:${process.env.PATH ?? ''}` }, encoding: 'utf8' });
    };
    const content = (p: string) => fs.readFileSync(path.join(p, 'v'), 'utf8');
    const openedArgs = () => (fs.existsSync(opened) ? fs.readFileSync(opened, 'utf8').trim().split('\n') : []);
    return { run, target, tmp, content, openedArgs, exists: fs.existsSync };
  }
  const deadPid = () => {
    const r = spawnSync('true');
    return r.pid ?? 999999;
  };

  it('replaces the target, leaves no .new or .old and deletes the temp folder', () => {
    const w = world();
    const r = w.run(deadPid(), false);
    expect(r.status).toBe(0);
    expect(w.content(w.target)).toBe('new');
    expect(w.exists(`${w.target}.new`)).toBe(false);
    expect(w.exists(`${w.target}.old`)).toBe(false);
    expect(w.exists(w.tmp)).toBe(false);
  });
  it('a failing copy keeps the old target intact and leaves no .new or .old', () => {
    const w = world({ dittoFails: true });
    w.run(deadPid(), false);
    expect(w.content(w.target)).toBe('old');
    expect(w.exists(`${w.target}.new`)).toBe(false);
    expect(w.exists(`${w.target}.old`)).toBe(false);
    expect(w.exists(w.tmp)).toBe(false);
  });
  it('restores a previous interrupted run (target missing, .old present) before swapping', () => {
    const w = world({ dittoFails: true });
    fs.renameSync(w.target, `${w.target}.old`);
    w.run(deadPid(), false);
    expect(w.content(w.target)).toBe('old');
    expect(w.exists(`${w.target}.old`)).toBe(false);
    const w2 = world();
    fs.renameSync(w2.target, `${w2.target}.old`);
    fs.mkdirSync(`${w2.target}.new`);
    w2.run(deadPid(), false);
    expect(w2.content(w2.target)).toBe('new');
    expect(w2.exists(`${w2.target}.old`)).toBe(false);
    expect(w2.exists(`${w2.target}.new`)).toBe(false);
  });
  it('opens the target only when relaunch is 1', () => {
    const a = world();
    a.run(deadPid(), true);
    expect(a.openedArgs()).toEqual([a.target]);
    const b = world();
    b.run(deadPid(), false);
    expect(b.openedArgs()).toEqual([]);
  });
  it('gives up when the app is still running: temp folder removed, target untouched, nothing opened', () => {
    const w = world();
    const r = w.run(process.pid, true);
    expect(r.status).toBe(0);
    expect(w.content(w.target)).toBe('old');
    expect(w.exists(w.tmp)).toBe(false);
    expect(w.openedArgs()).toEqual([]);
  });
});

function stageEnv(o: { bundleId?: string; version?: string; apps?: string[]; fail?: string } = {}) {
  const removed: string[] = [];
  const fsx: StageFs = { mkdtemp: (p) => `${p}X`, readdir: () => o.apps ?? ['CEO of Agents.app'], rm: (p) => void removed.push(p) };
  const { runner, calls } = mockRunner((line) => {
    if (o.fail && line.startsWith(o.fail)) return fail('boom');
    if (line.startsWith('plutil')) {
      if (line.includes('CFBundleShortVersionString')) return ok(`${o.version ?? '0.2.0'}\n`);
      return ok(line.includes('/mnt/') ? `${o.bundleId ?? 'x.id'}\n` : 'x.id\n');
    }
    return ok();
  });
  const verbs = () => calls.map((c) => c.cmd + (c.cmd === 'gh' ? ' ' + c.args[1] : c.cmd === 'hdiutil' ? ' ' + c.args[0] : ''));
  return { fsx, runner, calls, removed, verbs };
}

describe('stageUpdate', () => {
  it('happy path: download, attach, check, copy, detach, verify; keeps the folder', async () => {
    const e = stageEnv();
    const r = await stageUpdate({ version: '0.2.0', tag: 'v0.2.0' }, '/Applications/CEO of Agents.app', { runner: e.runner, fsx: e.fsx, tmpRoot: '/tmp' });
    expect(r.ok).toBe(true);
    expect(e.verbs()).toEqual(['gh download', 'hdiutil attach', 'plutil', 'plutil', 'plutil', 'ditto', 'hdiutil detach', 'codesign']);
    expect(e.calls[0].args).toEqual(['release', 'download', 'v0.2.0', '--repo', 'ceo-of-agents/ceo-of-agents-desktop', '--pattern', 'CEO-of-Agents-0.2.0.dmg', '--dir', '/tmp/coa-app-update-X']);
    expect(e.removed).toEqual([]);
    if (r.ok) expect(r.staged).toEqual({ stagedApp: '/tmp/coa-app-update-X/staged/CEO of Agents.app', targetApp: '/Applications/CEO of Agents.app', tmpDir: '/tmp/coa-app-update-X' });
  });
  it('downloads with the exact tag from the check, even without a leading v', async () => {
    const e = stageEnv();
    await stageUpdate({ version: '0.2.0', tag: '0.2.0' }, '/A.app', { runner: e.runner, fsx: e.fsx, tmpRoot: '/tmp' });
    expect(e.calls[0].args.slice(0, 3)).toEqual(['release', 'download', '0.2.0']);
  });
  it('detaches and cleans up when ditto fails', async () => {
    const e = stageEnv({ fail: 'ditto' });
    const r = await stageUpdate({ version: '0.2.0', tag: 'v0.2.0' }, '/A.app', { runner: e.runner, fsx: e.fsx });
    expect(r.ok).toBe(false);
    expect(e.verbs().filter((v) => v === 'hdiutil detach').length).toBeGreaterThanOrEqual(1);
    expect(e.verbs()).not.toContain('codesign');
    expect(e.removed).toHaveLength(1);
  });
  it('a different bundle id is an error, still detached and cleaned', async () => {
    const e = stageEnv({ bundleId: 'other.app' });
    const r = await stageUpdate({ version: '0.2.0', tag: 'v0.2.0' }, '/A.app', { runner: e.runner, fsx: e.fsx });
    expect(r).toMatchObject({ ok: false });
    expect(e.verbs()).toContain('hdiutil detach');
    expect(e.verbs()).not.toContain('ditto');
    expect(e.removed).toHaveLength(1);
  });
  it('a different version is an error', async () => {
    const e = stageEnv({ version: '0.1.0' });
    expect((await stageUpdate({ version: '0.2.0', tag: 'v0.2.0' }, '/A.app', { runner: e.runner, fsx: e.fsx })).ok).toBe(false);
    expect(e.verbs()).toContain('hdiutil detach');
  });
  it('download failure and a signature failure replace nothing', async () => {
    const d = stageEnv({ fail: 'gh' });
    expect((await stageUpdate({ version: '0.2.0', tag: 'v0.2.0' }, '/A.app', { runner: d.runner, fsx: d.fsx })).ok).toBe(false);
    expect(d.verbs()).toEqual(['gh download']);
    expect(d.removed).toHaveLength(1);
    const s = stageEnv({ fail: 'codesign' });
    expect((await stageUpdate({ version: '0.2.0', tag: 'v0.2.0' }, '/A.app', { runner: s.runner, fsx: s.fsx })).ok).toBe(false);
    expect(s.removed).toHaveLength(1);
  });
  it('retries the detach with -force', async () => {
    const e = stageEnv();
    const calls: string[] = [];
    const runner: Runner = async (cmd, args, o) => {
      calls.push([cmd, ...args].join(' '));
      if (cmd === 'hdiutil' && args[0] === 'detach' && args[1] !== '-force') return fail('busy');
      return e.runner(cmd, args, o);
    };
    await stageUpdate({ version: '0.2.0', tag: 'v0.2.0' }, '/A.app', { runner, fsx: e.fsx, tmpRoot: '/t' });
    expect(calls.some((c) => c.startsWith('hdiutil detach -force'))).toBe(true);
  });
});

describe('AppUpdater', () => {
  const make = (o: { packaged?: boolean; latest?: string; version?: string; tag?: string; quit?: () => Promise<boolean>; realTmp?: boolean } = {}) => {
    const events: AppUpdateStatus[] = [];
    const requestQuit = vi.fn(o.quit ?? (async () => true));
    const spawner = vi.fn();
    let now = 1000;
    const { runner, calls } = mockRunner((line) => (line.startsWith('plutil') ? ok(line.includes('CFBundleShortVersionString') ? `${o.latest ?? '0.2.0'}\n` : 'x.id\n') : line.startsWith('gh release view') ? ok(release(o.tag ?? `v${o.latest ?? '0.2.0'}`, [assetName(o.latest ?? '0.2.0')])) : ok()));
    const u = new AppUpdater({
      packaged: o.packaged ?? true,
      version: o.version ?? '0.1.0',
      execPath: '/Applications/X.app/Contents/MacOS/X',
      pid: 7,
      emit: (s) => events.push(s),
      requestQuit,
      runner,
      spawner,
      now: () => now,
      bundleFs: bfs(),
      stageFs: { mkdtemp: (p) => (o.realTmp ? fs.mkdtempSync(p) : `${p}X`), readdir: () => ['X.app'], rm: () => undefined },
      tmpRoot: o.realTmp ? os.tmpdir() : '/nonexistent-tmp',
    });
    return { u, events, requestQuit, spawner, calls, tick: (ms: number) => (now += ms) };
  };
  it('dev builds never check or update', async () => {
    const m = make({ packaged: false });
    expect((await m.u.check()).state).toBe('dev');
    await m.u.update();
    expect(m.calls).toHaveLength(0);
    expect(m.requestQuit).not.toHaveBeenCalled();
  });
  it('offers a newer release, caches for an hour, force bypasses', async () => {
    const m = make();
    expect(await m.u.check()).toMatchObject({ state: 'available', latest: '0.2.0' });
    await m.u.check();
    expect(m.calls).toHaveLength(1);
    await m.u.check(true);
    expect(m.calls).toHaveLength(2);
    m.tick(3_600_001);
    await m.u.check();
    expect(m.calls).toHaveLength(3);
  });
  describe('checkNow', () => {
    it('says up to date or available, and always asks GitHub (skips the cache)', async () => {
      const a = make({ latest: '0.1.0' });
      expect(await a.u.checkNow()).toEqual({ kind: 'upToDate', current: '0.1.0' });
      expect(await a.u.checkNow()).toEqual({ kind: 'upToDate', current: '0.1.0' });
      expect(a.calls).toHaveLength(2);
      const b = make();
      await b.u.check();
      expect(await b.u.checkNow()).toEqual({ kind: 'available', current: '0.1.0', latest: '0.2.0' });
      expect(b.calls).toHaveLength(2);
      expect(b.u.status().state).toBe('available');
      expect(b.events.at(-1)?.state).toBe('available');
    });
    it('reports why a check failed', async () => {
      const mk = (r: ReturnType<typeof fail>) => {
        const events: AppUpdateStatus[] = [];
        const u = new AppUpdater({ packaged: true, version: '0.1.0', execPath: '/A.app/x', pid: 1, emit: (s) => events.push(s), requestQuit: async () => true, runner: async () => r });
        return u;
      };
      expect(await mk({ code: null, stdout: '', stderr: '', error: 'spawn gh ENOENT' }).checkNow()).toEqual({ kind: 'failed', reason: expect.stringContaining('was not found') });
      expect(await mk(fail('run gh auth login')).checkNow()).toEqual({ kind: 'failed', reason: expect.stringContaining('not signed in') });
      expect(await mk(fail('boom')).checkNow()).toEqual({ kind: 'failed', reason: expect.stringContaining('Could not reach GitHub') });
      expect(await mk(ok('null')).checkNow()).toEqual({ kind: 'failed', reason: expect.stringContaining('No release') });
    });
    it('does nothing in a dev build and says busy while an update is staged', async () => {
      const d = make({ packaged: false });
      expect(await d.u.checkNow()).toEqual({ kind: 'dev' });
      expect(d.calls).toHaveLength(0);
      const m = make({ realTmp: true, quit: async () => false });
      await m.u.check();
      await m.u.update();
      const tmpDir = m.calls.find((c) => c.cmd === 'gh' && c.args[1] === 'download')?.args.at(-1) as string;
      expect(m.u.status().state).toBe('ready');
      const before = m.calls.length;
      expect(await m.u.checkNow()).toEqual({ kind: 'busy' });
      expect(m.calls).toHaveLength(before);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });
  it('stays idle on the same or an older release', async () => {
    expect((await make({ latest: '0.1.0' }).u.check()).state).toBe('idle');
  });
  it('an install target that cannot be replaced is an error and downloads nothing', async () => {
    const m = make();
    await m.u.check();
    (m.u as unknown as { d: { execPath: string } }).d.execPath = '/usr/bin/node';
    await m.u.update();
    expect(m.u.status().state).toBe('error');
    expect(m.calls.filter((c) => c.cmd === 'gh')).toHaveLength(1);
    expect(m.requestQuit).not.toHaveBeenCalled();
  });
  it('downloads the exact tag the check saw (no leading v)', async () => {
    const m = make({ tag: '0.2.0' });
    await m.u.check();
    await m.u.update();
    expect(m.calls.find((c) => c.cmd === 'gh' && c.args[1] === 'download')?.args[2]).toBe('0.2.0');
  });
  describe('relaunch follows the quit', () => {
    const tmps: string[] = [];
    afterEach(() => {
      for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    });
    const lastArgs = (spawner: ReturnType<typeof vi.fn>) => spawner.mock.calls.at(-1)?.[1] as string[] | undefined;
    it('a button quit that did not go through installs later without relaunch', async () => {
      const m = make({ realTmp: true, quit: async () => false });
      await m.u.check();
      await m.u.update();
      const tmpDir = (m.calls.find((c) => c.cmd === 'gh' && c.args[1] === 'download')?.args.at(-1)) as string;
      tmps.push(tmpDir);
      expect(m.u.status().state).toBe('ready');
      m.u.installAtExit(false);
      expect(m.spawner).toHaveBeenCalledTimes(1);
      expect(lastArgs(m.spawner)?.[4]).toBe('0');
    });
    it('a button quit that goes through (installAtExit runs inside it) relaunches', async () => {
      const m: ReturnType<typeof make> = make({ realTmp: true, quit: async () => { m.u.installAtExit(false); return true; } });
      await m.u.check();
      await m.u.update();
      tmps.push((m.calls.find((c) => c.cmd === 'gh' && c.args[1] === 'download')?.args.at(-1)) as string);
      expect(m.spawner).toHaveBeenCalledTimes(1);
      expect(lastArgs(m.spawner)?.[4]).toBe('1');
    });
  });
});
