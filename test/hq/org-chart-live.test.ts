import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { affectsChart, ChartTracker } from '../../src/main/hq/org-chart';
import { classify, watchHq } from '../../src/main/hq/watch';
import type { OrgChart } from '../../src/shared/types';

const FX = path.join(__dirname, '..', 'fixtures', 'org-chart', 'coa');
let tmp: string;
let hq: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coa-chart-live-')));
  hq = path.join(tmp, 'hq');
  fs.cpSync(FX, hq, { recursive: true });
  fs.writeFileSync(path.join(hq, 'CLAUDE.md'), '# t\n');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('classify', () => {
  it('org.yaml and CLAUDE.md are org; .claude/agents is agents; the rest of .claude is nothing', () => {
    expect(classify('org.yaml')).toBe('org');
    expect(classify('CLAUDE.md')).toBe('org');
    expect(classify('.claude/agents')).toBe('agents');
    expect(classify('.claude/agents/max.md')).toBe('agents');
    expect(classify('.claude\\agents\\max.md')).toBe('agents');
    expect(classify('.claude/settings.local.json')).toBe('settings');
    expect(classify('.claude/settings.json')).toBe('settings');
    expect(classify('.claude/settings.json.bak')).toBeNull();
    expect(classify('.claude/agents-old/x.md')).toBeNull();
    expect(classify('.git/index')).toBeNull();
    expect(classify('inbox/n.md')).toBe('inbox');
    expect(classify('company/state.md')).toBe('state');
    expect(classify('company/todo.md')).toBe('state');
    expect(classify('company\\todo.md')).toBe('state');
    expect(classify('company/todo.md.bak')).toBeNull();
    expect(classify('departments/design-brand/app-look.yaml')).toBe('look');
    expect(classify('departments/design-brand/charter.md')).toBeNull();
    expect(classify('departments/a/b/app-look.yaml')).toBeNull();
  });
  it('only org, agents and look changes affect the chart', () => {
    expect(['state', 'initiatives', 'org', 'agents', 'look', 'inbox'].filter((k) => affectsChart(k as never))).toEqual(['org', 'agents', 'look']);
  });
});

describe('last good chart', () => {
  const read = (f: string) => fs.readFileSync(path.join(hq, f), 'utf8');
  const BAD = 'departments: [unclosed\n  - x: : :';

  it('first load with a broken org.yaml is an error on an empty chart', () => {
    fs.writeFileSync(path.join(hq, 'org.yaml'), BAD);
    const c = new ChartTracker(hq).read();
    expect(c.error).toMatch(/^Line \d+: /);
    expect(c.departments).toEqual([]);
    expect(c.staleError).toBeNull();
    expect(c.readAt).toBeNull();
  });

  it('a broken org.yaml after a good read keeps the last good chart with a stale error and the time of that read', () => {
    const tr = new ChartTracker(hq);
    const good = tr.read(new Date('2026-11-18T10:42:00Z'));
    expect(good.readAt).toBe('2026-11-18T10:42:00.000Z');
    const yaml = read('org.yaml');
    fs.writeFileSync(path.join(hq, 'org.yaml'), BAD);
    const stale = tr.changed(new Date('2026-11-18T10:50:00Z'));
    expect(stale?.error).toBeNull();
    expect(stale?.staleError).toMatch(/^Line \d+: /);
    expect(stale?.departments).toEqual(good.departments);
    expect(stale?.readAt).toBe('2026-11-18T10:42:00.000Z');
    // the same failure is not reported twice
    expect(tr.changed()).toBeNull();
    // a missing file is also stale, not empty
    fs.rmSync(path.join(hq, 'org.yaml'));
    expect(tr.changed()?.staleError).toMatch(/not found/);
    // the next good read clears it, with the new time, even when the chart is the same as before
    fs.writeFileSync(path.join(hq, 'org.yaml'), yaml);
    const back = tr.changed(new Date('2026-11-18T11:00:00Z'));
    expect(back?.staleError).toBeNull();
    expect(back?.readAt).toBe('2026-11-18T11:00:00.000Z');
    expect(back?.departments).toEqual(good.departments);
  });

  it('a change to app-look.yaml is a chart change', () => {
    const tr = new ChartTracker(hq);
    tr.read();
    fs.writeFileSync(path.join(hq, 'departments', 'design-brand', 'app-look.yaml'), 'version: 1\ndepartments:\n  engineering: {icon: wrench, colour: pink}\n');
    expect(tr.changed()?.departments[0].look).toEqual({ icon: 'wrench', colour: 'pink' });
  });
});

describe('live chart updates (temp hq copy, real watcher)', () => {
  const waitFor = async (cond: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  };

  it('tracker: unchanged chart is not reported twice', () => {
    const tr = new ChartTracker(hq);
    expect(tr.read().departments).toHaveLength(2);
    expect(tr.changed()).toBeNull();
    fs.writeFileSync(path.join(hq, 'CLAUDE.md'), '# changed\n');
    expect(tr.changed()).toBeNull();
    fs.appendFileSync(path.join(hq, 'org.yaml'), '# note\n');
    expect(tr.changed()).toBeNull();
    fs.writeFileSync(path.join(hq, 'org.yaml'), fs.readFileSync(path.join(hq, 'org.yaml'), 'utf8').replace('display_name: "Ada"', 'display_name: "Bea"'));
    expect(tr.changed()?.cos.displayName).toBe('Bea');
  });

  it('changing org.yaml or adding an agent file emits the new chart, no restart', async () => {
    const tr = new ChartTracker(hq);
    tr.read();
    const emitted: OrgChart[] = [];
    // The same wiring as OrgManager: a watched change that affects the chart re-reads it and emits when it differs.
    const w = watchHq(hq, (k) => {
      if (!affectsChart(k)) return;
      const c = tr.changed();
      if (c) emitted.push(c);
    }, 100);
    // macOS starts a recursive watch asynchronously and can miss the first writes: write again until the event arrives.
    const writeUntil = async (cond: () => boolean, write: (i: number) => void) => {
      for (let i = 0; i < 12 && !cond(); i++) {
        write(i);
        await waitFor(cond, 750);
      }
    };
    try {
      const yaml = fs.readFileSync(path.join(hq, 'org.yaml'), 'utf8');
      await writeUntil(
        () => emitted.some((c) => c.cos.displayName === 'Bea'),
        (i) => fs.writeFileSync(path.join(hq, 'org.yaml'), yaml.replace('display_name: "Ada"', 'display_name: "Bea"') + `# v${i}\n`),
      );
      expect(emitted.find((c) => c.cos.displayName === 'Bea')?.departments).toHaveLength(2);

      await writeUntil(
        () => emitted.some((c) => c.workers.types.some((x) => x.name === 'scout')),
        (i) => fs.writeFileSync(path.join(hq, '.claude', 'agents', 'scout.md'), `---\nname: scout\nmodel: haiku\n---\n# v${i}\n`),
      );
      const withScout = emitted.find((c) => c.workers.types.some((x) => x.name === 'scout'));
      expect(withScout?.workers.types.map((x) => x.name)).toEqual(['reader', 'scout', 'worker']);
      expect(withScout?.workers.types.find((x) => x.name === 'scout')?.model).toBe('haiku');
      // a helper named by Max shows on his node too (a bare Agent tool would list it; here only the named ones do)
      expect(withScout?.departments[0].workers.map((w) => w.name)).toEqual(['reader', 'worker']);
    } finally {
      w.close();
    }
  }, 40000);
});

describe('a normal save never flashes the stale-chart error (default 200 ms debounce, real watcher)', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (cond: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await sleep(25);
  };

  /** The OrgManager wiring with its default debounce: every chart that would be emitted to the renderer is recorded. */
  async function withWatcher(run: (emitted: OrgChart[], yaml: string) => Promise<void>): Promise<void> {
    const tr = new ChartTracker(hq);
    tr.read();
    const emitted: OrgChart[] = [];
    const w = watchHq(hq, (k) => {
      if (!affectsChart(k)) return;
      const c = tr.changed();
      if (c) emitted.push(c);
    });
    try {
      await sleep(400); // macOS starts a recursive watch asynchronously
      await run(emitted, fs.readFileSync(path.join(hq, 'org.yaml'), 'utf8'));
    } finally {
      w.close();
    }
  }
  const named = (yaml: string, name: string) => yaml.replace('display_name: "Ada"', `display_name: "${name}"`);
  const flashed = (emitted: OrgChart[]) => emitted.filter((c) => c.staleError || c.error);

  it('truncate, then the content about 50 ms later (an editor that rewrites in place)', async () => {
    await withWatcher(async (emitted, yaml) => {
      for (const name of ['Bea', 'Cleo', 'Dina']) {
        fs.writeFileSync(path.join(hq, 'org.yaml'), ''); // truncated
        await sleep(50);
        fs.writeFileSync(path.join(hq, 'org.yaml'), named(yaml, name));
        await waitFor(() => emitted.some((c) => c.cos.displayName === name), 3000);
      }
      expect(emitted.map((c) => c.cos.displayName)).toEqual(['Bea', 'Cleo', 'Dina']);
      expect(flashed(emitted)).toEqual([]);
    });
  });

  it('a temp file written next to it, then renamed over it (an atomic save)', async () => {
    await withWatcher(async (emitted, yaml) => {
      for (const name of ['Bea', 'Cleo', 'Dina']) {
        fs.writeFileSync(path.join(hq, 'org.yaml.tmp'), named(yaml, name));
        await sleep(20);
        fs.renameSync(path.join(hq, 'org.yaml.tmp'), path.join(hq, 'org.yaml'));
        await waitFor(() => emitted.some((c) => c.cos.displayName === name), 3000);
      }
      expect(emitted.map((c) => c.cos.displayName)).toEqual(['Bea', 'Cleo', 'Dina']);
      expect(flashed(emitted)).toEqual([]);
    });
  });

  it('control: a file left empty for longer than the debounce does show the stale error (the test can tell)', async () => {
    await withWatcher(async (emitted) => {
      fs.writeFileSync(path.join(hq, 'org.yaml'), '');
      await waitFor(() => flashed(emitted).length > 0, 3000);
      expect(flashed(emitted)[0].staleError).toMatch(/empty/);
    });
  });
});
