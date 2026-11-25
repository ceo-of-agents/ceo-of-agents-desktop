import { describe, expect, it } from 'vitest';
import { chartChangeMessage, cosClick, departmentClick, modelName, nextChartNode, nodeAccessibleName, nodeStatus, statusWords, workerModels } from '../../src/renderer/org-chart-logic';
import { parseOrgChart } from '../../src/main/hq/org-chart';
import type { OrgChartLive, TabInfo } from '../../src/shared/types';

const tab = (tabId: string, patch: Partial<TabInfo> = {}): TabInfo => ({
  tabId, orgId: 'o', agent: 'max', persona: 'Max', role: 'R', status: 'open', openedAt: '', closedAt: null, notePath: null, pendingWork: false, ...patch,
});
const live = (openTabId: string | null): OrgChartLive => ({ cos: { busy: false, handoffsWaiting: 0 }, departments: { eng: { running: false, openTabId, handingOver: false, handoffWaiting: false } } });
const d = { id: 'eng', agent: 'max' };

describe('org chart clicks', () => {
  it('the CoS selects its thread', () => expect(cosClick()).toEqual({ kind: 'cos' }));
  it('a department without an open chat starts one', () => {
    expect(departmentClick(d, live(null), [])).toEqual({ kind: 'start', agent: 'max' });
    expect(departmentClick(d, null, [])).toEqual({ kind: 'start', agent: 'max' });
  });
  it('an open chat is focused', () => expect(departmentClick(d, live('t1'), [tab('t1')])).toEqual({ kind: 'focus', tabId: 't1' }));
  it('a stale open tab id that is no longer known starts a new chat', () => expect(departmentClick(d, live('gone'), [])).toEqual({ kind: 'start', agent: 'max' }));
});

describe('nodeStatus: one status, the highest of the order', () => {
  it('agent file missing beats handing over, handoff waiting, working and chat open', () => {
    expect(nodeStatus({ agentMissing: true, handingOver: true, handoffWaiting: true, working: true, chatOpen: true })).toBe('agentMissing');
    expect(nodeStatus({ handingOver: true, handoffWaiting: true, working: true, chatOpen: true })).toBe('handingOver');
    expect(nodeStatus({ handoffWaiting: true, working: true, chatOpen: true })).toBe('handoffWaiting');
    expect(nodeStatus({ working: true, chatOpen: true })).toBe('working');
    expect(nodeStatus({ chatOpen: true })).toBe('chatOpen');
    expect(nodeStatus({})).toBeNull();
  });
  it('the words: one handoff, many handoffs, plain statuses', () => {
    expect(statusWords('working')).toBe('Working');
    expect(statusWords('handingOver')).toBe('Handing over');
    expect(statusWords('chatOpen')).toBe('Chat open');
    expect(statusWords('agentMissing')).toBe('Agent file missing');
    expect(statusWords('handoffWaiting')).toBe('Handoff waiting');
    expect(statusWords('handoffWaiting', 1)).toBe('1 handoff waiting');
    expect(statusWords('handoffWaiting', 3)).toBe('3 handoffs waiting');
  });
});

describe('model names', () => {
  it('capitalised as in the pickers, a specific id as its label, nothing for none', () => {
    expect(modelName('opus')).toBe('Opus');
    expect(modelName('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelName(null)).toBe('');
    expect(workerModels([{ name: 'a', model: 'sonnet', description: '' }, { name: 'b', model: 'sonnet', description: '' }])).toBe('Sonnet');
    expect(workerModels([{ name: 'a', model: 'sonnet', description: '' }, { name: 'b', model: 'haiku', description: '' }, { name: 'c', model: null, description: '' }])).toBe('Sonnet, Haiku');
  });
});

describe('nodeAccessibleName', () => {
  it('name, role, model, status and the helpers with their model', () => {
    expect(nodeAccessibleName({ name: 'Max', role: 'Engineering', model: 'opus', status: 'Working', workers: [{ name: 'reader', model: 'sonnet', description: '' }, { name: 'worker', model: 'sonnet', description: '' }] })).toBe(
      'Max, Engineering, Opus, working. Helpers: reader, worker, Sonnet.',
    );
  });
  it('leaves out what is missing: no role, no status, no helpers', () => {
    expect(nodeAccessibleName({ name: 'Nora', model: 'opus' })).toBe('Nora, Opus');
    expect(nodeAccessibleName({ name: 'You', role: 'CEO', status: '2 waiting on you' })).toBe('You, CEO, 2 waiting on you');
    expect(nodeAccessibleName({ name: 'Nora', model: 'opus', status: 'Agent file missing' })).toBe('Nora, Opus, agent file missing');
  });
});

describe('nextChartNode: keyboard navigation', () => {
  const ids = ['a', 'b', 'c'];
  it('Up goes to the parent, Down to the first child', () => {
    expect(nextChartNode('ArrowUp', 'dept:b', ids)).toBe('cos');
    expect(nextChartNode('ArrowUp', 'cos', ids)).toBe('ceo');
    expect(nextChartNode('ArrowUp', 'ceo', ids)).toBe('ceo');
    expect(nextChartNode('ArrowDown', 'ceo', ids)).toBe('cos');
    expect(nextChartNode('ArrowDown', 'cos', ids)).toBe('dept:a');
    expect(nextChartNode('ArrowDown', 'cos', [])).toBe('cos');
    expect(nextChartNode('ArrowDown', 'dept:b', ids)).toBe('dept:b');
  });
  it('Left and Right move between siblings and wrap at both ends', () => {
    expect(nextChartNode('ArrowRight', 'dept:a', ids)).toBe('dept:b');
    expect(nextChartNode('ArrowRight', 'dept:c', ids)).toBe('dept:a');
    expect(nextChartNode('ArrowLeft', 'dept:a', ids)).toBe('dept:c');
    expect(nextChartNode('ArrowLeft', 'dept:c', ids)).toBe('dept:b');
    expect(nextChartNode('ArrowRight', 'cos', ids)).toBe('cos');
    expect(nextChartNode('ArrowLeft', 'ceo', ids)).toBe('ceo');
  });
  it('Home goes to the CEO, End to the last department (the CoS when there is none)', () => {
    expect(nextChartNode('Home', 'dept:b', ids)).toBe('ceo');
    expect(nextChartNode('End', 'ceo', ids)).toBe('dept:c');
    expect(nextChartNode('End', 'ceo', [])).toBe('cos');
  });
  it('other keys are not the chart\'s', () => {
    expect(nextChartNode('a', 'cos', ids)).toBeNull();
    expect(nextChartNode('Tab', 'cos', ids)).toBeNull();
    expect(nextChartNode('Enter', 'cos', ids)).toBeNull();
  });
});

describe('chartChangeMessage: what the polite live region says', () => {
  const org = (extra: string, model = 'opus') =>
    parseOrgChart(`cos:\n  display_name: Ada\nmodels:\n  cos: ${model}\ndepartments:\n  - {id: eng, agent: max, display_name: Max}\n${extra}`, []);
  it('a department added, removed, renamed, a model changed', () => {
    const a = org('');
    expect(chartChangeMessage(a, org('  - {id: des, agent: lena, display_name: Nora}\n'))).toBe('Org chart updated: Nora added.');
    expect(chartChangeMessage(org('  - {id: des, agent: lena, display_name: Nora}\n'), a)).toBe('Org chart updated: Nora removed.');
    expect(chartChangeMessage(a, parseOrgChart('cos:\n  display_name: Ada\nmodels:\n  cos: opus\ndepartments:\n  - {id: eng, agent: max, display_name: Maxine}\n', []))).toBe('Org chart updated: Max is now Maxine.');
    expect(chartChangeMessage(a, org('', 'sonnet'))).toBe('Org chart updated: Ada now runs on Sonnet.');
  });
  it('nothing visible changed, first load or an error: no message', () => {
    const a = org('');
    expect(chartChangeMessage(a, org(''))).toBe('');
    expect(chartChangeMessage(null, a)).toBe('');
    expect(chartChangeMessage(a, { ...a, error: 'x' })).toBe('');
  });
});
