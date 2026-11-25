import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findHqs, scanUsualPlaces, usualPlaces } from '../../src/main/hq/discover';
import { isHq, loadHq, orgIdFor } from '../../src/main/hq/read';
import { OrgRegistry } from '../../src/main/hq/registry';
import { watchHq } from '../../src/main/hq/watch';

const FX = path.join(__dirname, '..', 'fixtures', 'hq');
let tmp: string;

function mkHq(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'org.yaml'), 'org:\n  id: T\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# t\n');
  return dir;
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coa-hq-')));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('read', () => {
  it('isHq needs both files', () => {
    const d = path.join(tmp, 'a');
    fs.mkdirSync(d);
    expect(isHq(d)).toBe(false);
    fs.writeFileSync(path.join(d, 'org.yaml'), '');
    expect(isHq(d)).toBe(false);
    fs.writeFileSync(path.join(d, 'CLAUDE.md'), '');
    expect(isHq(d)).toBe(true);
  });

  it('loadHq reads everything and sorts initiatives by updated desc', () => {
    const d = mkHq(path.join(tmp, 'hq'));
    fs.copyFileSync(path.join(FX, 'org.yaml'), path.join(d, 'org.yaml'));
    fs.copyFileSync(path.join(FX, 'CLAUDE.md'), path.join(d, 'CLAUDE.md'));
    fs.mkdirSync(path.join(d, 'company'));
    fs.copyFileSync(path.join(FX, 'state', 'state-sample-2.md'), path.join(d, 'company', 'state.md'));
    const ini = (slug: string, f: string) => {
      fs.mkdirSync(path.join(d, 'initiatives', slug), { recursive: true });
      fs.copyFileSync(path.join(FX, 'initiatives', f), path.join(d, 'initiatives', slug, 'status.md'));
    };
    ini('older', 'status-synthetic-paused.md');
    ini('newer', 'status-sample-1.md');
    fs.mkdirSync(path.join(d, 'initiatives', 'no-status'));
    fs.writeFileSync(path.join(d, 'initiatives', 'README.md'), 'index');
    const hq = loadHq(d);
    expect(hq.org.name).toBe('Acme');
    expect(hq.departments.map((x) => x.role)).toEqual(['Engineering', 'Design and brand']);
    expect(hq.waiting).toHaveLength(3);
    expect(hq.initiatives.map((i) => i.slug)).toEqual(['newer', 'older']);
  });

  it('loadHq tolerates missing files', () => {
    const d = path.join(tmp, 'empty');
    fs.mkdirSync(d);
    const hq = loadHq(d);
    expect(hq.waiting).toEqual([]);
    expect(hq.initiatives).toEqual([]);
    expect(hq.departments).toEqual([]);
    expect(hq.org.cosName).toBe('Chief of Staff');
  });

  it('loadHq appends the T items of company/todo.md after the A and D items, and is unchanged without the file', () => {
    const d = mkHq(path.join(tmp, 'hq-todo'));
    fs.mkdirSync(path.join(d, 'company'));
    fs.copyFileSync(path.join(FX, 'state', 'state-sample-2.md'), path.join(d, 'company', 'state.md'));
    const without = loadHq(d).waiting;
    expect(without).toHaveLength(3);
    fs.copyFileSync(path.join(FX, 'todo', 'todo-sample.md'), path.join(d, 'company', 'todo.md'));
    const withTodo = loadHq(d).waiting;
    expect(withTodo.slice(0, 3)).toEqual(without);
    expect(withTodo.slice(3).map((w) => ('unparsed' in w ? w.unparsed : w.code))).toEqual(['ACME-T3', 'ACME-T4']);
    expect(withTodo.slice(3).every((w) => !('unparsed' in w) && w.kind === 'T')).toBe(true);
  });

  it('loadHq reads company/todo.md alone, and an unreadable todo.md adds nothing', () => {
    const d = mkHq(path.join(tmp, 'hq-todo-only'));
    fs.mkdirSync(path.join(d, 'company'));
    fs.mkdirSync(path.join(d, 'company', 'todo.md'));
    expect(loadHq(d).waiting).toEqual([]);
    fs.rmdirSync(path.join(d, 'company', 'todo.md'));
    fs.copyFileSync(path.join(FX, 'todo', 'todo-sample.md'), path.join(d, 'company', 'todo.md'));
    expect(loadHq(d).waiting).toHaveLength(2);
  });

  it('orgIdFor is 12 hex chars, stable, follows symlinks', () => {
    const d = mkHq(path.join(tmp, 'hq'));
    const link = path.join(tmp, 'link');
    fs.symlinkSync(d, link);
    const id = orgIdFor(d);
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(orgIdFor(link)).toBe(id);
    expect(orgIdFor(mkHq(path.join(tmp, 'other')))).not.toBe(id);
  });
});

describe('discover', () => {
  it('returns the dir itself when it is an hq', () => {
    const d = mkHq(path.join(tmp, 'hq'));
    mkHq(path.join(d, 'nested'));
    expect(findHqs(d)).toEqual([d]);
  });

  it('finds hqs, skips hidden, node_modules, symlinks and does not descend into an hq', () => {
    const a = mkHq(path.join(tmp, 'work', 'a'));
    const b = mkHq(path.join(tmp, 'work', 'deep', 'b'));
    mkHq(path.join(a, 'inside'));
    mkHq(path.join(tmp, '.hidden', 'h'));
    mkHq(path.join(tmp, 'node_modules', 'n'));
    mkHq(path.join(tmp, 'Library', 'l'));
    mkHq(path.join(tmp, 'w1', 'w2', 'w3', 'too-deep'));
    const outside = mkHq(path.join(os.tmpdir(), `coa-outside-${process.pid}`));
    try {
      fs.symlinkSync(outside, path.join(tmp, 'linked'));
      expect(findHqs(tmp).sort()).toEqual([a, b].sort());
      expect(findHqs(tmp, 1)).toEqual([]);
      expect(findHqs(path.join(tmp, 'missing'))).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('usualPlaces and scanUsualPlaces work on a fake home', () => {
    const home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(home, 'Desktop'), { recursive: true });
    fs.mkdirSync(path.join(home, 'Projects'));
    fs.mkdirSync(path.join(home, 'Music'));
    const h1 = mkHq(path.join(home, 'Desktop', 'org1'));
    const h2 = mkHq(path.join(home, 'Projects', 'x', 'org2'));
    const h3 = mkHq(path.join(home, 'top'));
    expect(usualPlaces(home)).toEqual([path.join(home, 'Desktop'), path.join(home, 'Projects')]);
    expect(scanUsualPlaces(home).sort()).toEqual([h1, h2, h3].sort());
  });
});

describe('OrgRegistry', () => {
  it('round trips, is idempotent and tracks active / last used', () => {
    const data = path.join(tmp, 'data');
    const a = mkHq(path.join(tmp, 'a'));
    const b = mkHq(path.join(tmp, 'b'));
    const r = new OrgRegistry(data);
    expect(r.list()).toEqual([]);
    expect(r.lastUsed()).toBeNull();
    expect(r.scannedOnce()).toBe(false);
    const ea = r.add(a);
    expect(r.add(a)).toEqual(ea);
    const eb = r.add(b);
    expect(ea).toEqual({ id: orgIdFor(a), path: a, lastOpened: null });
    expect(r.list()).toHaveLength(2);
    r.touch(ea.id);
    expect(r.get(ea.id)?.lastOpened).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.lastUsed()).toBe(ea.id);
    r.setActive(eb.id);
    expect(r.activeId()).toBe(eb.id);
    expect(r.lastUsed()).toBe(eb.id);
    r.markScanned();

    const r2 = new OrgRegistry(data);
    expect(r2.list()).toHaveLength(2);
    expect(r2.activeId()).toBe(eb.id);
    expect(r2.scannedOnce()).toBe(true);
    expect(r2.get('nope')).toBeUndefined();
    expect(fs.readdirSync(data)).toEqual(['orgs.json']);
  });

  it('starts empty on a corrupt file', () => {
    const data = path.join(tmp, 'data');
    fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, 'orgs.json'), '{not json');
    const r = new OrgRegistry(data);
    expect(r.list()).toEqual([]);
    expect(r.activeId()).toBeNull();
    r.add(mkHq(path.join(tmp, 'a')));
    expect(new OrgRegistry(data).list()).toHaveLength(1);
  });
});

describe('watchHq', () => {
  // Generous timings: under a loaded test run, file events can arrive late.
  const waitFor = async (cond: () => boolean, ms = 6000) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  };

  it('fires for state, initiatives, org and inbox, ignores .git', async () => {
    const d = mkHq(path.join(tmp, 'hq'));
    for (const sub of ['company', 'initiatives/x', 'inbox', '.git']) fs.mkdirSync(path.join(d, sub), { recursive: true });
    const seen: string[] = [];
    // Short debounce: the debounce itself is checked deterministically in the next test.
    const w = watchHq(d, (k) => seen.push(k), 100);
    // macOS starts a recursive watch asynchronously and can miss the first writes, and a loaded run delivers events
    // late: write again until the event arrives, instead of writing once and hoping.
    const writeUntil = async (kind: string, file: string) => {
      for (let i = 0; i < 12 && !seen.includes(kind); i++) {
        fs.writeFileSync(path.join(d, file), `v${i}`);
        await waitFor(() => seen.includes(kind), 750);
      }
    };
    try {
      fs.writeFileSync(path.join(d, '.git', 'index'), 'x');
      await writeUntil('state', 'company/state.md');
      await writeUntil('initiatives', 'initiatives/x/status.md');
      await writeUntil('inbox', 'inbox/n.md');
      await writeUntil('org', 'org.yaml');
      expect([...new Set(seen)].sort()).toEqual(['inbox', 'initiatives', 'org', 'state']);
    } finally {
      w.close();
    }
  }, 40000);

  it('debounces: several events of one kind within the window give one call per kind', () => {
    vi.useFakeTimers();
    let emit: (event: string, filename: string | null) => void = () => {};
    const spy = vi.spyOn(fs, 'watch').mockImplementation(((_p: unknown, _o: unknown, listener: (e: string, f: string | null) => void) => {
      emit = listener;
      return { on: () => undefined, close: () => undefined } as unknown as fs.FSWatcher;
    }) as unknown as typeof fs.watch);
    try {
      const seen: string[] = [];
      const w = watchHq('/hq', (k) => seen.push(k), 1000);
      emit('change', 'company/state.md');
      vi.advanceTimersByTime(500);
      emit('change', 'company/state.md');
      emit('change', '.git/index');
      emit('rename', 'inbox/n.md');
      vi.advanceTimersByTime(999);
      expect(seen).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(seen.sort()).toEqual(['inbox', 'state']);
      emit('change', 'company/state.md');
      vi.advanceTimersByTime(1000);
      expect(seen.filter((k) => k === 'state')).toHaveLength(2);
      w.close();
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not throw when the folder is missing or disappears', async () => {
    expect(() => watchHq(path.join(tmp, 'missing'), () => {}).close()).not.toThrow();
    const d = mkHq(path.join(tmp, 'hq'));
    const w = watchHq(d, () => {});
    fs.rmSync(d, { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 300));
    expect(() => w.close()).not.toThrow();
  });
});
