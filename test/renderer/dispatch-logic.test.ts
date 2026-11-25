import { describe, expect, it } from 'vitest';
import type { Dispatch } from '../../src/shared/types';
import {
  ACK_AFTER_MS, REPORT_WAIT_MS, departmentNodeDispatch, dispatchElapsedMs, dispatchesOfDepartment, dispatchesToAck, dispatchLineParts, dispatchText, dispatchTip, dispatchTipLines,
  dispatchWords, helpersNodeDispatch, nextAckDelayMs, runningHelpers, syncAckMemory, tabHasRunningDispatches, type AckContext,
} from '../../src/renderer/dispatch-logic';
import { initialState, reducer, type AppState } from '../../src/renderer/logic';

const NOW = Date.parse('2026-11-18T10:10:00Z');
const at = (secondsAgo: number): string => new Date(NOW - secondsAgo * 1000).toISOString();
const d = (id: string, patch: Partial<Dispatch> = {}): Dispatch => ({
  id, agent: 'max', departmentId: 'engineering', name: 'Max', description: 'Fix the CI', background: true, state: 'running',
  startedAt: at(125), lastActivityAt: at(5), endedAt: null, ...patch,
});
const ended = (id: string, state: 'done' | 'failed' | 'stopped', endedSecondsAgo: number, patch: Partial<Dispatch> = {}): Dispatch =>
  d(id, { state, endedAt: at(endedSecondsAgo), startedAt: at(endedSecondsAgo + 75), ...patch });

describe('dispatch text', () => {
  it('a running dispatch: state, description and the elapsed time', () => {
    expect(dispatchText(d('a'), NOW)).toBe('Working: Fix the CI · 2 min 5 s');
    expect(dispatchElapsedMs(d('a'), NOW)).toBe(125_000);
  });
  it('an ended dispatch keeps its duration (it does not grow)', () => {
    const e = ended('a', 'done', 30);
    expect(dispatchText(e, NOW)).toBe('Done: Fix the CI · 1 min 15 s');
    expect(dispatchText(e, NOW + 60_000)).toBe('Done: Fix the CI · 1 min 15 s');
    expect(dispatchText(ended('b', 'failed', 3), NOW)).toMatch(/^Failed: /);
    expect(dispatchText(ended('c', 'stopped', 3), NOW)).toMatch(/^Stopped: /);
  });
  it('an empty description uses the bare line', () => {
    expect(dispatchText(d('a', { description: '  ' }), NOW)).toBe('Working · 2 min 5 s');
  });
  it('unknown says Unknown with no time, and has the explaining tooltip', () => {
    const u = d('a', { state: 'unknown' });
    expect(dispatchText(u, NOW)).toBe('Unknown: Fix the CI');
    expect(dispatchText(d('a', { state: 'unknown', description: '' }), NOW)).toBe('Unknown');
    expect(dispatchElapsedMs(u, NOW)).toBeNull();
    expect(dispatchTip(u, NOW, 'Ada')).toContain('Ask Ada for its status');
  });
  it('a running dispatch has a "last activity" tooltip, an ended one none', () => {
    expect(dispatchTip(d('a'), NOW, 'Ada')).toBe('Last activity 5 s ago');
    expect(dispatchTip(ended('a', 'done', 9), NOW, 'Ada')).toBe('');
  });
  it('the line comes in parts, so the description alone can be cut', () => {
    expect(dispatchLineParts(d('a'), NOW)).toEqual({ before: 'Working: ', description: 'Fix the CI', after: ' · 2 min 5 s' });
    expect(dispatchLineParts(d('a', { description: '' }), NOW)).toEqual({ before: 'Working · 2 min 5 s', description: '', after: '' });
  });
  it('words have no time (an accessible name must not change every second)', () => {
    expect(dispatchWords(d('a'))).toBe('Working: Fix the CI');
    expect(dispatchWords(d('a', { description: '' }))).toBe('Working');
  });
});

const joined = (v: { parts: { before: string; description: string; after: string } }): string => v.parts.before + v.parts.description + v.parts.after;

describe('what a node shows', () => {
  it('one dispatch: its line', () => {
    const v = departmentNodeDispatch([d('a')], NOW)!;
    expect(v.state).toBe('running');
    // a node is narrow: a running task leaves out the word "Working" (the accessible name has it)
    expect(joined(v)).toBe('Fix the CI · 2 min 5 s');
    expect(v.words).toBe('Working: Fix the CI');
  });
  it('several running: how many, with the time of the oldest', () => {
    const v = departmentNodeDispatch([d('a', { startedAt: at(40) }), d('b', { startedAt: at(300) }), d('c', { startedAt: at(10) })], NOW)!;
    expect(joined(v)).toBe('3 tasks working · 5 min 0 s');
    expect(v.parts.after).toBe(' · 5 min 0 s');
    expect(v.words).toBe('3 tasks working');
  });
  it('two for the same department are both counted', () => {
    const list = [d('a'), d('b', { description: 'Other' })];
    expect(dispatchesOfDepartment(list, 'engineering')).toHaveLength(2);
    expect(joined(departmentNodeDispatch(list, NOW)!)).toContain('2 tasks working');
  });
  it('one running next to an ended one: the running line; only ended ones: the newest', () => {
    expect(departmentNodeDispatch([ended('a', 'done', 20), d('b')], NOW)!.state).toBe('running');
    const v = departmentNodeDispatch([ended('a', 'done', 50), ended('b', 'failed', 10)], NOW)!;
    expect(v.state).toBe('failed');
  });
  it('no dispatch: nothing', () => {
    expect(departmentNodeDispatch([], NOW)).toBeNull();
    expect(helpersNodeDispatch([], NOW)).toBeNull();
  });
  it('helpers (no department) are only on the chief of staff node, only while they run', () => {
    const list = [d('h1', { agent: 'reader', departmentId: null, name: 'reader', startedAt: at(20) }), d('h2', { agent: 'worker', departmentId: null, name: 'worker', startedAt: at(70) }), ended('h3', 'done', 3, { departmentId: null })];
    expect(dispatchesOfDepartment(list, 'engineering')).toEqual([]);
    expect(runningHelpers(list).map((x) => x.id)).toEqual(['h1', 'h2']);
    expect(joined(helpersNodeDispatch(list, NOW)!)).toBe('2 helpers working · 1 min 10 s');
    expect(joined(helpersNodeDispatch([list[0]], NOW)!)).toBe('1 helper working · 20 s');
    expect(helpersNodeDispatch([list[2]], NOW)).toBeNull();
  });
  it('the tooltip lists every dispatch, oldest first, helpers by name', () => {
    const list = [d('a', { startedAt: at(10), description: 'Newer' }), d('b', { startedAt: at(100), description: 'Older' })];
    expect(dispatchTipLines(list, NOW, false)).toEqual(['Working: Older · 1 min 40 s', 'Working: Newer · 10 s']);
    expect(dispatchTipLines([d('h', { name: 'reader', departmentId: null })], NOW, true)[0]).toMatch(/^reader: Working: /);
  });
});

const ctx = (over: Partial<AckContext> = {}): AckContext => ({ visibleThread: 'cos', windowFocused: true, threadBusy: false, nowMs: NOW, ...over });

describe('the seen rule', () => {
  const list = [d('run'), ended('old', 'done', 6), ended('fresh', 'failed', 2), ended('stop', 'stopped', 60)];

  it('acks ended ones that ended at least 5 s ago, never running ones', () => {
    expect(dispatchesToAck(list, ctx())).toEqual(['old', 'stop']);
    expect(dispatchesToAck([ended('edge', 'done', ACK_AFTER_MS / 1000)], ctx())).toEqual(['edge']);
  });
  it('acks nothing unless the CoS thread is the visible tab', () => {
    expect(dispatchesToAck(list, ctx({ visibleThread: null }))).toEqual([]);
  });
  it('acks nothing while the window has no focus', () => {
    expect(dispatchesToAck(list, ctx({ windowFocused: false }))).toEqual([]);
  });
  it('acks nothing while the CoS thread is busy (its report turn is not over)', () => {
    expect(dispatchesToAck(list, ctx({ threadBusy: true }))).toEqual([]);
  });
  describe('a report still pending (reportPending)', () => {
    const one = (secondsAgo: number) => [ended('x', 'done', secondsAgo)];
    it('the wait is 120 s from the end, not 5 s', () => {
      expect(REPORT_WAIT_MS).toBe(120_000);
      expect(dispatchesToAck(one(6), ctx({ reportPending: true }))).toEqual([]);
      expect(dispatchesToAck(one(119), ctx({ reportPending: true }))).toEqual([]);
      expect(dispatchesToAck(one(120), ctx({ reportPending: true }))).toEqual(['x']);
      expect(dispatchesToAck(one(300), ctx({ reportPending: true }))).toEqual(['x']);
    });
    it('without it (false or absent) the wait is 5 s as before', () => {
      expect(dispatchesToAck(one(4), ctx({ reportPending: false }))).toEqual([]);
      expect(dispatchesToAck(one(5), ctx({ reportPending: false }))).toEqual(['x']);
      expect(dispatchesToAck(one(6), ctx())).toEqual(['x']);
    });
    it('applies to failed and stopped ones too, and still never to running ones', () => {
      const l = [d('run'), ended('f', 'failed', 10), ended('s', 'stopped', 130)];
      expect(dispatchesToAck(l, ctx({ reportPending: true }))).toEqual(['s']);
    });
    it('an unknown one waits 120 s from its first sight', () => {
      const u = d('u', { state: 'unknown' });
      expect(dispatchesToAck([u], ctx({ reportPending: true, firstSeen: new Map([['u', NOW - 60_000]]) }))).toEqual([]);
      expect(dispatchesToAck([u], ctx({ reportPending: true, firstSeen: new Map([['u', NOW - 120_000]]) }))).toEqual(['u']);
    });
    it('still needs the CoS visible, the window focused and the CoS not busy', () => {
      expect(dispatchesToAck(one(200), ctx({ reportPending: true, visibleThread: null }))).toEqual([]);
      expect(dispatchesToAck(one(200), ctx({ reportPending: true, windowFocused: false }))).toEqual([]);
      expect(dispatchesToAck(one(200), ctx({ reportPending: true, threadBusy: true }))).toEqual([]);
    });
    it('says when to look again: the time left to 120 s', () => {
      expect(nextAckDelayMs(one(6), ctx({ reportPending: true }))).toBe(114_000);
      expect(nextAckDelayMs(one(6), ctx({ reportPending: false }))).toBeNull();
      expect(nextAckDelayMs(one(2), ctx({ reportPending: false }))).toBe(3000);
    });
  });
  it('unknown: 5 s after the renderer first saw it', () => {
    const u = d('u', { state: 'unknown' });
    expect(dispatchesToAck([u], ctx())).toEqual([]);
    expect(dispatchesToAck([u], ctx({ firstSeen: new Map([['u', NOW - 2000]]) }))).toEqual([]);
    expect(dispatchesToAck([u], ctx({ firstSeen: new Map([['u', NOW - 5000]]) }))).toEqual(['u']);
  });
  it('says when to look again: the time until the next one is old enough', () => {
    expect(nextAckDelayMs(list, ctx())).toBe(3000);
    expect(nextAckDelayMs([d('run')], ctx())).toBeNull();
    expect(nextAckDelayMs(list, ctx({ threadBusy: true }))).toBeNull();
    expect(nextAckDelayMs([ended('x', 'done', 60)], ctx())).toBeNull();
  });
});

const by = (tab: string, departmentId: string | null = 'engineering') => ({ threadId: `tab:${tab}`, departmentId, name: 'Max' });

describe('dispatches made in a department chat (by)', () => {
  const tabRun = (id: string, tab = 't1', patch: Partial<Dispatch> = {}): Dispatch => d(id, { agent: 'worker', departmentId: null, name: 'Max → worker', background: false, by: by(tab), ...patch });
  it('they belong to the dispatching department, not to the chief of staff helpers', () => {
    const list = [d('own'), tabRun('w1'), tabRun('w2', 't1', { state: 'done', endedAt: at(3) }), tabRun('other', 't2', { by: by('t2', 'design-brand') }), tabRun('loose', 't3', { by: by('t3', null) })];
    expect(dispatchesOfDepartment(list, 'engineering').map((x) => x.id)).toEqual(['own', 'w1', 'w2']);
    expect(dispatchesOfDepartment(list, 'design-brand').map((x) => x.id)).toEqual(['other']);
    expect(runningHelpers(list)).toEqual([]);
    expect(runningHelpers([...list, d('h', { departmentId: null })]).map((x) => x.id)).toEqual(['h']);
  });
  it('the line says which agent runs; the department own lines are unchanged', () => {
    expect(dispatchText(tabRun('w1'), NOW)).toBe('Working: → worker Fix the CI · 2 min 5 s');
    expect(dispatchText(tabRun('w1', 't1', { description: '' }), NOW)).toBe('Working: → worker · 2 min 5 s');
    expect(dispatchWords(tabRun('w1'))).toBe('Working: → worker Fix the CI');
    expect(dispatchLineParts(tabRun('w1'), NOW)).toEqual({ before: 'Working: ', description: '→ worker Fix the CI', after: ' · 2 min 5 s' });
    expect(dispatchText(d('a'), NOW)).toBe('Working: Fix the CI · 2 min 5 s');
  });
  it('a tab with sub-agents running counts as busy for closing; an ended one or another tab does not', () => {
    const list = [tabRun('w1', 't1'), tabRun('w2', 't2', { state: 'done', endedAt: at(2) }), d('cos-run')];
    expect(tabHasRunningDispatches(list, 't1')).toBe(true);
    expect(tabHasRunningDispatches(list, 't2')).toBe(false);
    expect(tabHasRunningDispatches(list, 't3')).toBe(false);
  });
  it('an ended one is acked when its own tab is the shown thread, not when another thread is shown', () => {
    const list = [ended('c1', 'done', 30), tabRun('w1', 't1', { state: 'done', endedAt: at(30) }), tabRun('w2', 't2', { state: 'failed', endedAt: at(30) })];
    expect(dispatchesToAck(list, ctx({ visibleThread: 'cos' }))).toEqual(['c1']);
    expect(dispatchesToAck(list, ctx({ visibleThread: 'tab:t1' }))).toEqual(['w1']);
    expect(dispatchesToAck(list, ctx({ visibleThread: 'tab:t2' }))).toEqual(['w2']);
    expect(dispatchesToAck(list, ctx({ visibleThread: null }))).toEqual([]);
  });
  it('the usual timings hold in a tab: not busy, window focused, old enough', () => {
    const w = tabRun('w1', 't1', { state: 'done', endedAt: at(2) });
    expect(dispatchesToAck([w], ctx({ visibleThread: 'tab:t1' }))).toEqual([]);
    expect(nextAckDelayMs([w], ctx({ visibleThread: 'tab:t1' }))).toBe(3000);
    expect(nextAckDelayMs([w], ctx({ visibleThread: 'cos' }))).toBeNull();
    expect(dispatchesToAck([ended('x', 'done', 30, { by: by('t1') })], ctx({ visibleThread: 'tab:t1', threadBusy: true }))).toEqual([]);
    const u = tabRun('u', 't1', { state: 'unknown' });
    expect(dispatchesToAck([u], ctx({ visibleThread: 'tab:t1', firstSeen: new Map([['u', NOW - 5000]]) }))).toEqual(['u']);
  });
});

describe('syncAckMemory: a dispatch that runs again is forgotten', () => {
  it('forgets the ids that left the list, and a running one (a revived dispatch is acked on the normal timing)', () => {
    const firstSeen = new Map([['a', NOW - 60_000], ['gone', NOW - 1000]]);
    const acked = new Set(['a', 'gone']);
    // `a` was acked, then it runs again (SendMessage resume): its old entries must go
    syncAckMemory([d('a'), d('u', { state: 'unknown' })], firstSeen, acked, NOW);
    expect([...acked]).toEqual([]);
    expect([...firstSeen.keys()]).toEqual(['u']);
    expect(firstSeen.get('u')).toBe(NOW);
  });
  it('after the revival ends, it is acked 5 s after its new end, not at once by a stale entry', () => {
    const firstSeen = new Map<string, number>();
    const acked = new Set<string>(['a']); // the first end was acked (the ack not yet answered by a new list)
    syncAckMemory([d('a')], firstSeen, acked, NOW - 20_000); // seen running again
    expect(acked.has('a')).toBe(false);
    const done = ended('a', 'done', 1);
    syncAckMemory([done], firstSeen, acked, NOW);
    const pending = [done].filter((x) => !acked.has(x.id));
    expect(dispatchesToAck(pending, ctx({ firstSeen }))).toEqual([]);
    expect(dispatchesToAck(pending, ctx({ firstSeen, nowMs: NOW + 4000 }))).toEqual(['a']);
  });
  it('an unknown one revived and unknown again waits 5 s from when it was last seen unknown', () => {
    const firstSeen = new Map<string, number>();
    const acked = new Set<string>();
    syncAckMemory([d('u', { state: 'unknown' })], firstSeen, acked, NOW - 60_000);
    syncAckMemory([d('u')], firstSeen, acked, NOW - 30_000);
    expect(firstSeen.has('u')).toBe(false);
    syncAckMemory([d('u', { state: 'unknown' })], firstSeen, acked, NOW - 1000);
    expect(dispatchesToAck([d('u', { state: 'unknown' })], ctx({ firstSeen }))).toEqual([]);
  });
});

describe('reducer: dispatches', () => {
  const withOrgs: AppState = {
    ...initialState,
    activeOrgId: 'o1',
    orgs: [
      { id: 'o1', path: '/a', name: 'ACME', cosName: 'Ada', waitingCount: 0, lastOpened: '', available: true, iconStamp: null },
      { id: 'o2', path: '/b', name: 'BOLT', cosName: 'Bea', waitingCount: 0, lastOpened: '', available: true, iconStamp: null },
    ],
  };
  it('keeps the whole list per org, replaced by each event', () => {
    let s = reducer(withOrgs, { type: 'dispatches', orgId: 'o1', dispatches: [d('a')] });
    s = reducer(s, { type: 'dispatches', orgId: 'o2', dispatches: [d('b'), d('c')] });
    expect(s.orgData.o1.dispatches.map((x) => x.id)).toEqual(['a']);
    expect(s.orgData.o2.dispatches.map((x) => x.id)).toEqual(['b', 'c']);
    s = reducer(s, { type: 'dispatches', orgId: 'o1', dispatches: [] });
    expect(s.orgData.o1.dispatches).toEqual([]);
    expect(s.orgData.o2.dispatches).toHaveLength(2);
  });
  it('an org with no event has no dispatches', () => {
    const s = reducer(withOrgs, { type: 'org-chart', orgId: 'o1', chart: null as never });
    expect(s.orgData.o1.dispatches).toEqual([]);
  });
  it('dispatch-ended: a toast naming the persona and the task, with a button for the chief of staff thread', () => {
    const s = reducer(withOrgs, { type: 'dispatch-ended', orgId: 'o1', dispatch: ended('a', 'done', 1) });
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0]).toMatchObject({ orgId: 'o1', text: 'Max finished: Fix the CI', action: { kind: 'focus-cos', label: "Open Ada's thread" } });
  });
  it('dispatch-ended: failed, stopped and the bare text for an empty description', () => {
    expect(reducer(withOrgs, { type: 'dispatch-ended', orgId: 'o1', dispatch: ended('a', 'failed', 1) }).notices[0].text).toBe('Max failed: Fix the CI');
    expect(reducer(withOrgs, { type: 'dispatch-ended', orgId: 'o1', dispatch: ended('a', 'stopped', 1) }).notices[0].text).toBe('Max stopped: Fix the CI');
    expect(reducer(withOrgs, { type: 'dispatch-ended', orgId: 'o1', dispatch: ended('a', 'done', 1, { description: '' }) }).notices[0].text).toBe('Max finished');
  });
  it('dispatch-ended for an org that is not on screen names the org and its chief of staff', () => {
    const n = reducer(withOrgs, { type: 'dispatch-ended', orgId: 'o2', dispatch: ended('a', 'done', 1) }).notices[0];
    expect(n.text).toBe('BOLT: Max finished: Fix the CI');
    expect(n.action?.label).toBe("Open Bea's thread");
  });
  it('dispatch-ended with a state that is not an end gives no toast; other toasts keep no action', () => {
    expect(reducer(withOrgs, { type: 'dispatch-ended', orgId: 'o1', dispatch: d('a') }).notices).toEqual([]);
    const plain = reducer(withOrgs, { type: 'notice', orgId: 'o1', text: 'hello' }).notices[0];
    expect(plain.action).toBeUndefined();
  });
});
