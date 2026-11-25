import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildDepartments,
  departmentModel,
  parseInitiativeStatus,
  parseOrgYaml,
  parseRoutingTable,
  parseTodo,
  parseWaiting,
} from '../../src/main/hq/parse';
import type { WaitingItem } from '../../src/shared/types';

const FX = path.join(__dirname, '..', 'fixtures', 'hq');
const read = (...p: string[]) => fs.readFileSync(path.join(FX, ...p), 'utf8');
const items = (f: string) => parseWaiting(read('state', f)) as WaitingItem[];

describe('parseWaiting on sample state.md versions', () => {
  it('sample-1: 8 items, mixed urgencies', () => {
    const w = items('state-sample-1.md');
    expect(w).toHaveLength(8);
    expect(w.every((i) => 'code' in i)).toBe(true);
    expect(w.map((i) => i.code)).toEqual([
      'ACME-A2', 'ACME-D8', 'ACME-D9', 'ACME-D10', 'ACME-D12', 'ACME-A14', 'ACME-A19', 'ACME-A20',
    ]);
    expect(w[0]).toMatchObject({ kind: 'A', urgency: 'low', since: '2026-11-04', escalate: false });
    expect(w[0].text.startsWith('in https://example.com/settings')).toBe(true);
    expect(w[1]).toMatchObject({
      code: 'ACME-D8',
      kind: 'D',
      urgency: 'normal',
      since: '2026-11-05',
      text: 'decide whether the weekly report goes out on Monday or Friday, see decision queue',
    });
    expect(w[7].since).toBe('2026-11-06');
  });

  it('sample-2: 3 items', () => {
    const w = items('state-sample-2.md');
    expect(w.map((i) => i.code)).toEqual(['ACME-A32', 'ACME-A33', 'ACME-A34']);
    expect(w[1].urgency).toBe('normal');
    expect(w[2].urgency).toBe('low');
    expect(w[1].since).toBe('2026-11-07');
  });

  it('sample-3: 4 items', () => {
    const w = items('state-sample-3.md');
    expect(w).toHaveLength(4);
    expect(w[0].code).toBe('ACME-A2');
    expect(w[1].code).toBe('ACME-D10');
  });

  it('sample-4: single item', () => {
    const w = items('state-sample-4.md');
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ code: 'ACME-A35', kind: 'A', urgency: 'normal', since: '2026-11-17' });
  });

  it('sample-5: 2 items', () => {
    const w = items('state-sample-5.md');
    expect(w.map((i) => i.code)).toEqual(['ACME-A2', 'ACME-A9']);
  });

  it('sample-6: 6 items', () => {
    const w = items('state-sample-6.md');
    expect(w).toHaveLength(6);
    expect(w[5].code).toBe('ACME-A27');
    expect(w[3].urgency).toBe('normal');
    expect(w[4].urgency).toBe('low');
  });

  it('empty: "- none" gives no items', () => {
    expect(parseWaiting(read('state', 'state-empty.md'))).toEqual([]);
  });
});

describe('parseWaiting edge cases', () => {
  const w = parseWaiting(read('state', 'state-synthetic-mixed.md'));

  it('reads escalate tag, urgency and since', () => {
    expect(w[0]).toEqual({
      code: 'ACME-D3',
      kind: 'D',
      urgency: 'high',
      text: 'decide the example thing',
      since: '2026-11-09',
      escalate: true,
      action: null,
    });
  });

  it('joins continuation lines to the previous item', () => {
    expect(w[1]).toEqual({
      code: 'ACME-A4',
      kind: 'A',
      urgency: null,
      text: 'no urgency and no date here second line of the same item third line too',
      since: null,
      escalate: false,
      action: null,
    });
  });

  it('puts lines that do not match in unparsed', () => {
    expect(w).toHaveLength(5);
    expect(w[3]).toEqual({ unparsed: 'this line has no code at all'.replace(/^/, '- ') });
    expect(w[4]).toEqual({ unparsed: '- ACME-X9 [normal]: wrong kind letter (since 2026-11-01)' });
  });

  it('stops at the next heading and handles a missing section', () => {
    expect(w.some((e) => 'text' in e && e.text.includes('none'))).toBe(false);
    expect(parseWaiting('# nothing here')).toEqual([]);
    expect(parseWaiting('')).toEqual([]);
  });
});

describe('parseOrgYaml', () => {
  it('reads the sample org.yaml', () => {
    const o = parseOrgYaml(read('org.yaml'));
    expect(o).toMatchObject({
      id: 'ACME',
      name: 'Acme',
      cosName: 'Ada',
      frameworkVersion: '0.13.0',
      chatLanguage: 'it',
    });
    expect(o.departments).toEqual([
      { id: 'engineering', agent: 'max', displayName: 'Max', fromCatalog: 'engineering', model: 'opus' },
      { id: 'design-brand', agent: 'nora', displayName: 'Nora', fromCatalog: 'design-brand', model: 'opus' },
    ]);
  });

  it('reads the models block', () => {
    const o = parseOrgYaml(read('org.yaml'));
    expect(o.models).toEqual({ cos: 'opus', departments: 'opus', tiers: ['opus', 'sonnet', 'haiku'] });
  });

  it('has no models when the block is missing or odd', () => {
    expect(parseOrgYaml('org:\n  id: X\n').models).toEqual({ cos: null, departments: null, tiers: [] });
    expect(parseOrgYaml('models:\n  tiers: nope\n  cos: 7\n').models).toEqual({ cos: '7', departments: null, tiers: [] });
  });

  it('departmentModel: own model, else models.departments, else null', () => {
    const o = parseOrgYaml('models:\n  departments: sonnet\ndepartments:\n  - id: a\n    model: opus\n  - id: b\n');
    expect(departmentModel(o, 'a')).toBe('opus');
    expect(departmentModel(o, 'b')).toBe('sonnet');
    expect(departmentModel(o, 'zzz')).toBe('sonnet');
    expect(departmentModel(parseOrgYaml('departments:\n  - id: a\n'), 'a')).toBeNull();
  });

  it('uses defaults for missing fields', () => {
    const o = parseOrgYaml('org:\n  id: X\ncos:\n  display_name: ""\ndepartments:\n  - id: legal\n  - nope: 1\n');
    expect(o.cosName).toBe('Chief of Staff');
    expect(o.frameworkVersion).toBeNull();
    expect(o.departments).toEqual([{ id: 'legal', agent: 'legal', displayName: '', fromCatalog: '', model: null }]);
  });

  it('never throws on invalid yaml or non-objects', () => {
    for (const t of ['', 'a: [unclosed', ': : :\n\t- x', '- 1\n- 2', 'just text']) {
      const o = parseOrgYaml(t);
      expect(o.cosName).toBe('Chief of Staff');
      expect(o.departments).toEqual([]);
    }
  });
});

describe('routing table and departments', () => {
  const roles = parseRoutingTable(read('CLAUDE.md'));

  it('skips tables without Agent and Role and maps agent to role', () => {
    expect(roles.get('max')).toBe('Engineering');
    expect(roles.get('nora')).toBe('Design and brand');
    expect(roles.size).toBe(2);
  });

  it('builds departments with roles', () => {
    const deps = buildDepartments(parseOrgYaml(read('org.yaml')), roles);
    expect(deps).toEqual([
      { id: 'engineering', agent: 'max', persona: 'Max', role: 'Engineering' },
      { id: 'design-brand', agent: 'nora', persona: 'Nora', role: 'Design and brand' },
    ]);
  });

  it('falls back to the id as words and the agent as persona', () => {
    const org = parseOrgYaml('departments:\n  - id: design-brand\n    agent: zed\n');
    expect(buildDepartments(org, new Map())).toEqual([
      { id: 'design-brand', agent: 'zed', persona: 'zed', role: 'Design brand' },
    ]);
  });

  it('handles backticks, column order and no table', () => {
    const md = '| Role | Agent |\n|---|---|\n| Legal | `lex` |\n';
    expect(parseRoutingTable(md).get('lex')).toBe('Legal');
    expect(parseRoutingTable('no table').size).toBe(0);
  });
});

describe('parseInitiativeStatus', () => {
  it('reads sample versions', () => {
    const a = parseInitiativeStatus('mobile-client', read('initiatives', 'status-sample-1.md'));
    expect(a).toMatchObject({
      slug: 'mobile-client',
      title: 'Mobile client',
      state: 'active',
      updated: '2026-11-17',
    });
    expect(a.goal.startsWith('A small mobile client')).toBe(true);
    expect(a.nextStep).toBe(
      'Engineering runs the spike and leaves a handoff; then the CoS writes a decision card on whether and how to build the client.',
    );
    expect(a.stateText.startsWith('Idea raised by the CEO on 2026-11-17.')).toBe(true);
    expect(a.stateText).not.toContain('Next step');
    expect(a.stateText).not.toContain('\n');
    const c = parseInitiativeStatus('x', read('initiatives', 'status-sample-2.md'));
    expect(c.stateText.startsWith('Idea raised by the CEO on 2026-11-17.')).toBe(true);
    expect(c.nextStep.startsWith('Engineering builds the MVP in https://github.com/example-owner/')).toBe(true);
    const b = parseInitiativeStatus('x', read('initiatives', 'status-sample-3.md'));
    expect(b.nextStep.startsWith('The CoS records the decision')).toBe(true);
    expect(b.stateText.length).toBeGreaterThan(0);
  });

  it('reads paused and done (synthetic) and keeps only the first paragraph', () => {
    const p = parseInitiativeStatus('p', read('initiatives', 'status-synthetic-paused.md'));
    expect(p.state).toBe('paused');
    expect(p.updated).toBe('2026-10-20');
    expect(p.goal).toBe('First paragraph of the goal. It continues on a second line.');
    expect(p.stateText).toBe(''); // no "## State" section
    expect(parseInitiativeStatus('s', '# T\n\n## State\nFirst line\nsecond line.\n\nSecond paragraph.\n\n## Next step\nGo.').stateText).toBe('First line second line.');
    expect(parseInitiativeStatus('d', read('initiatives', 'status-synthetic-done.md')).state).toBe('done');
  });

  it('never throws and gives unknown for bad input', () => {
    expect(parseInitiativeStatus('a', '')).toEqual({
      slug: 'a', title: '', state: 'unknown', updated: null, goal: '', stateText: '', nextStep: '',
    });
    expect(parseInitiativeStatus('a', '---\nstate: weird\n: : :\n---\n# T').state).toBe('unknown');
    expect(parseInitiativeStatus('a', '---\nstate: weird\n---\n# T')).toMatchObject({ state: 'unknown', title: 'T' });
    expect(parseInitiativeStatus('a', '# Only title').title).toBe('Only title');
  });
});

describe('parseTodo', () => {
  const todo = read('todo', 'todo-sample.md');

  it('reads the open items with urgency, status and since, and ignores the Done section', () => {
    expect(parseTodo(todo)).toEqual([
      { code: 'ACME-T3', kind: 'T', urgency: 'high', text: 'Review the vendor contract', status: 'waiting on Legal', since: '2026-01-10', escalate: false, action: 'do' },
      { code: 'ACME-T4', kind: 'T', urgency: 'normal', text: 'Reply to the beta tester about the export bug', status: null, since: '2026-01-14', escalate: false, action: 'do' },
    ]);
  });
  it('an empty Open section is none, a missing one is empty', () => {
    expect(parseTodo('## Open\n- none\n\n## Done (last 7 days)\n- ACME-T1 [low]: x (done 2026-01-01)\n')).toEqual([]);
    expect(parseTodo('# CEO todo list\n')).toEqual([]);
    expect(parseTodo('')).toEqual([]);
  });
  it('urgency is optional and a status without since is kept', () => {
    expect(parseTodo('## Open\n- ACME-T7: Call the printer. Status: on hold\n')).toEqual([
      { code: 'ACME-T7', kind: 'T', urgency: null, text: 'Call the printer', status: 'on hold', since: null, escalate: false, action: 'do' },
    ]);
  });
  it('a line that does not match is unparsed, and A or D codes are not todo items', () => {
    expect(parseTodo('## Open\n- just a note\n- ACME-A1 [low] {do}: not a todo (since 2026-01-01)\n')).toEqual([
      { unparsed: '- just a note' },
      { unparsed: '- ACME-A1 [low] {do}: not a todo (since 2026-01-01)' },
    ]);
  });
  it('an indented continuation line joins the previous item, also an unparsed one', () => {
    const r = parseTodo('## Open\n- ACME-T5 [low]: Send the invoice\n  to the accountant. Status: drafted\n  by Friday (since 2026-01-02)\n- odd line\n  more\n') as WaitingItem[];
    expect(r[0]).toMatchObject({ code: 'ACME-T5', text: 'Send the invoice to the accountant', status: 'drafted by Friday', since: '2026-01-02' });
    expect(r[1]).toEqual({ unparsed: '- odd line more' });
  });
  it('reads CRLF files', () => {
    const r = parseTodo(todo.replace(/\n/g, '\r\n')) as WaitingItem[];
    expect(r.map((x) => x.code)).toEqual(['ACME-T3', 'ACME-T4']);
    expect(r[0].status).toBe('waiting on Legal');
    expect(r[1].since).toBe('2026-01-14');
  });
});

describe('parent and child items (plugin schemas state/1 and todo/1)', () => {
  const w = parseWaiting(read('state', 'state-synthetic-children.md'));
  const parsed = w as WaitingItem[];
  const by = (code: string) => parsed.find((x) => 'code' in x && x.code === code) as WaitingItem;

  it('keeps document order: a parent, then its children', () => {
    expect(w.map((e) => ('unparsed' in e ? 'unparsed' : e.code))).toEqual([
      'ACME-A7', 'ACME-A8', 'ACME-D5', 'ACME-D3', 'ACME-A9', 'ACME-A10', 'ACME-A11', 'ACME-A12', 'ACME-D4', 'unparsed', 'ACME-A13',
    ]);
  });
  it('a child names its parent, a top-level item does not', () => {
    expect(by('ACME-A8')).toMatchObject({ parent: 'ACME-A7', kind: 'A', action: 'ok', urgency: 'normal', since: '2026-01-12' });
    expect(by('ACME-D5')).toMatchObject({ parent: 'ACME-A7', kind: 'D', action: 'decide', since: '2026-01-13' });
    expect(by('ACME-A9')).toMatchObject({ parent: 'ACME-D3', action: 'do', urgency: 'low' });
    expect(by('ACME-A7').parent).toBeUndefined();
    expect(by('ACME-D3').parent).toBeUndefined();
  });
  it('a {wait} parent has the wait action, also a D one, and a text without the since date', () => {
    expect(by('ACME-D3')).toMatchObject({ kind: 'D', action: 'wait', text: 'pricing model decided (decision 0012); follow-ups below', since: '2026-01-10' });
    expect(by('ACME-D4')).toMatchObject({ action: 'wait' });
  });
  it('a continuation line joins the child above it', () => {
    expect(by('ACME-A9').text).toBe('update the price in the store console, Pricing > Edit then check the preview');
    expect(by('ACME-A9').since).toBe('2026-01-15');
  });
  it('a wrongly indented child (three or four spaces) shows as a top-level item', () => {
    expect(by('ACME-A11').parent).toBeUndefined();
    expect(by('ACME-A12').parent).toBeUndefined();
    expect(by('ACME-A11').text).toBe('indented by three spaces, so top-level');
  });
  it('a two-space line without the item pattern joins the line above, nothing is lost', () => {
    const r = parseWaiting('## Waiting on the CEO\n- ACME-A1 [low] {do}: parent (since 2026-01-01)\n  - a nested note with no code\n') as WaitingItem[];
    expect(r).toHaveLength(1);
    expect(r[0].text).toBe('parent (since 2026-01-01) - a nested note with no code');
  });
  it('a child under an unparsed line is a top-level item', () => {
    expect(w[9]).toEqual({ unparsed: '- this line has no code at all' });
    expect(by('ACME-A13').parent).toBeUndefined();
  });
  it('an orphan child at the start is a top-level item, later children keep their parent', () => {
    const r = parseWaiting(read('state', 'state-synthetic-orphan.md')) as WaitingItem[];
    expect(r.map((x) => [x.code, x.parent])).toEqual([
      ['ACME-A1', undefined], ['ACME-A2', undefined], ['ACME-A3', 'ACME-A2'], ['ACME-A4', 'ACME-A2'],
    ]);
  });
  it('items without children parse as before, with no parent key', () => {
    expect(by('ACME-A10')).toEqual({ code: 'ACME-A10', kind: 'A', urgency: 'low', text: 'plain item with no children', since: '2026-01-14', escalate: false, action: 'do' });
  });
  it('the sample files have no parent', () => {
    expect(items('state-synthetic-mixed.md').every((x) => !('parent' in x))).toBe(true);
  });
  it('reads CRLF files', () => {
    const r = parseWaiting(read('state', 'state-synthetic-children.md').replace(/\n/g, '\r\n')) as WaitingItem[];
    expect(r[1]).toMatchObject({ code: 'ACME-A8', parent: 'ACME-A7' });
  });

  describe('company/todo.md', () => {
    const r = parseTodo(read('todo', 'todo-children.md')) as WaitingItem[];
    it('open children name their parent; Done is not read', () => {
      expect(r.map((x) => [x.code, x.parent])).toEqual([
        ['ACME-T3', undefined], ['ACME-T6', 'ACME-T3'], ['ACME-T7', 'ACME-T3'], ['ACME-T4', undefined], ['ACME-T8', undefined],
      ]);
    });
    it('a child keeps its status and since date', () => {
      expect(r[2]).toEqual({ code: 'ACME-T7', kind: 'T', urgency: 'low', text: 'Send the draft to the board', status: 'after T6', since: '2026-01-12', escalate: false, action: 'do', parent: 'ACME-T3' });
    });
  });
});
