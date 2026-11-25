import { describe, expect, it } from 'vitest';
import type { KeyValueStorage } from '../../src/renderer/logic';
import {
  cutLabel, dayLabel, hasLongOption, isPanelShortcut, loadPanelHidden, mergeLeaving, panelHiddenKey, prereqMark, savePanelHidden, sinceLabel, sortWaiting,
  waitingActionSpecs, waitingKindKey, type LeavingRow,
} from '../../src/renderer/panel-logic';
import type { PluginActionState, PrereqStatus, SignInState, WaitingItem } from '../../src/shared/types';

const fake = (): KeyValueStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};

describe('whole-panel collapse storage', () => {
  it('shows the panel by default', () => {
    expect(loadPanelHidden(fake(), 'o1')).toBe(false);
  });
  it('remembers hidden and shown per org', () => {
    const s = fake();
    savePanelHidden(s, 'o1', true);
    expect(s.data.has(panelHiddenKey('o1'))).toBe(true);
    expect(loadPanelHidden(s, 'o1')).toBe(true);
    expect(loadPanelHidden(s, 'o2')).toBe(false);
    savePanelHidden(s, 'o1', false);
    expect(loadPanelHidden(s, 'o1')).toBe(false);
  });
  it('does not throw when storage fails', () => {
    const bad: KeyValueStorage = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
    expect(loadPanelHidden(bad, 'o1')).toBe(false);
    expect(() => savePanelHidden(bad, 'o1', true)).not.toThrow();
  });
});

describe('isPanelShortcut', () => {
  const key = (over: Partial<Parameters<typeof isPanelShortcut>[0]> = {}) => ({ code: 'KeyS', metaKey: true, altKey: true, ctrlKey: false, shiftKey: false, ...over });
  it('is Cmd+Option+S on the physical key', () => {
    expect(isPanelShortcut(key())).toBe(true);
  });
  it('needs both modifiers and no others', () => {
    expect(isPanelShortcut(key({ altKey: false }))).toBe(false);
    expect(isPanelShortcut(key({ metaKey: false }))).toBe(false);
    expect(isPanelShortcut(key({ shiftKey: true }))).toBe(false);
    expect(isPanelShortcut(key({ ctrlKey: true }))).toBe(false);
    expect(isPanelShortcut(key({ code: 'KeyD' }))).toBe(false);
  });
});

describe('cutLabel', () => {
  it('keeps a short label', () => {
    expect(cutLabel('Ship it')).toBe('Ship it');
    expect(cutLabel('x'.repeat(32))).toBe('x'.repeat(32));
  });
  it('cuts at 32 characters with an ellipsis', () => {
    const cut = cutLabel('x'.repeat(40));
    expect(Array.from(cut)).toHaveLength(32);
    expect(cut.endsWith('…')).toBe(true);
  });
  it('flattens white space and counts characters, not code units', () => {
    expect(cutLabel('a\n  b')).toBe('a b');
    expect(cutLabel('😀'.repeat(33))).toBe(`${'😀'.repeat(31)}…`);
  });
});

const w = (code: string, urgency: WaitingItem['urgency'], since: string | null): WaitingItem => ({ code, kind: 'A', urgency, text: 't', since, escalate: false, action: 'ok' });

describe('sortWaiting', () => {
  it('puts high first, then the oldest first', () => {
    const list = [w('a', 'normal', '2026-11-10'), w('b', 'high', '2026-11-15'), w('c', 'low', '2026-11-01'), w('d', 'high', '2026-11-12')];
    expect(sortWaiting(list).map((x) => x.code)).toEqual(['d', 'b', 'c', 'a']);
  });
  it('puts undated items after dated ones and keeps the input order on ties', () => {
    const list = [w('a', null, null), w('b', null, '2026-11-10'), w('c', null, null), w('d', null, '2026-11-10')];
    expect(sortWaiting(list).map((x) => x.code)).toEqual(['b', 'd', 'a', 'c']);
  });
  it('does not change its input', () => {
    const list = [w('a', null, '2026-11-10'), w('b', 'high', null)];
    sortWaiting(list);
    expect(list.map((x) => x.code)).toEqual(['a', 'b']);
  });
});

describe('sinceLabel', () => {
  const now = new Date(2026, 10, 18);
  it('reads the date as a local day, without the year in the current year', () => {
    expect(sinceLabel('2026-11-06', now, 'en-GB')).toBe('6 November');
  });
  it('adds the year for another year', () => {
    expect(sinceLabel('2025-11-06', now, 'en-GB')).toBe('6 November 2025');
  });
  it('is empty when unknown', () => {
    expect(sinceLabel(null, now)).toBe('');
    expect(sinceLabel('soon', now)).toBe('');
  });
});

describe('dayLabel', () => {
  const now = new Date(2026, 10, 18);
  it('is day and short month, with the year only for another year', () => {
    expect(dayLabel('2026-11-17', now, 'en-GB')).toBe('17 Nov');
    expect(dayLabel('2025-10-19', now, 'en-GB')).toBe('19 Oct 2025');
    expect(dayLabel(null, now)).toBe('');
    expect(dayLabel('x', now)).toBe('');
  });
});

describe('waitingActionSpecs (5.9)', () => {
  const item = (action: WaitingItem['action'], options?: WaitingItem['options']): WaitingItem => ({ code: 'X-1', kind: 'A', urgency: null, text: 't', since: null, escalate: false, action, options });
  const opt = (n: number) => Array.from({ length: n }, (_, i) => ({ key: 'abcdef'[i], label: `Option ${i}` }));
  const ids = (specs: { id: string; variant: string }[]) => specs.map((s) => `${s.id}:${s.variant}`);
  it('ok: Approve primary, Decline secondary, Reply quiet', () => {
    expect(ids(waitingActionSpecs(item('ok')).visible)).toEqual(['approve:you', 'decline:secondary', 'reply:quiet']);
  });
  it('do: Done primary, Reply quiet', () => {
    expect(ids(waitingActionSpecs(item('do')).visible)).toEqual(['done:you', 'reply:quiet']);
  });
  it('decide with options: one outline button per option, then Reply', () => {
    const { visible, more } = waitingActionSpecs(item('decide', opt(2)));
    expect(ids(visible)).toEqual(['option:you-outline', 'option:you-outline', 'reply:quiet']);
    expect(visible[0]).toMatchObject({ optionKey: 'a', optionLabel: 'Option 0' });
    expect(more).toEqual([]);
  });
  it('decide with more than 3 options: the first 3, the rest under More options', () => {
    const { visible, more } = waitingActionSpecs(item('decide', opt(5)));
    expect(visible.filter((s) => s.id === 'option').map((s) => s.optionKey)).toEqual(['a', 'b', 'c']);
    expect(more.map((s) => s.optionKey)).toEqual(['d', 'e']);
    expect(visible[visible.length - 1].id).toBe('reply');
  });
  it('decide without readable options: Answer primary, Reply quiet', () => {
    expect(ids(waitingActionSpecs(item('decide')).visible)).toEqual(['answer:you', 'reply:quiet']);
    expect(ids(waitingActionSpecs(item('decide', opt(1))).visible)).toEqual(['answer:you', 'reply:quiet']);
  });
  it('untagged: Reply only, secondary (never a guessed approval)', () => {
    expect(ids(waitingActionSpecs(item(null)).visible)).toEqual(['reply:secondary']);
    expect(ids(waitingActionSpecs(item(null, opt(3))).visible)).toEqual(['reply:secondary']);
  });
});

describe('mergeLeaving', () => {
  const key = (x: string) => x;
  const rows = (...keys: string[]): LeavingRow<string>[] => keys.map((k) => ({ key: k, item: k, leaving: false }));
  it('keeps the current items in order, not leaving', () => {
    expect(mergeLeaving([], ['a', 'b'], key)).toEqual(rows('a', 'b'));
  });
  it('keeps an item that left, at its old place, marked leaving', () => {
    const merged = mergeLeaving(rows('a', 'b', 'c'), ['a', 'c'], key);
    expect(merged.map((r) => `${r.key}:${r.leaving}`)).toEqual(['a:false', 'b:true', 'c:false']);
  });
  it('keeps it leaving on the next merge, until the caller drops it', () => {
    const first = mergeLeaving(rows('a', 'b'), ['a'], key);
    expect(mergeLeaving(first, ['a'], key).map((r) => r.key)).toEqual(['a', 'b']);
    expect(mergeLeaving(first.filter((r) => !r.leaving), ['a'], key).map((r) => r.key)).toEqual(['a']);
  });
  it('an item that comes back is no longer leaving', () => {
    const first = mergeLeaving(rows('a', 'b'), ['a'], key);
    expect(mergeLeaving(first, ['a', 'b'], key).every((r) => !r.leaving)).toBe(true);
  });
  it('keeps a leaving item inside the list when the list got shorter', () => {
    const merged = mergeLeaving(rows('a', 'b', 'c'), ['x'], key);
    expect(merged.map((r) => r.key).sort()).toEqual(['a', 'b', 'c', 'x']);
    expect(merged.filter((r) => r.leaving)).toHaveLength(3);
  });
});

describe('prereqMark (5.14)', () => {
  const plugin = (state: string) => ({ state, installed: null, latest: null, updateAvailable: false, hqFrameworkVersion: null, orgUpdateAvailable: false, belowMinimum: false, minimum: '0.1.0', latestCheckFailed: false, dev: false });
  const status = (over: Partial<PrereqStatus> = {}): PrereqStatus => ({
    claude: { found: true, path: '/x', version: '2.1.330', supported: true, range: '>=1' },
    signedIn: true,
    git: { found: true, version: '2.45.0', devToolsMissing: false },
    plugin: plugin('ok') as never,
    checkedAt: '2026-11-18T10:00:00Z',
    ...over,
  });
  const idle: SignInState = { running: false, url: null, error: null };
  const noAction: PluginActionState | null = null;
  it('done when the check passes', () => {
    expect(prereqMark('claude', status(), idle, noAction)).toBe('done');
    expect(prereqMark('signin', status(), idle, noAction)).toBe('done');
    expect(prereqMark('git', status(), idle, noAction)).toBe('done');
    expect(prereqMark('plugin', status(), idle, noAction)).toBe('done');
  });
  it('needs your action when something is missing', () => {
    const st = status({ claude: { found: false, path: null, version: null, supported: false, range: '>=1' }, signedIn: false, git: { found: false, version: null, devToolsMissing: false }, plugin: plugin('missing') as never });
    expect(prereqMark('claude', st, idle, noAction)).toBe('action');
    expect(prereqMark('signin', st, idle, noAction)).toBe('action');
    expect(prereqMark('git', st, idle, noAction)).toBe('action');
    expect(prereqMark('plugin', st, idle, noAction)).toBe('action');
  });
  it('waits when sign-in or the plugin cannot be checked yet', () => {
    expect(prereqMark('signin', status({ signedIn: null }), idle, noAction)).toBe('waiting');
    expect(prereqMark('plugin', status({ plugin: null }), idle, noAction)).toBe('waiting');
  });
  it('checks while signing in, installing or rechecking', () => {
    expect(prereqMark('signin', status({ signedIn: false }), { ...idle, running: true }, noAction)).toBe('checking');
    expect(prereqMark('plugin', status({ plugin: plugin('missing') as never }), idle, { running: true, action: 'install', error: null })).toBe('checking');
    expect(prereqMark('git', status({ git: { found: false, version: null, devToolsMissing: false } }), idle, noAction, true)).toBe('checking');
  });
  it('a done row stays done while rechecking', () => {
    expect(prereqMark('claude', status(), idle, noAction, true)).toBe('done');
  });
  it('fails when the sign-in or the plugin step went wrong, or the plugin state is unknown', () => {
    expect(prereqMark('signin', status({ signedIn: false }), { ...idle, error: 'x' }, noAction)).toBe('failed');
    expect(prereqMark('plugin', status({ plugin: plugin('missing') as never }), idle, { running: false, action: null, error: 'boom' })).toBe('failed');
    expect(prereqMark('plugin', status({ plugin: plugin('unknown') as never }), idle, noAction)).toBe('failed');
  });
});

describe('hasLongOption (options listed as text when a label is over 32 characters)', () => {
  const item = (labels: string[]): WaitingItem => ({
    code: 'X-D1', kind: 'D', urgency: 'normal', action: 'decide', escalate: false, since: null, text: 'Which?',
    options: labels.map((label, i) => ({ key: String.fromCharCode(97 + i), label })),
  });
  it('is false when every label fits (32 characters is the limit)', () => {
    expect(hasLongOption(item(['Free tier', 'x'.repeat(32)]))).toBe(false);
    expect(hasLongOption({ ...item([]), options: undefined })).toBe(false);
  });
  it('is true when any label is longer, also one after the third', () => {
    expect(hasLongOption(item(['a', 'x'.repeat(33)]))).toBe(true);
    expect(hasLongOption(item(['a', 'b', 'c', 'd', 'x'.repeat(40)]))).toBe(true);
  });
  it('counts the text without Markdown markers', () => {
    expect(hasLongOption(item([`**${'x'.repeat(32)}**`]))).toBe(false);
  });
  it('keeps More options for more than 3 options', () => {
    const specs = waitingActionSpecs(item(['a', 'b', 'c', 'd'].map((x) => x.repeat(40))));
    expect(specs.more.map((s) => s.optionKey)).toEqual(['d']);
  });
});

describe('waitingKindKey', () => {
  const base: WaitingItem = { code: 'ACME-T1', kind: 'T', urgency: null, text: 't', since: null, escalate: false, action: 'do' };
  it('a todo item has its own label, the others follow their tag, an untagged one has none', () => {
    expect(waitingKindKey(base)).toBe('waiting.kind.todo');
    expect(waitingKindKey({ ...base, kind: 'A' })).toBe('waiting.kind.do');
    expect(waitingKindKey({ ...base, kind: 'D', action: 'decide' })).toBe('waiting.kind.decide');
    expect(waitingKindKey({ ...base, kind: 'A', action: null })).toBeNull();
  });
  it('a todo item gets Done and Reply', () => {
    expect(waitingActionSpecs(base).visible.map((s) => s.id)).toEqual(['done', 'reply']);
  });
});
