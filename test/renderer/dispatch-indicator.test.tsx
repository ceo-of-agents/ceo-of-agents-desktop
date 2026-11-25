import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import path from 'node:path';
import { DepartmentDispatches, DepartmentDispatchLine, HelpersDispatchLine } from '../../src/renderer/DispatchIndicator';
import { OrgChart, type OrgChartProps } from '../../src/renderer/OrgChart';
import { SidePanel } from '../../src/renderer/SidePanel';
import { Toasts } from '../../src/renderer/Toasts';
import { readOrgChart } from '../../src/main/hq/org-chart';
import type { Dispatch, OrgChartLive } from '../../src/shared/types';

const NOW = Date.parse('2026-11-18T10:10:00Z');
const at = (s: number): string => new Date(NOW - s * 1000).toISOString();
const d = (id: string, patch: Partial<Dispatch> = {}): Dispatch => ({
  id, agent: 'max', departmentId: 'engineering', name: 'Max', description: 'Fix the CI', background: true, state: 'running',
  startedAt: at(125), lastActivityAt: at(5), endedAt: null, ...patch,
});
beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const text = (html: string): string => html.replace(/<[^>]+>/g, '');

describe('DepartmentDispatches (side panel lines)', () => {
  it('running: the pulsing dot, the words and the elapsed time as real text', () => {
    const h = renderToStaticMarkup(<DepartmentDispatches dispatches={[d('a')]} name="Max" cosName="Ada" />);
    expect(h).toContain('aria-label="Tasks dispatched to Max"');
    expect(h).toContain('tab-dot dp-pulse');
    expect(text(h)).toBe('Working: Fix the CI · 2 min 5 s');
    expect(h).not.toContain('<button');
  });
  it('done: a static mark (no pulse) and the duration', () => {
    const h = renderToStaticMarkup(<DepartmentDispatches dispatches={[d('a', { state: 'done', endedAt: at(30), startedAt: at(105) })]} name="Max" cosName="Ada" />);
    expect(h).not.toContain('dp-pulse');
    expect(h).toContain('data-state="done"');
    expect(text(h)).toBe('Done: Fix the CI · 1 min 15 s');
  });
  it('two in parallel: one line each, oldest first', () => {
    const h = renderToStaticMarkup(<DepartmentDispatches dispatches={[d('b', { description: 'Newer', startedAt: at(20) }), d('a')]} name="Max" cosName="Ada" />);
    expect((h.match(/<li /g) ?? []).length).toBe(2);
    expect(text(h)).toBe('Working: Fix the CI · 2 min 5 sWorking: Newer · 20 s');
  });
  it('unknown: "Unknown" and no time', () => {
    const h = renderToStaticMarkup(<DepartmentDispatches dispatches={[d('a', { state: 'unknown' })]} name="Max" cosName="Ada" />);
    expect(text(h)).toBe('?Unknown: Fix the CI'); // the ? is the mark (aria-hidden), the words follow
    expect(h).toContain('data-state="unknown"');
  });
  it('nothing for no dispatches', () => {
    expect(renderToStaticMarkup(<DepartmentDispatches dispatches={[]} name="Max" cosName="Ada" />)).toBe('');
  });
});

describe('node lines', () => {
  it('a department node line, and "n tasks working" for several', () => {
    expect(text(renderToStaticMarkup(<DepartmentDispatchLine dispatches={[d('a')]} />))).toBe('Fix the CI · 2 min 5 s');
    expect(text(renderToStaticMarkup(<DepartmentDispatchLine dispatches={[d('a', { state: 'done', endedAt: at(3), startedAt: at(63) })]} />))).toBe('Done: Fix the CI · 1 min 0 s');
    const many = renderToStaticMarkup(<DepartmentDispatchLine dispatches={[d('a'), d('b', { startedAt: at(10) })]} />);
    expect(text(many)).toBe('2 tasks working · 2 min 5 s');
    expect(many).toContain('class="oc-status dp-status"');
  });
  it('the helpers line counts running helpers only', () => {
    const helper = (id: string, patch: Partial<Dispatch> = {}) => d(id, { departmentId: null, agent: 'reader', name: 'reader', ...patch });
    expect(text(renderToStaticMarkup(<HelpersDispatchLine dispatches={[helper('h1', { startedAt: at(20) }), helper('h2', { startedAt: at(40) })]} />))).toBe('2 helpers working · 40 s');
    expect(renderToStaticMarkup(<HelpersDispatchLine dispatches={[helper('h1', { state: 'done', endedAt: at(1) })]} />)).toBe('');
  });
});

const chart = readOrgChart(path.join(__dirname, '..', 'fixtures', 'org-chart', 'coa'), new Date('2026-11-18T10:42:00'));
const noop = () => undefined;
const live: OrgChartLive = {
  cos: { busy: true, handoffsWaiting: 0 },
  departments: {
    engineering: { running: true, openTabId: 't1', handingOver: false, handoffWaiting: false },
    'design-brand': { running: false, openTabId: null, handingOver: false, handoffWaiting: true },
  },
};
const props = (over: Partial<OrgChartProps> = {}): OrgChartProps => ({
  chart, live, cosName: 'Ada', orgPath: '/hq', waitingCount: 2, roles: { engineering: 'Engineering', 'design-brand': 'Design and brand' }, tabs: [], askFixPending: false,
  onAskFix: noop, onCos: noop, onCeo: noop, onDepartment: noop, onChat: noop, ...over,
});
const html = (over: Partial<OrgChartProps> = {}) => renderToStaticMarkup(<OrgChart {...props(over)} />);

describe('the org chart node', () => {
  it('shows the dispatch on the department node, in its accessible name, instead of the other statuses', () => {
    const h = html({ dispatches: [d('a')] });
    expect(h).toContain('aria-label="Max, Engineering, Opus, working: Fix the CI. Helpers: reader, worker, Sonnet."');
    expect(h).toContain('<span class="dp-before"></span><span class="dp-desc">Fix the CI</span><span class="dp-after"> · 2 min 5 s</span>');
  });
  it('two tasks for one department: "2 tasks working" in the name and on the line', () => {
    const h = html({ dispatches: [d('a'), d('b', { description: 'Other', startedAt: at(30) })] });
    expect(h).toContain('aria-label="Max, Engineering, Opus, 2 tasks working.');
    expect(h).toContain('2 tasks working</span><span class="dp-after"> · 2 min 5 s</span>');
  });
  it('agent file missing comes first', () => {
    const broken = { ...chart, departments: [{ ...chart.departments[0], agentFile: { found: false, name: null, model: null } }, chart.departments[1]] };
    const h = html({ chart: broken, dispatches: [d('a')] });
    expect(h).toContain('aria-label="Max, Engineering, Opus, agent file missing"');
    expect(h).not.toContain('Fix the CI');
  });
  it('a department without a dispatch keeps its own status (handoff waiting)', () => {
    const h = html({ dispatches: [d('a')] });
    expect(h).toContain('aria-label="Lena, Design and brand, Opus, handoff waiting. Helpers: reader, Sonnet."');
  });
  it('helpers show only on the chief of staff node, never as a department', () => {
    const helper = d('h', { departmentId: null, agent: 'reader', name: 'reader', description: 'Read logs', startedAt: at(20) });
    const h = html({ dispatches: [helper] });
    expect(h).toContain('aria-label="Ada, Chief of staff, Opus, 1 helper working. Helpers: reader, worker, Sonnet."');
    expect(h).toContain('1 helper working</span><span class="dp-after"> · 20 s</span>');
    expect(h).toContain('aria-label="Max, Engineering, Opus, working. Helpers: reader, worker, Sonnet."');
    expect(h).not.toContain('Read logs');
  });
  it('a handoff waiting for the chief of staff has priority over its helpers', () => {
    const helper = d('h', { departmentId: null, agent: 'reader', name: 'reader', startedAt: at(20) });
    const h = html({ dispatches: [helper], live: { ...live, cos: { busy: true, handoffsWaiting: 1 } } });
    expect(h).toContain('aria-label="Ada, Chief of staff, Opus, 1 handoff waiting.');
    expect(h).not.toContain('1 helper working');
  });
  it('nothing changes without dispatches', () => {
    expect(html()).toBe(html({ dispatches: [] }));
    expect(html()).not.toContain('dp-status');
  });
});

describe('the side panel row', () => {
  const panel = (dispatches: Dispatch[]) =>
    renderToStaticMarkup(
      <SidePanel
        orgId="o1" cosName="Ada" waiting={[]} initiatives={[]} departments={[{ id: 'engineering', agent: 'max', persona: 'Max', role: 'Engineering' }, { id: 'design-brand', agent: 'lena', persona: 'Lena', role: 'Design and brand' }]}
        tabs={[]} busyTabIds={[]} cosBusy={false} cosTurnStartedAt={null} hidden={false}
        onAnswer={noop} onChat={noop} onOpenChart={noop} looks={{}} revealWaiting={0} dispatches={dispatches}
      />,
    );
  it('lists each dispatch under its own department row, none under the others', () => {
    const h = panel([d('a'), d('b', { description: 'Other' }), d('c', { departmentId: 'design-brand', name: 'Lena', description: 'Draw', state: 'done', endedAt: at(3), startedAt: at(40) })]);
    expect((h.match(/class="dp-list"/g) ?? []).length).toBe(2);
    expect(h).toContain('aria-label="Tasks dispatched to Max"');
    expect(h).toContain('aria-label="Tasks dispatched to Lena"');
    expect(h).toContain('Fix the CI');
    expect(h).toContain('Other');
    expect(h).toContain('Done: ');
  });
  it('helpers are not a department row', () => {
    const h = panel([d('h', { departmentId: null, agent: 'reader', name: 'reader', description: 'Read logs' })]);
    expect(h).not.toContain('dp-list');
    expect(h).not.toContain('Read logs');
  });
});

describe('the toast button', () => {
  it('a toast with an action has a real button named by the action label; a plain one has none', () => {
    const h = renderToStaticMarkup(
      <Toasts
        notices={[{ id: 1, orgId: 'o1', text: 'Max finished: Fix the CI', action: { kind: 'focus-cos', label: "Open Ada's thread" } }, { id: 2, orgId: 'o1', text: 'Plain' }]}
        onDone={noop}
        onAction={noop}
      />,
    );
    expect(h).toContain('Max finished: Fix the CI');
    expect((h.match(/<button/g) ?? []).length).toBe(1);
    expect(h).toContain('aria-label="Open Ada&#x27;s thread"');
    expect(h).toContain('class="toast has-action"');
    expect(h).toContain('<div class="toast" role="status">Plain</div>');
  });
});
