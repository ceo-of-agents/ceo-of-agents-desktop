import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearLatestCache, devPluginStatus, fetchLatestRelease, installPlugin, pluginStatus, updatePlugin } from '../../src/main/system/plugin';
import { fail, fixture, mockRunner, ok } from './helpers';

let dir: string;
beforeEach(() => {
  clearLatestCache();
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coa-hq-')));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const listRunner = (out: string) => mockRunner((l) => (l.includes('plugin list') ? ok(out) : undefined)).runner;
const writeOrg = (v: string) => fs.writeFileSync(path.join(dir, 'org.yaml'), `framework_version: ${v}\n`);

describe('pluginStatus', () => {
  it('ok with user scope, flags computed', async () => {
    writeOrg('0.12.0');
    const s = await pluginStatus('/c', dir, { runner: listRunner(fixture('plugin-list-user.json')), fetchLatest: async () => '0.15.0' });
    expect(s).toMatchObject({ state: 'ok', installed: '0.14.0', latest: '0.15.0', updateAvailable: true, hqFrameworkVersion: '0.12.0', orgUpdateAvailable: true, belowMinimum: false, minimum: '0.13.0' });
  });
  it('flags a failed latest check (fetch throws or returns null), not a missing fetcher', async () => {
    const runner = listRunner(fixture('plugin-list-user.json'));
    const nul = await pluginStatus('/c', dir, { runner, fetchLatest: async () => null });
    expect(nul).toMatchObject({ latest: null, updateAvailable: false, latestCheckFailed: true, dev: false });
    const thrown = await pluginStatus('/c', dir, {
      runner,
      fetchLatest: async () => {
        throw new Error('offline');
      },
    });
    expect(thrown.latestCheckFailed).toBe(true);
    expect((await pluginStatus('/c', dir, { runner })).latestCheckFailed).toBe(false);
    expect((await pluginStatus('/c', dir, { runner, fetchLatest: async () => '0.14.0' })).latestCheckFailed).toBe(false);
  });
  it('installed behind latest and hq behind installed', async () => {
    writeOrg('0.13.0');
    const s = await pluginStatus('/c', dir, { runner: listRunner(fixture('plugin-list-user.json')), fetchLatest: async () => '0.15.0' });
    expect(s).toMatchObject({ installed: '0.14.0', updateAvailable: true, orgUpdateAvailable: true, latestCheckFailed: false });
  });
  it('all equal', async () => {
    writeOrg('0.14.0');
    const s = await pluginStatus('/c', dir, { runner: listRunner(fixture('plugin-list-user.json')), fetchLatest: async () => '0.14.0' });
    expect(s).toMatchObject({ updateAvailable: false, orgUpdateAvailable: false, latestCheckFailed: false, dev: false });
  });
  it('ok with project scope via realpath (symlink)', async () => {
    const link = path.join(os.tmpdir(), `coa-link-${process.pid}-${Date.now()}`);
    fs.symlinkSync(dir, link);
    try {
      writeOrg('0.13.2');
      const out = fixture('plugin-list-project.json').replace('__PROJECT__', dir);
      const s = await pluginStatus('/c', link, { runner: listRunner(out) });
      expect(s).toMatchObject({ state: 'ok', installed: '0.13.2', latest: null, updateAvailable: false, orgUpdateAvailable: false });
    } finally {
      fs.rmSync(link);
    }
  });
  it('project entry for another folder is not installed here', async () => {
    const out = fixture('plugin-list-project.json').replace('__PROJECT__', '/somewhere/else');
    expect((await pluginStatus('/c', dir, { runner: listRunner(out) })).state).toBe('missing');
  });
  it('below minimum', async () => {
    const out = fixture('plugin-list-user.json').replace('0.14.0', '0.12.9');
    expect((await pluginStatus('/c', dir, { runner: listRunner(out) })).belowMinimum).toBe(true);
  });
  it('enabled-not-installed', async () => {
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'ceo-of-agents@ceo-of-agents': true } }));
    expect((await pluginStatus('/c', dir, { runner: listRunner('[]') })).state).toBe('enabled-not-installed');
  });
  it('missing', async () => {
    expect((await pluginStatus('/c', dir, { runner: listRunner(fixture('plugin-list-empty.json')) })).state).toBe('missing');
  });
  it('unknown on failure or garbage', async () => {
    expect((await pluginStatus('/c', dir, { runner: mockRunner(() => fail('x')).runner })).state).toBe('unknown');
    expect((await pluginStatus('/c', dir, { runner: listRunner('garbage') })).state).toBe('unknown');
  });
  it('runs plugin list in the folder', async () => {
    const { runner, calls } = mockRunner(() => ok('[]'));
    await pluginStatus('/c', dir, { runner });
    expect(calls[0].cwd).toBe(dir);
  });
});

describe('devPluginStatus', () => {
  it('reports the dev folder version, no update, dev flag', async () => {
    writeOrg('0.12.0');
    fs.mkdirSync(path.join(dir, '.claude-plugin'));
    fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '0.20.0' }));
    const base = await pluginStatus('/c', dir, { runner: listRunner(fixture('plugin-list-user.json')), fetchLatest: async () => '0.99.0' });
    const s = devPluginStatus(base, dir);
    expect(s).toMatchObject({ state: 'ok', installed: '0.20.0', updateAvailable: false, orgUpdateAvailable: true, dev: true });
  });
});

describe('fetchLatestRelease', () => {
  it('strips v and sends headers', async () => {
    let init: RequestInit | undefined;
    const f = (async (_u: unknown, i?: RequestInit) => {
      init = i;
      return new Response(JSON.stringify({ tag_name: 'v0.15.1' }));
    }) as typeof fetch;
    expect(await fetchLatestRelease(f)).toBe('0.15.1');
    expect(init?.headers).toMatchObject({ Accept: 'application/vnd.github+json', 'User-Agent': 'ceo-of-agents-app' });
  });
  it('null on 404 and network error', async () => {
    expect(await fetchLatestRelease((async () => new Response('{}', { status: 404 })) as typeof fetch)).toBeNull();
    expect(
      await fetchLatestRelease((async () => {
        throw new Error('offline');
      }) as typeof fetch),
    ).toBeNull();
  });
  it('caches', async () => {
    let n = 0;
    const f = (async () => {
      n++;
      return new Response(JSON.stringify({ tag_name: '1.0.0' }));
    }) as typeof fetch;
    await fetchLatestRelease(f);
    await fetchLatestRelease(f);
    expect(n).toBe(1);
    clearLatestCache();
    await fetchLatestRelease(f);
    expect(n).toBe(2);
  });
});

describe('installPlugin / updatePlugin', () => {
  it('install adds the marketplace only when missing', async () => {
    const a = mockRunner((l) => (l.includes('marketplace list') ? ok('[]') : ok()));
    expect(await installPlugin('/c', dir, a.runner)).toEqual({ ok: true, error: null });
    expect(a.calls.map((c) => c.args.join(' '))).toEqual([
      'plugin marketplace list --json',
      'plugin marketplace add ceo-of-agents/ceo-of-agents-core',
      'plugin install ceo-of-agents@ceo-of-agents --scope project',
    ]);
    expect(a.calls.every((c) => c.cwd === dir)).toBe(true);
    const b = mockRunner((l) => (l.includes('marketplace list') ? ok(fixture('marketplace-list.json')) : ok()));
    await installPlugin('/c', dir, b.runner);
    expect(b.calls.some((c) => c.args.includes('add'))).toBe(false);
  });
  it('install failure carries stderr tail', async () => {
    const { runner } = mockRunner((l) => (l.includes('marketplace list') ? ok('[]') : l.includes('install') ? fail('l1\nl2\nboom') : ok()));
    const r = await installPlugin('/c', dir, runner);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('boom');
  });
  it('update never passes -y and refreshes the marketplace first', async () => {
    const m = mockRunner(() => ok());
    expect(await updatePlugin('/c', dir, m.runner)).toEqual({ ok: true, error: null });
    expect(m.calls.map((c) => c.args.join(' '))).toEqual([
      'plugin marketplace update ceo-of-agents',
      'plugin update ceo-of-agents@ceo-of-agents --scope project',
    ]);
    for (const c of m.calls) {
      expect(c.args).not.toContain('-y');
      expect(c.args).not.toContain('--yes');
    }
  });
  it('update asking for confirmation says to use Terminal', async () => {
    const { runner } = mockRunner((l) => (l.includes('plugin update') ? fail('Confirmation required: pass -y when not interactive') : ok()));
    const r = await updatePlugin('/c', dir, runner);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Terminal/);
  });
});
