import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import path from 'node:path';
import { OrgChart, clockTime, type OrgChartProps } from '../../src/renderer/OrgChart';
import { DeptTile } from '../../src/renderer/DeptTile';
import { readOrgChart } from '../../src/main/hq/org-chart';
import type { OrgChartLive } from '../../src/shared/types';

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

describe('OrgChart', () => {
  it('shows the CEO, the CoS and the departments as tree items with their accessible names', () => {
    const h = html();
    expect(h).toContain('role="tree"');
    for (const label of [
      'You, CEO, 2 waiting on you',
      'Ada, Chief of staff, Opus, working. Helpers: reader, worker, Sonnet.',
      'Max, Engineering, Opus, working. Helpers: reader, worker, Sonnet.',
      'Lena, Design and brand, Opus, handoff waiting. Helpers: reader, Sonnet.',
    ]) expect(h).toContain(`aria-label="${label}"`);
    expect((h.match(/role="treeitem"/g) ?? []).length).toBe(4);
  });

  it('roving tabindex: only the chief of staff is a tab stop at first', () => {
    const h = html();
    expect((h.match(/role="treeitem"[^>]*tabindex="0"/g) ?? []).length).toBe(1);
    expect(h).toMatch(/aria-label="Ada, [^"]*"[^>]*tabindex="0"/);
  });

  it('chips for the CoS and for each department that has the Agent tool, with the models', () => {
    const h = html();
    expect((h.match(/class="chip"/g) ?? []).length).toBe(2 + 2 + 1 + 0);
    expect(h).toContain('>Sonnet<');
  });

  it('the legend names the chief of staff, and the update time has the file as its tooltip source', () => {
    const h = html();
    expect(h).toContain('You talk to Ada. Ada briefs the departments.');
    expect(h).toContain('A department chat ends with a handoff: a note in the hq inbox that Ada picks up.');
    expect(h).toContain('Helpers each agent can hand tasks to, and the model they run on.');
    expect(h).toContain('Read from org.yaml · updated 10:42');
  });

  it('persona equals role leaves the role line empty', () => {
    const h = html({ roles: { engineering: 'Max', 'design-brand': 'Design and brand' } });
    expect(h).toContain('aria-label="Max, Opus, working. Helpers: reader, worker, Sonnet."');
  });

  it('no departments: the placeholder and the shorter first legend line', () => {
    const h = html({ chart: { ...chart, departments: [] }, live: null });
    expect(h).toContain('No departments yet');
    expect(h).toContain('Ada does the work for now. Ask Ada to add a department when one kind of work keeps coming back.');
    expect(h).toContain('You talk to Ada.</span>');
    expect(h).not.toContain('briefs the departments');
  });

  it('a department without an agent file says so and keeps the fix in its menu, not a click', () => {
    const broken = { ...chart, departments: [{ ...chart.departments[0], agentFile: { found: false, name: null, model: null } }] };
    const h = html({ chart: broken });
    expect(h).toContain('Agent file missing');
    expect(h).toContain('aria-label="Max, Engineering, Opus, agent file missing"');
    expect(h).toContain('data-inert="true"');
  });

  it('a department whose agent file is missing shows no chip row, even when the chart still holds chips from an earlier read', () => {
    const broken = { ...chart, departments: [{ ...chart.departments[0], agentFile: { found: false, name: null, model: null } }, chart.departments[1]] };
    expect(broken.departments[0].workers.length).toBeGreaterThan(0);
    const h = html({ chart: broken });
    // the CoS chips (2, in the off-screen measuring copy) and Lena's (1); none for Max
    expect((h.match(/class="oc-chips"/g) ?? []).length).toBe(1);
    expect((h.match(/class="chip"/g) ?? []).length).toBe(2 + 1);
    expect(h).not.toContain('stub-0');
  });

  it('first-load error: the plate with the sentence, the detail and the action, no chart', () => {
    const h = html({ chart: { ...chart, departments: [], error: 'Line 23: bad indentation' }, live: null });
    expect(h).toContain('Could not read org.yaml.');
    expect(h).toContain('Line 23: bad indentation');
    expect(h).toContain('Ask Ada to fix it');
    expect(h).not.toContain('role="tree"');
  });

  it('stale error: the last good chart stays under a pinned plate with the time', () => {
    const h = html({ chart: { ...chart, staleError: 'Line 23: bad indentation' } });
    expect(h).toContain('Could not read org.yaml. Showing the org as of 10:42.');
    expect(h).toContain('Ask Ada to fix it');
    expect(h).toContain('role="tree"');
  });

  it('the fix button shows the sent state while the request is pending', () => {
    const h = html({ chart: { ...chart, departments: [], error: 'x' }, live: null, askFixPending: true });
    expect(h).toContain('aria-busy="true"');
  });

  it('shows a loading line before the chart arrives', () => {
    expect(html({ chart: null })).toContain('Loading the org chart.');
  });

  it('nothing waiting reads "Nothing waiting"', () => {
    expect(html({ waitingCount: 0 })).toContain('Nothing waiting');
  });

  it('the CEO avatar holds the initial only when the display name is set', () => {
    expect(html()).toContain('<span class="oc-avatar ceo" aria-hidden="true"></span>');
    expect(html({ chart: { ...chart, ceo: { roleId: 'ceo', displayName: 'Zoe' } } })).toContain('<span class="oc-avatar ceo" aria-hidden="true">Z</span>');
  });
});

describe('clockTime', () => {
  it('formats hh:mm and tolerates nothing', () => {
    expect(clockTime('2026-11-18T10:42:00')).toBe('10:42');
    expect(clockTime(null)).toBe('');
    expect(clockTime('nope')).toBe('');
  });
});

describe('DeptTile', () => {
  it('icon and colour from the look file, initials otherwise', () => {
    const icon = renderToStaticMarkup(<DeptTile name="Lena" look={{ icon: 'pen-tool', colour: 'pink' }} size="chart" />);
    expect(icon).toContain('data-colour="pink"');
    expect(icon).toContain('<svg');
    expect(icon).not.toContain('>LE<');
    const plain = renderToStaticMarkup(<DeptTile name="Lena" look={null} size="panel" />);
    expect(plain).toContain('data-colour="neutral"');
    expect(plain).toContain('>LE<');
    expect(renderToStaticMarkup(<DeptTile name="Lena" look={{ icon: null, colour: 'blue' }} size="chart" />)).toContain('data-colour="blue"');
  });
});
