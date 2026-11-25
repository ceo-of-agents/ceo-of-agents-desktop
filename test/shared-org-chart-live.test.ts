import { describe, expect, it } from 'vitest';
import { buildOrgChartLive, type ChartThreadState } from '../src/shared/org-chart-live';
import type { TabInfo } from '../src/shared/types';

const dept = [{ id: 'engineering', agent: 'max' }, { id: 'design-brand', agent: 'lena' }];
const tab = (tabId: string, agent: string, patch: Partial<TabInfo> = {}): TabInfo => ({
  tabId, orgId: 'o', agent, persona: agent, role: 'R', status: 'open', openedAt: '2026-01-01T00:00:00Z', closedAt: null, notePath: null, pendingWork: false, ...patch,
});
const threads = (m: Record<string, ChartThreadState>) => (id: string) => m[id];

describe('buildOrgChartLive', () => {
  it('idle org: nothing running, no open chats', () => {
    expect(buildOrgChartLive(dept, [], threads({ cos: { busy: false, handoffsWaiting: 0 } }))).toEqual({
      cos: { busy: false, handoffsWaiting: 0 },
      departments: { engineering: { running: false, openTabId: null, handingOver: false, handoffWaiting: false }, 'design-brand': { running: false, openTabId: null, handingOver: false, handoffWaiting: false } },
    });
  });

  it('CoS busy and handoffs waiting; a missing CoS thread counts as idle', () => {
    expect(buildOrgChartLive([], [], threads({ cos: { busy: true, handoffsWaiting: 2 } })).cos).toEqual({ busy: true, handoffsWaiting: 2 });
    expect(buildOrgChartLive([], [], threads({})).cos).toEqual({ busy: false, handoffsWaiting: 0 });
  });

  it('a department is running when an open chat of its agent is busy', () => {
    const live = buildOrgChartLive(dept, [tab('t1', 'max'), tab('t2', 'lena')], threads({ 'tab:t1': { busy: true } }));
    expect(live.departments.engineering).toEqual({ running: true, openTabId: 't1', handingOver: false, handoffWaiting: false });
    expect(live.departments['design-brand']).toEqual({ running: false, openTabId: 't2', handingOver: false, handoffWaiting: false });
  });

  it('handing over', () => {
    const live = buildOrgChartLive(dept, [tab('t1', 'lena', { status: 'handing-over' })], threads({ 'tab:t1': { busy: true } }));
    expect(live.departments['design-brand']).toEqual({ running: true, openTabId: 't1', handingOver: true, handoffWaiting: false });
  });

  it('closed chats and chats of other agents do not count', () => {
    const live = buildOrgChartLive(dept, [tab('t1', 'max', { status: 'closed' }), tab('t2', 'other')], threads({ 'tab:t1': { busy: true }, 'tab:t2': { busy: true } }));
    expect(live.departments.engineering).toEqual({ running: false, openTabId: null, handingOver: false, handoffWaiting: false });
  });

  it('a department has a handoff waiting while a handoff of one of its chats is queued, even after the chat closed', () => {
    const live = buildOrgChartLive(dept, [tab('t1', 'max', { status: 'closed' }), tab('t2', 'lena')], threads({ cos: { busy: true, handoffsWaiting: 1, handoffTabs: ['t1'] } }));
    expect(live.departments.engineering.handoffWaiting).toBe(true);
    expect(live.departments['design-brand'].handoffWaiting).toBe(false);
  });
});
