import { describe, expect, it } from 'vitest';
import type { PermissionRequest, TabInfo, ThreadEntry, ThreadInfo } from '../../src/shared/types';
import { initialState, permissionsFor, reducer, threadKey, type Action, type AppState } from '../../src/renderer/logic';

const run = (actions: Action[], from: AppState = initialState) => actions.reduce(reducer, from);
const entry = (id: string, kind: ThreadEntry['kind'] = 'assistant'): ThreadEntry => ({ id, kind, author: 'Ada', text: id, time: '2026-11-17T10:00:00Z' });
const K = threadKey('o1', 'cos');
const loaded = (entries: ThreadEntry[] = []): ThreadInfo => ({
  orgId: 'o1', threadId: 'cos', busy: false, handoffsWaiting: 0, title: 'Ada (Chief of Staff)', speaker: 'Ada', entries, streaming: '',
});

describe('thread events', () => {
  it('appends deltas and clears streaming when the assistant entry arrives', () => {
    const s = run([
      { type: 'thread-delta', orgId: 'o1', threadId: 'cos', text: 'Hel' },
      { type: 'thread-delta', orgId: 'o1', threadId: 'cos', text: 'lo' },
    ]);
    expect(s.threads[K].streaming).toBe('Hello');
    const s2 = reducer(s, { type: 'thread-entry', orgId: 'o1', threadId: 'cos', entry: entry('e1') });
    expect(s2.threads[K].streaming).toBe('');
    expect(s2.threads[K].entries).toHaveLength(1);
  });
  it('keeps streaming when a non-assistant entry arrives', () => {
    const s = run([
      { type: 'thread-delta', orgId: 'o1', threadId: 'cos', text: 'abc' },
      { type: 'thread-entry', orgId: 'o1', threadId: 'cos', entry: entry('t1', 'tool') },
    ]);
    expect(s.threads[K].streaming).toBe('abc');
  });
  it('ignores a duplicate entry id', () => {
    const e = entry('e1');
    const s = run([
      { type: 'thread-entry', orgId: 'o1', threadId: 'cos', entry: e },
      { type: 'thread-entry', orgId: 'o1', threadId: 'cos', entry: e },
    ]);
    expect(s.threads[K].entries).toHaveLength(1);
  });
  it('stores threads of other orgs separately', () => {
    const s = run([{ type: 'thread-entry', orgId: 'o2', threadId: 'cos', entry: entry('e1') }]);
    expect(s.threads[threadKey('o2', 'cos')].entries).toHaveLength(1);
    expect(s.threads[K]).toBeUndefined();
  });
  it('merges a loaded thread with entries that arrived before it', () => {
    const s = run([
      { type: 'thread-entry', orgId: 'o1', threadId: 'cos', entry: entry('new') },
      { type: 'thread-loaded', info: loaded([entry('old'), entry('new')]) },
    ]);
    expect(s.threads[K].entries.map((e) => e.id)).toEqual(['old', 'new']);
    expect(s.threads[K].title).toBe('Ada (Chief of Staff)');
  });
  it('applies thread-state and clears streaming when idle', () => {
    const s = run([
      { type: 'thread-delta', orgId: 'o1', threadId: 'cos', text: 'x' },
      { type: 'thread-state', state: { orgId: 'o1', threadId: 'cos', busy: false, handoffsWaiting: 1 } },
    ]);
    expect(s.threads[K]).toMatchObject({ busy: false, handoffsWaiting: 1, streaming: '' });
  });
});

describe('permissions', () => {
  const req = (id: string, threadId: PermissionRequest['threadId'] = 'cos'): PermissionRequest => ({
    requestId: id, orgId: 'o1', threadId, toolName: 'Write', input: {}, summary: 's', rule: 'Write(x)',
  });
  it('adds, scopes by thread and removes', () => {
    let s = run([
      { type: 'permission', request: req('r1') },
      { type: 'permission', request: req('r1') },
      { type: 'permission', request: req('r2', 'tab:t1') },
    ]);
    expect(permissionsFor(s, 'o1', 'cos').map((p) => p.requestId)).toEqual(['r1']);
    expect(permissionsFor(s, 'o1', 'tab:t1')).toHaveLength(1);
    s = reducer(s, { type: 'permission-resolved', requestId: 'r1' });
    expect(permissionsFor(s, 'o1', 'cos')).toHaveLength(0);
  });
});

describe('tabs and orgs', () => {
  const tab = (status: TabInfo['status']): TabInfo => ({ tabId: 't1', orgId: 'o1', agent: 'max', persona: 'Max', role: 'Engineering', status, openedAt: '2026-11-17T10:00:00Z', closedAt: null, notePath: null, pendingWork: false });
  it('replaces tabs and upserts one', () => {
    let s = run([{ type: 'tabs', orgId: 'o1', tabs: [tab('open')] }]);
    s = reducer(s, { type: 'tab-upsert', tab: tab('handing-over') });
    expect(s.orgData.o1.tabs).toHaveLength(1);
    expect(s.orgData.o1.tabs[0].status).toBe('handing-over');
  });
  it('tracks orgs and active org', () => {
    const s = run([{ type: 'orgs', orgs: [], activeOrgId: 'o1' }]);
    expect(s.loaded).toBe(true);
    expect(s.activeOrgId).toBe('o1');
  });
});

describe('notices', () => {
  it('adds with growing ids and dismisses', () => {
    let s = run([
      { type: 'notice', orgId: null, text: 'a' },
      { type: 'notice', orgId: 'o1', text: 'b' },
    ]);
    expect(s.notices.map((n) => n.id)).toEqual([1, 2]);
    s = reducer(s, { type: 'notice-dismiss', id: 1 });
    expect(s.notices.map((n) => n.text)).toEqual(['b']);
  });
});

describe('reducer: thread activity', () => {
  const state = (busy: boolean, activity?: { startedAt: string; current: string | null; steps: number } | null) =>
    ({ type: 'thread-state', state: { orgId: 'o1', threadId: 'cos', busy, handoffsWaiting: 0, activity } }) as const;
  it('stores the live activity and clears it when idle', () => {
    const live = { startedAt: '2026-11-18T10:00:00.000Z', current: 'Reading a', steps: 2 };
    const s = run([state(true, live)]);
    expect(s.threads[K].activity).toEqual(live);
    const s2 = reducer(s, state(false, null));
    expect(s2.threads[K].activity).toBeNull();
    expect(reducer(s, state(false)).threads[K].activity).toBeNull();
  });
});

describe('per-org settings', () => {
  const settings = { permissionMode: 'plan', effort: 'low' } as never;
  it('keeps settings and the pending flag per org', () => {
    const s = run([
      { type: 'settings', orgId: 'o1', settings },
      { type: 'settings-pending', orgId: 'o1', pending: true },
    ]);
    expect(s.orgData.o1.settings).toBe(settings);
    expect(s.orgData.o1.settingsPending).toBe(true);
    expect(s.orgData.o2?.settings ?? null).toBeNull();
    expect(s.orgData.o2?.settingsPending ?? false).toBe(false);
    expect(reducer(s, { type: 'settings-pending', orgId: 'o1', pending: false }).orgData.o1.settingsPending).toBe(false);
  });
});

describe('thread-state run fields', () => {
  it('copies the chat run info when the state carries it, keeps it otherwise', () => {
    const base = { orgId: 'o1', threadId: 'cos', busy: false, handoffsWaiting: 0 } as const;
    let s = reducer(initialState, { type: 'thread-state', state: { ...base, model: 'opus', effort: 'low', runChoice: { model: null, effort: 'low' }, runPending: true, runDefaults: { model: 'opus', effort: 'high' } } });
    expect(s.threads['o1|cos']).toMatchObject({ model: 'opus', effort: 'low', runPending: true });
    s = reducer(s, { type: 'thread-state', state: base });
    expect(s.threads['o1|cos']).toMatchObject({ model: 'opus', runPending: true });
  });
});

describe('org chart event', () => {
  it('stores the chart per org', () => {
    const chart = { ceo: { roleId: 'ceo', displayName: '' }, cos: { displayName: 'Ada', model: null }, departments: [], workers: { rule: null, types: [] }, tiers: [], problems: [], error: null, staleError: null, readAt: null };
    const s = reducer(initialState, { type: 'org-chart', orgId: 'o', chart });
    expect(s.orgData.o.chart).toBe(chart);
    expect(initialState.orgData.o).toBeUndefined();
  });
});
