import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentToolNames, derivedWorkerModel, firstSentence, MAX_FILE_BYTES, parseFrontmatter, parseOrgChart, readOrgChart, type AgentFile } from '../../src/main/hq/org-chart';
import { buildOrgChartLive } from '../../src/shared/org-chart-live';
import { own } from '../../src/shared/own';
import { parseOrgYaml } from '../../src/main/hq/parse';

const FX = path.join(__dirname, '..', 'fixtures', 'org-chart', 'coa');
const agent = (file: string, name: string, model = 'opus') => ({ file, text: `---\nname: ${name}\nmodel: ${model}\n---\nbody\n` });
const BASIC = 'departments:\n  - id: eng\n    agent: max\n    display_name: Max\n';

let tmp: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coa-chart-')));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('readOrgChart on the scrubbed fixture', () => {
  it('reads two departments, two worker types, the CoS name, models and the workers rule', () => {
    const c = readOrgChart(FX);
    expect(c.error).toBeNull();
    expect(c.problems).toEqual([]);
    expect(c.ceo).toEqual({ roleId: 'ceo', displayName: '' });
    expect(c.cos).toEqual({ displayName: 'Ada', model: 'opus' });
    expect(c.tiers).toEqual(['opus', 'sonnet', 'haiku']);
    expect(c.error).toBeNull();
    expect(c.staleError).toBeNull();
    expect(c.departments).toEqual([
      {
        id: 'engineering', agent: 'max', displayName: 'Max', catalogRole: 'engineering', model: 'opus', agentFile: { found: true, name: 'max', model: 'opus' },
        agentPath: '.claude/agents/max.md', look: { icon: 'code', colour: 'blue' },
        workers: [{ name: 'reader', model: 'sonnet', description: 'Sample read-only worker.' }, { name: 'worker', model: 'sonnet', description: 'Sample hands-on worker.' }],
      },
      {
        id: 'design-brand', agent: 'lena', displayName: 'Lena', catalogRole: 'design-brand', model: 'opus', agentFile: { found: true, name: 'lena', model: 'opus' },
        agentPath: '.claude/agents/lena.md', look: { icon: 'pen-tool', colour: 'pink' },
        workers: [{ name: 'reader', model: 'sonnet', description: 'Sample read-only worker.' }],
      },
    ]);
    expect(c.workers).toEqual({
      rule: 'one-down',
      types: [{ name: 'reader', model: 'sonnet', description: 'Sample read-only worker.' }, { name: 'worker', model: 'sonnet', description: 'Sample hands-on worker.' }],
    });
    expect(Number.isNaN(Date.parse(c.readAt ?? ''))).toBe(false);
  });

  it('leaves parseOrgYaml as it was (invalid YAML is still an empty org, silently)', () => {
    expect(parseOrgYaml('a: [unclosed').departments).toEqual([]);
    expect(parseOrgYaml(fs.readFileSync(path.join(FX, 'org.yaml'), 'utf8')).departments).toHaveLength(2);
  });
});

describe('parseOrgChart', () => {
  it('zero departments is valid', () => {
    const c = parseOrgChart('org:\n  id: X\ndepartments: []\n', []);
    expect(c.error).toBeNull();
    expect(c.departments).toEqual([]);
    expect(c.problems).toEqual([]);
  });

  it('missing cos, models and per-department fields fall back', () => {
    const c = parseOrgChart('departments:\n  - id: eng\n    agent: max\n', [agent('max.md', 'max')]);
    expect(c.cos).toEqual({ displayName: 'Chief of Staff', model: null });
    expect(c.tiers).toEqual([]);
    expect(c.workers.rule).toBeNull();
    expect(c.departments[0]).toMatchObject({ displayName: 'eng', catalogRole: '', model: null });
    expect(c.problems).toEqual(['Department eng has no display name: its id is shown instead.']);
  });

  it('a department without its own model gets models.departments; its own model wins', () => {
    const y = 'models:\n  departments: sonnet\ndepartments:\n  - {id: a, agent: a, display_name: A}\n  - {id: b, agent: b, display_name: B, model: opus}\n';
    const c = parseOrgChart(y, [agent('a.md', 'a'), agent('b.md', 'b')]);
    expect(c.departments.map((d) => d.model)).toEqual(['sonnet', 'opus']);
  });

  it('an agent defaults to the department id', () => {
    const c = parseOrgChart('departments:\n  - {id: legal, display_name: L}\n', [agent('legal.md', 'legal')]);
    expect(c.departments[0].agent).toBe('legal');
    expect(c.departments[0].agentFile.found).toBe(true);
  });

  it('ceo display name and role id', () => {
    const c = parseOrgChart('ceo:\n  role_id: founder\n  display_name: Zoe\n', []);
    expect(c.ceo).toEqual({ roleId: 'founder', displayName: 'Zoe' });
  });

  it('invalid YAML sets error and gives an empty chart without throwing', () => {
    const c = parseOrgChart('departments: [unclosed\n  - x: : :', [agent('max.md', 'max')]);
    expect(c.error).toMatch(/^Line \d+: /);
    expect(c.departments).toEqual([]);
    expect(c.workers.types).toEqual([]);
  });

  it('empty and non-mapping org.yaml are errors', () => {
    expect(parseOrgChart('  \n', []).error).toMatch(/empty/);
    expect(parseOrgChart('- a\n- b\n', []).error).toMatch(/mapping/);
    expect(parseOrgChart('just text', []).error).toMatch(/mapping/);
  });

  it('a department without an agent file is a problem, not an error', () => {
    const c = parseOrgChart(BASIC, [agent('reader.md', 'reader')]);
    expect(c.error).toBeNull();
    expect(c.departments[0].agentFile).toEqual({ found: false, name: null, model: null });
    expect(c.problems).toEqual(['Department eng has no agent file: .claude/agents/max.md is missing.']);
    expect(c.workers.types).toEqual([{ name: 'reader', model: 'opus', description: '' }]);
  });

  it('an agent file whose name differs from the department agent is a problem', () => {
    const c = parseOrgChart(BASIC, [agent('max.md', 'maximilian')]);
    expect(c.departments[0].agentFile).toEqual({ found: true, name: 'maximilian', model: 'opus' });
    expect(c.problems).toEqual(['The agent file max.md is named "maximilian", but department eng uses the agent "max".']);
  });

  it('worker types are the agent files that belong to no department, sorted', () => {
    const c = parseOrgChart(BASIC, [agent('worker.md', 'worker', 'sonnet'), agent('max.md', 'max'), agent('reader.md', 'reader', 'sonnet'), agent('a-helper.md', 'a-helper')]);
    expect(c.workers.types.map((w) => w.name)).toEqual(['a-helper', 'reader', 'worker']);
  });

  it('frontmatter variants: none, CRLF, extra keys, BOM', () => {
    const files: AgentFile[] = [
      { file: 'max.md', text: '# Max\nno frontmatter here\n' },
      { file: 'crlf.md', text: '---\r\nname: crlf\r\nmodel: haiku\r\ntools: Read, Bash\r\ncolor: red\r\n---\r\nbody' },
      { file: 'bom.md', text: '﻿---\nname: bom\nextra:\n  nested: [1, 2]\n---\n' },
    ];
    const c = parseOrgChart(BASIC, files);
    expect(c.departments[0].agentFile).toEqual({ found: true, name: null, model: null });
    expect(c.problems).toContain('The agent file max.md has no name.');
    expect(c.workers.types).toEqual([{ name: 'bom', model: null, description: '' }, { name: 'crlf', model: 'haiku', description: '' }]);
  });

  it('an agent file with an invalid header is a problem and still lists', () => {
    const c = parseOrgChart(BASIC, [agent('max.md', 'max'), { file: 'odd.md', text: '---\nname: [oops\n---\n' }]);
    expect(c.problems).toEqual(['The agent file odd.md has a header that is not valid YAML.']);
    expect(c.workers.types).toEqual([{ name: 'odd', model: null, description: '' }]);
  });
});

describe('parseFrontmatter', () => {
  it('needs the opening line first and a closing line', () => {
    expect(parseFrontmatter('text\n---\nname: x\n---\n').data).toEqual({});
    expect(parseFrontmatter('---\nname: x\n').data).toEqual({});
    expect(parseFrontmatter('---\nname: x\n---\n').data).toEqual({ name: 'x' });
    expect(parseFrontmatter('---\n---\nbody').data).toEqual({});
  });
  it('ignores a later --- in the body', () => {
    expect(parseFrontmatter('---\nname: x\n---\nbody\n---\nname: y\n---\n').data).toEqual({ name: 'x' });
  });
});

describe('readOrgChart failures', () => {
  it('missing org.yaml: error, empty chart, no throw', () => {
    const c = readOrgChart(path.join(tmp, 'nope'));
    expect(c.error).toMatch(/not found/);
    expect(c.departments).toEqual([]);
  });

  it('org.yaml that is a folder is unreadable: error, no throw', () => {
    fs.mkdirSync(path.join(tmp, 'org.yaml'));
    expect(readOrgChart(tmp).error).toMatch(/EISDIR|illegal operation/);
  });

  it('no .claude/agents folder: every department reports a missing agent file', () => {
    fs.writeFileSync(path.join(tmp, 'org.yaml'), BASIC);
    const c = readOrgChart(tmp);
    expect(c.error).toBeNull();
    expect(c.problems).toHaveLength(1);
  });
});

describe('workers per department', () => {
  const dept = (tools: string) => ({ file: 'max.md', text: `---\nname: max\ndescription: Engineering. More words.\ntools: ${tools}\nmodel: opus\n---\n` });
  const W = (n: string, model?: string, desc = 'A helper.') => ({ file: `${n}.md`, text: `---\nname: ${n}\ndescription: ${desc} Second sentence.\n${model ? `model: ${model}\n` : ''}---\n` });
  const Y = 'models:\n  tiers: [opus, sonnet, haiku]\n  cos: opus\n  departments: opus\n  workers: one-down\n' + BASIC;

  it('the names in Agent(...) on the tools line become chips, with the first sentence of the description', () => {
    const c = parseOrgChart(Y, [dept('Read, Bash, Agent(reader, worker)'), W('reader', 'sonnet'), W('worker', 'haiku'), W('scout')]);
    expect(c.departments[0].workers).toEqual([
      { name: 'reader', model: 'sonnet', description: 'A helper.' },
      { name: 'worker', model: 'haiku', description: 'A helper.' },
    ]);
    // the chief of staff's helpers are every agent file that is not a department's
    expect(c.workers.types.map((w) => w.name)).toEqual(['reader', 'scout', 'worker']);
  });

  it('no Agent tool means no chips', () => {
    const c = parseOrgChart(Y, [dept('Read, Grep, Glob'), W('reader', 'sonnet')]);
    expect(c.departments[0].workers).toEqual([]);
  });

  it('tools as a YAML list work, and a bare Agent lists every helper', () => {
    const list = { file: 'max.md', text: '---\nname: max\ntools:\n  - Read\n  - Agent(reader)\n---\n' };
    expect(parseOrgChart(Y, [list, W('reader', 'sonnet'), W('worker', 'sonnet')]).departments[0].workers.map((w) => w.name)).toEqual(['reader']);
    expect(parseOrgChart(Y, [dept('Read, Agent'), W('reader', 'sonnet'), W('worker', 'sonnet')]).departments[0].workers.map((w) => w.name)).toEqual(['reader', 'worker']);
  });

  it('a worker model comes from its own frontmatter, else from the rule', () => {
    const c = parseOrgChart(Y, [dept('Agent(reader, worker, ghost)'), W('reader', 'haiku'), W('worker')]);
    // department model opus, one-down: sonnet. A name with no file still gets a chip.
    expect(c.departments[0].workers).toEqual([
      { name: 'reader', model: 'haiku', description: 'A helper.' },
      { name: 'worker', model: 'sonnet', description: 'A helper.' },
      { name: 'ghost', model: 'sonnet', description: '' },
    ]);
    expect(c.workers.types.find((w) => w.name === 'worker')?.model).toBe('sonnet');
  });

  it('derivedWorkerModel: one-down stops at the last tier, same keeps the parent, unknown gives null', () => {
    const tiers = ['opus', 'sonnet', 'haiku'];
    expect(derivedWorkerModel('one-down', tiers, 'opus')).toBe('sonnet');
    expect(derivedWorkerModel('one-down', tiers, 'sonnet')).toBe('haiku');
    expect(derivedWorkerModel('one-down', tiers, 'haiku')).toBe('haiku');
    expect(derivedWorkerModel('same', tiers, 'sonnet')).toBe('sonnet');
    expect(derivedWorkerModel('one-down', tiers, 'claude-opus-5-5')).toBeNull();
    expect(derivedWorkerModel('one-down', tiers, null)).toBeNull();
    expect(derivedWorkerModel(null, tiers, 'opus')).toBeNull();
    expect(derivedWorkerModel('weird', tiers, 'opus')).toBeNull();
  });

  it('"same" gives the worker its parent model; "inherit" counts as no model', () => {
    const y = 'models:\n  tiers: [opus, sonnet]\n  cos: sonnet\n  departments: opus\n  workers: same\n' + BASIC;
    const c = parseOrgChart(y, [dept('Agent(reader)'), { file: 'reader.md', text: '---\nname: reader\nmodel: inherit\n---\n' }]);
    expect(c.departments[0].workers[0].model).toBe('opus');
    expect(c.workers.types[0].model).toBe('sonnet');
  });

  it('the agent path is the file when found, else the expected one', () => {
    const c = parseOrgChart(BASIC, []);
    expect(c.departments[0].agentPath).toBe('.claude/agents/max.md');
  });

  it('firstSentence and agentToolNames', () => {
    expect(firstSentence('Reads files.  Then more.')).toBe('Reads files.');
    expect(firstSentence('No full stop here')).toBe('No full stop here');
    expect(firstSentence('Use for v1.2 notes. Next.')).toBe('Use for v1.2 notes.');
    expect(firstSentence('')).toBe('');
    expect(agentToolNames('Read, Agent(a, b), Agent(c)')).toEqual(['a', 'b', 'c']);
    expect(agentToolNames('Read, Grep')).toBeNull();
    expect(agentToolNames('Read, SubAgent(x)')).toBeNull();
    expect(agentToolNames(undefined)).toBeNull();
  });
});

describe('app-look.yaml', () => {
  const Y2 = 'departments:\n  - {id: eng, agent: max, display_name: Max}\n  - {id: design, agent: lena, display_name: Lena}\n  - {id: legal, agent: legal, display_name: L}\n';
  const look = (department: string, text: string) => ({ department, text });
  const run = (files: Array<{ department: string; text: string }>) => {
    const warnings: string[][] = [];
    const c = parseOrgChart(Y2, [], files, (w) => warnings.push(w));
    return { looks: c.departments.map((d) => d.look), warnings };
  };

  it('valid: icons and colours land on their departments; the colour defaults to neutral', () => {
    const r = run([look('design', 'version: 1\ndepartments:\n  eng: {icon: code, colour: blue}\n  design: {icon: pen-tool}\n')]);
    expect(r.looks).toEqual([{ icon: 'code', colour: 'blue' }, { icon: 'pen-tool', colour: 'neutral' }, null]);
    expect(r.warnings).toEqual([]);
  });

  it('a colour without an icon colours the initials', () => {
    expect(run([look('eng', 'version: 1\ndepartments:\n  eng: {colour: pink}\n')]).looks[0]).toEqual({ icon: null, colour: 'pink' });
  });

  it('partial: a bad item falls back on its own, the rest stays, one list of warnings', () => {
    const r = run([look('eng', 'version: 1\ndepartments:\n  eng: {icon: sparkles, colour: blue}\n  design: {icon: palette, colour: teal}\n  legal: {icon: scale, colour: pink}\n  nope: {icon: code}\n')]);
    expect(r.looks).toEqual([null, null, { icon: 'scale', colour: 'pink' }]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toHaveLength(3);
  });

  it('broken: invalid YAML, a wrong version or a wrong shape fall back for every department', () => {
    for (const text of ['version: 1\ndepartments: [unclosed', 'version: 2\ndepartments:\n  eng: {icon: code}\n', 'just text', 'version: 1\ndepartments: [a, b]\n']) {
      const r = run([look('eng', text)]);
      expect(r.looks).toEqual([null, null, null]);
    }
    expect(run([look('eng', 'version: 2\n')]).warnings).toHaveLength(1);
  });

  it('the first department in org.yaml order that has a file wins; a folder of a department not in org.yaml is ignored', () => {
    const a = 'version: 1\ndepartments:\n  eng: {icon: code}\n';
    const b = 'version: 1\ndepartments:\n  eng: {icon: wrench}\n';
    expect(run([look('design', b), look('eng', a)]).looks[0]).toEqual({ icon: 'code', colour: 'neutral' });
    expect(run([look('archived', a)]).looks).toEqual([null, null, null]);
  });

  it('readOrgChart reads departments/<id>/app-look.yaml and ignores an id that is not a folder name', () => {
    fs.writeFileSync(path.join(tmp, 'org.yaml'), 'departments:\n  - {id: eng, agent: max, display_name: Max}\n  - {id: "../x", agent: x, display_name: X}\n');
    fs.mkdirSync(path.join(tmp, 'departments', 'eng'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'departments', 'eng', 'app-look.yaml'), 'version: 1\ndepartments:\n  eng: {icon: wrench, colour: blue}\n');
    const c = readOrgChart(tmp);
    expect(c.departments[0].look).toEqual({ icon: 'wrench', colour: 'blue' });
    expect(c.departments[1].look).toBeNull();
  });

  it('a broken file logs one console warning and shows no error', () => {
    fs.writeFileSync(path.join(tmp, 'org.yaml'), BASIC);
    fs.mkdirSync(path.join(tmp, 'departments', 'eng'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'departments', 'eng', 'app-look.yaml'), 'version: 1\ndepartments:\n  eng: {icon: nope}\n  zzz: {}\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const c = readOrgChart(tmp);
      expect(c.error).toBeNull();
      expect(c.problems).toEqual(['Department eng has no agent file: .claude/agents/max.md is missing.']);
      expect(c.departments[0].look).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('error detail', () => {
  it('a YAML error carries the line and no file path or snippet', () => {
    const c = parseOrgChart('a:\n  b: 1\n c: [x', []);
    expect(c.error).toMatch(/^Line 3: /);
    expect(c.error).not.toMatch(/\n/);
    expect(c.staleError).toBeNull();
    expect(c.readAt).toBeNull();
  });
});

describe('ids that are names of Object.prototype', () => {
  const KEYS = ['constructor', 'toString', '__proto__'];
  const yamlOf = (ids: string[]) => `departments:\n${ids.map((id) => `  - {id: ${JSON.stringify(id)}, agent: ${JSON.stringify(`a-${id}`)}, display_name: D${id.length}}`).join('\n')}\n`;
  const lookOf = (ids: string[]) => `version: 1\ndepartments:\n${ids.map((id) => `  ${JSON.stringify(id)}: {icon: code, colour: blue}`).join('\n')}\n`;

  it('a chart with no app-look.yaml loads and clones: nothing is inherited as a look', () => {
    const c = parseOrgChart(yamlOf(KEYS), []);
    expect(c.error).toBeNull();
    expect(c.departments.map((d) => d.id)).toEqual(KEYS);
    expect(c.departments.map((d) => d.look)).toEqual([null, null, null]);
    expect(() => structuredClone(c)).not.toThrow();
  });

  it('the same keys in app-look.yaml are real entries, and a department without one stays null', () => {
    const c = parseOrgChart(yamlOf(KEYS), [], [{ department: 'constructor', text: lookOf(KEYS) }]);
    expect(c.departments.map((d) => d.look)).toEqual([{ icon: 'code', colour: 'blue' }, { icon: 'code', colour: 'blue' }, { icon: 'code', colour: 'blue' }]);
    expect(structuredClone(c).departments[2].look).toEqual({ icon: 'code', colour: 'blue' });
    const partial = parseOrgChart(yamlOf(KEYS), [], [{ department: 'constructor', text: lookOf(['toString']) }]);
    expect(partial.departments.map((d) => d.look)).toEqual([null, { icon: 'code', colour: 'blue' }, null]);
    expect(() => structuredClone(partial)).not.toThrow();
  });

  it('an agent named like a prototype key resolves through its file only', () => {
    const c = parseOrgChart('departments:\n  - {id: x, agent: constructor, display_name: X}\n  - {id: y, agent: toString, display_name: Y}\n', [agent('constructor.md', 'constructor')]);
    expect(c.departments.map((d) => d.agentFile.found)).toEqual([true, false]);
    expect(() => structuredClone(c)).not.toThrow();
  });

  it('the live map keeps such ids and clones', () => {
    const live = buildOrgChartLive(KEYS.map((id) => ({ id, agent: `a-${id}` })), [], () => undefined);
    expect(Object.keys(live.departments)).toEqual(KEYS);
    expect(KEYS.every((k) => own(live.departments, k)?.running === false)).toBe(true);
    expect(Object.keys(structuredClone(live).departments)).toEqual(KEYS);
    expect(own(buildOrgChartLive([], [], () => undefined).departments, 'constructor')).toBeUndefined();
  });

  it('readOrgChart on a real folder', () => {
    fs.writeFileSync(path.join(tmp, 'org.yaml'), yamlOf(KEYS));
    fs.mkdirSync(path.join(tmp, 'departments', 'constructor'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'departments', 'constructor', 'app-look.yaml'), lookOf(KEYS));
    const c = readOrgChart(tmp);
    expect(c.error).toBeNull();
    expect(c.departments.every((d) => d.look?.icon === 'code')).toBe(true);
    expect(() => structuredClone(c)).not.toThrow();
  });
});

describe('size cap on the files read for the chart', () => {
  const big = (head: string) => head + '#'.repeat(MAX_FILE_BYTES + 10) + '\n';
  const exactly = (head: string) => head + '#'.repeat(MAX_FILE_BYTES - head.length - 1) + '\n';

  it('an org.yaml over 256 KB is an error; one of exactly 256 KB is read', () => {
    fs.writeFileSync(path.join(tmp, 'org.yaml'), big(BASIC));
    const c = readOrgChart(tmp);
    expect(c.error).toMatch(/over 256 KB/);
    expect(c.departments).toEqual([]);
    fs.writeFileSync(path.join(tmp, 'org.yaml'), exactly(BASIC));
    expect(fs.statSync(path.join(tmp, 'org.yaml')).size).toBe(MAX_FILE_BYTES);
    expect(readOrgChart(tmp).error).toBeNull();
  });

  it('an oversized agent file is skipped with a problem entry; the others stay', () => {
    fs.writeFileSync(path.join(tmp, 'org.yaml'), 'departments:\n  - {id: eng, agent: max, display_name: Max}\n  - {id: des, agent: lena, display_name: Lena}\n');
    fs.mkdirSync(path.join(tmp, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.claude', 'agents', 'max.md'), big('---\nname: max\nmodel: opus\n---\n'));
    fs.writeFileSync(path.join(tmp, '.claude', 'agents', 'lena.md'), '---\nname: lena\nmodel: opus\n---\n');
    const c = readOrgChart(tmp);
    expect(c.error).toBeNull();
    expect(c.problems).toContain('The agent file max.md is over 256 KB and was skipped.');
    expect(c.departments.map((d) => d.agentFile.found)).toEqual([false, true]);
  });

  it('an oversized app-look.yaml is a silent fallback to initials (one console warning)', () => {
    fs.writeFileSync(path.join(tmp, 'org.yaml'), BASIC);
    fs.mkdirSync(path.join(tmp, 'departments', 'eng'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'departments', 'eng', 'app-look.yaml'), big('version: 1\ndepartments:\n  eng: {icon: code}\n'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const c = readOrgChart(tmp);
      expect(c.error).toBeNull();
      expect(c.departments[0].look).toBeNull();
      expect(c.problems.some((p) => /app-look/.test(p))).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
