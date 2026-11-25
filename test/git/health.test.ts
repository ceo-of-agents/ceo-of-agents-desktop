import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkHealth, computeHealth, pullOnOpen, sync, type HealthInput } from '../../src/main/git/health';
import { cleanup, commit, makeFixture, sh, tmp, type Fixture } from './helpers';

// The real-git tests below run many git processes; give them room on a busy machine.
vi.setConfig({ testTimeout: 30_000 });

const base: HealthInput = {
  isRepo: true,
  hasRemote: true,
  fetchOk: null,
  ahead: 0,
  behind: 0,
  conflict: false,
  plugin: 'ok',
  pluginMinimum: '1.2.0',
  autoPushFailing: false,
  lastSyncAt: null,
  syncing: false,
};

describe('computeHealth', () => {
  const cases: Array<[string, Partial<HealthInput>, string]> = [
    ['not a repo', { isRepo: false }, 'red'],
    ['plugin missing', { plugin: 'missing' }, 'red'],
    ['plugin old', { plugin: 'old' }, 'red'],
    ['plugin unknown stays green', { plugin: 'unknown' }, 'green'],
    ['conflict', { conflict: true }, 'red'],
    ['diverged', { ahead: 1, behind: 1 }, 'red'],
    ['unreachable', { fetchOk: false }, 'red'],
    ['no remote', { hasRemote: false }, 'orange'],
    ['ahead', { ahead: 2 }, 'yellow'],
    ['behind', { behind: 1 }, 'yellow'],
    ['push failing', { autoPushFailing: true }, 'yellow'],
    ['push failing while ahead', { autoPushFailing: true, ahead: 1 }, 'yellow'],
    ['ok', { fetchOk: true }, 'green'],
    ['red beats orange', { hasRemote: false, plugin: 'missing' }, 'red'],
    ['orange beats yellow', { hasRemote: false, autoPushFailing: true }, 'orange'],
  ];
  for (const [name, patch, color] of cases) {
    it(name, () => expect(computeHealth({ ...base, ...patch }).color).toBe(color));
  }
  it('puts the push error reason in the sentence and in pushError', () => {
    const h = computeHealth({ ...base, autoPushFailing: true, ahead: 1, pushError: 'Could not resolve host' });
    expect(h.sentence).toContain('Could not resolve host');
    expect(h.pushError).toBe('Could not resolve host');
    expect(computeHealth({ ...base, pushError: 'stale' }).pushError).toBeNull();
  });
  it('has no time in the sentence: the last sync time lives in the list only', () => {
    const d = new Date(2026, 0, 2, 9, 5);
    expect(computeHealth({ ...base, lastSyncAt: d.toISOString() }).sentence).toBe('hq OK: connected to GitHub.');
    expect(computeHealth({ ...base, lastSyncAt: null }).sentence).toBe('hq OK: connected to GitHub.');
    expect(computeHealth({ ...base, lastSyncAt: d.toISOString() }).lastSyncAt).toBe(d.toISOString());
  });
  it('uses singular and plural sentences', () => {
    expect(computeHealth({ ...base, ahead: 1 }).sentence).toBe('Needs sync: 1 change here is not on GitHub yet.');
    expect(computeHealth({ ...base, ahead: 3 }).sentence).toBe('Needs sync: 3 changes here are not on GitHub yet.');
    expect(computeHealth({ ...base, behind: 1 }).sentence).toBe('Needs sync: 1 change on GitHub is not here yet.');
    expect(computeHealth({ ...base, behind: 2 }).sentence).toBe('Needs sync: 2 changes on GitHub are not here yet.');
    expect(computeHealth({ ...base, plugin: 'old' }).sentence).toContain('1.2.0');
  });
  it('says syncing while a sync runs, but keeps a problem sentence', () => {
    expect(computeHealth({ ...base, ahead: 2, syncing: true }).sentence).toBe('Syncing: sending and getting changes from GitHub.');
    expect(computeHealth({ ...base, syncing: true }).sentence).toBe('Syncing: sending and getting changes from GitHub.');
    expect(computeHealth({ ...base, conflict: true, syncing: true }).sentence).toBe('Problem: this hq and GitHub have different changes to the same files.');
  });
  it('marks a conflict or a divergence (needs hands) and nothing else, each with its own wording', () => {
    expect(computeHealth({ ...base, conflict: true }).conflict).toBe('files');
    expect(computeHealth({ ...base, conflict: true, ahead: 1, behind: 1 }).conflict).toBe('files');
    expect(computeHealth({ ...base, ahead: 1, behind: 1 })).toMatchObject({ conflict: 'diverged', sentence: 'Problem: this hq and GitHub both have new changes.' });
    expect(computeHealth({ ...base, fetchOk: false }).conflict).toBeFalsy();
    expect(computeHealth({ ...base, autoPushFailing: true }).conflict).toBeFalsy();
  });
});

const opts = { plugin: 'ok' as const, pluginMinimum: '1.0.0', autoPushFailing: false, lastSyncAt: null };

describe('checkHealth with real git', () => {
  let f: Fixture | undefined;
  afterEach(() => {
    if (f) cleanup(f);
    f = undefined;
  });

  it('no remote -> orange', async () => {
    f = makeFixture(false);
    expect((await checkHealth(f.hq, { ...opts, fetch: true })).color).toBe('orange');
  });

  it('in sync -> green', async () => {
    f = makeFixture();
    const h = await checkHealth(f.hq, { ...opts, fetch: true });
    expect(h.color).toBe('green');
    expect(h.hasRemote).toBe(true);
  });

  it('local commit -> yellow ahead', async () => {
    f = makeFixture();
    commit(f.hq, 'b.md');
    const h = await checkHealth(f.hq, { ...opts, fetch: true });
    expect(h).toMatchObject({ color: 'yellow', ahead: 1, behind: 0 });
  });

  it('remote commit -> yellow behind after fetch only', async () => {
    f = makeFixture();
    const c2 = f.clone('c2');
    commit(c2, 'x.md');
    sh(c2, 'push', '-q');
    expect((await checkHealth(f.hq, { ...opts, fetch: false })).color).toBe('green');
    expect(await checkHealth(f.hq, { ...opts, fetch: true })).toMatchObject({ color: 'yellow', behind: 1 });
  });

  it('both -> red conflict', async () => {
    f = makeFixture();
    const c2 = f.clone('c2');
    commit(c2, 'x.md');
    sh(c2, 'push', '-q');
    commit(f.hq, 'y.md');
    const h = await checkHealth(f.hq, { ...opts, fetch: true });
    expect(h).toMatchObject({ color: 'red', ahead: 1, behind: 1, conflict: 'diverged' });
  });

  it('remote deleted -> red unreachable', async () => {
    f = makeFixture();
    fs.rmSync(f.bare, { recursive: true, force: true });
    const h = await checkHealth(f.hq, { ...opts, fetch: true });
    expect(h.color).toBe('red');
    expect(h.sentence).toMatch(/cannot be reached/);
  });

  it('not a repo -> red', async () => {
    const d = tmp();
    try {
      expect((await checkHealth(d, { ...opts, fetch: true })).color).toBe('red');
      expect((await checkHealth(path.join(d, 'missing'), { ...opts, fetch: true })).color).toBe('red');
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('plugin missing or old -> red', async () => {
    f = makeFixture();
    expect((await checkHealth(f.hq, { ...opts, plugin: 'missing', fetch: false })).color).toBe('red');
    expect((await checkHealth(f.hq, { ...opts, plugin: 'old', fetch: false })).color).toBe('red');
  });

  it('pullOnOpen fast-forwards', async () => {
    f = makeFixture();
    const c2 = f.clone('c2');
    commit(c2, 'x.md');
    sh(c2, 'push', '-q');
    expect(await pullOnOpen(f.hq)).toEqual({ ok: true, error: null });
    expect(fs.existsSync(path.join(f.hq, 'x.md'))).toBe(true);
  });

  it('pullOnOpen never throws and reports failure', async () => {
    f = makeFixture();
    fs.rmSync(f.bare, { recursive: true, force: true });
    const r = await pullOnOpen(f.hq);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    expect((await pullOnOpen(path.join(f.root, 'nope'))).ok).toBe(true);
  });

  it('sync pulls then pushes', async () => {
    f = makeFixture();
    const c2 = f.clone('c2');
    commit(c2, 'x.md');
    sh(c2, 'push', '-q');
    commit(f.hq, 'y.md');
    // diverged: ff-only pull fails at the pull step
    expect(await sync(f.hq)).toMatchObject({ ok: false, step: 'pull' });
    sh(f.hq, 'reset', '-q', '--hard', 'HEAD~1');
    expect(await sync(f.hq)).toEqual({ ok: true, error: null, step: null });
    commit(f.hq, 'z.md');
    sh(c2, 'pull', '-q');
    expect(await sync(f.hq)).toEqual({ ok: true, error: null, step: null });
    sh(c2, 'pull', '-q');
    expect(fs.existsSync(path.join(c2, 'z.md'))).toBe(true);
  });

  it('sync fast-forwards then pushes in one go', async () => {
    f = makeFixture();
    const c2 = f.clone('c2');
    commit(c2, 'x.md');
    sh(c2, 'push', '-q');
    commit(f.hq, 'y.md');
    sh(f.hq, 'pull', '--rebase', '-q');
    expect((await sync(f.hq)).ok).toBe(true);
    expect((await checkHealth(f.hq, { ...opts, fetch: true })).color).toBe('green');
  });
});
