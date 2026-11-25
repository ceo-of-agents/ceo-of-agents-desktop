import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrgManager } from '../../src/main/org/org-manager';
import { loadHq } from '../../src/main/hq/read';
import { orgYamlReadable } from '../../src/main/hq/parse';

const GOOD = 'org: {id: X, name: X}\ndepartments:\n  - {id: engineering, agent: max, display_name: Max}\n  - {id: design-brand, agent: nora, display_name: Nora}\n';
const BAD = 'departments: [unclosed\n  - x: : :';

let root: string;
let hq: string;
const make = () => {
  const m = new OrgManager({ dataDir: path.join(root, 'data'), settings: {} as never, broker: {} as never, serverScript: 's', nodePath: 'node', emit: () => undefined, cosPollMs: 20 });
  // The chart reads files only; a stand-in session answers for the live status.
  vi.spyOn(m, 'session').mockReturnValue({ chartLive: () => ({ cos: { busy: false, handoffsWaiting: 0 }, departments: {} }) } as never);
  return m;
};

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coa-view-')));
  hq = path.join(root, 'hq');
  fs.mkdirSync(hq);
  fs.writeFileSync(path.join(hq, 'CLAUDE.md'), '# t\n');
  fs.writeFileSync(path.join(hq, 'org.yaml'), GOOD);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('orgYamlReadable', () => {
  it('valid mapping yes; empty, broken and non-mapping no', () => {
    expect(orgYamlReadable(GOOD)).toBe(true);
    for (const t of ['', '  \n', BAD, 'just text', '- a\n- b\n']) expect(orgYamlReadable(t)).toBe(false);
    expect(loadHq(hq).orgReadable).toBe(true);
  });
});

describe('the side panel agrees with the org chart when org.yaml cannot be read', () => {
  it('first load with a broken org.yaml: no departments, flagged unreadable (the chart shows its error plate)', () => {
    fs.writeFileSync(path.join(hq, 'org.yaml'), BAD);
    const m = make();
    const id = m.registry.add(hq).id;
    const v = m.view(id)!;
    expect(v.departments).toEqual([]);
    expect(v.orgUnreadable).toBe(true);
    expect(m.orgChart(id).chart.error).toMatch(/^Line \d+/);
  });

  it('after a good read, a broken save keeps the last good departments in the panel, as the chart keeps its last good chart', () => {
    const m = make();
    const id = m.registry.add(hq).id;
    expect(m.view(id)!.departments.map((d) => d.persona)).toEqual(['Max', 'Nora']);
    m.orgChart(id);
    fs.writeFileSync(path.join(hq, 'org.yaml'), BAD);
    const v = m.view(id)!;
    expect(v.departments.map((d) => d.persona)).toEqual(['Max', 'Nora']);
    expect(v.orgUnreadable).toBeUndefined();
    const c = m.orgChart(id).chart;
    expect(c.staleError).toMatch(/^Line \d+/);
    expect(c.departments.map((d) => d.displayName)).toEqual(['Max', 'Nora']);
    // the next good save replaces it
    fs.writeFileSync(path.join(hq, 'org.yaml'), GOOD.replace('Nora', 'Zed'));
    expect(m.view(id)!.departments.map((d) => d.persona)).toEqual(['Max', 'Zed']);
  });
});
