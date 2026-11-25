import { describe, expect, it } from 'vitest';
import {
  ageDays, ageText, defaultPanelState, isUntagged, loadPanelState, panelStorageKey, savePanelState, waitingButtons,
  type KeyValueStorage,
} from '../../src/renderer/logic';
import type { WaitingItem } from '../../src/shared/types';

const item = (kind: 'A' | 'D' | 'T', action: WaitingItem['action'], options?: WaitingItem['options']): WaitingItem => ({
  code: `X-${kind}1`, kind, urgency: null, text: 't', since: null, escalate: false, action, options,
});
const opts = [{ key: 'a', label: 'one' }, { key: 'b', label: 'two' }];

describe('waitingButtons', () => {
  it('ok: Approve, Decline, Reply', () => {
    expect(waitingButtons(item('A', 'ok'))).toEqual(['approve', 'decline', 'reply']);
  });
  it('a todo item (T, do) gets Done and Reply, like a {do} item', () => {
    expect(waitingButtons(item('T', 'do'))).toEqual(['done', 'reply']);
  });
  it('do: Done, Reply', () => {
    expect(waitingButtons(item('A', 'do'))).toEqual(['done', 'reply']);
  });
  it('decide with options: one button per option, then Reply', () => {
    expect(waitingButtons(item('D', 'decide', opts))).toEqual(['option:a', 'option:b', 'reply']);
  });
  it('decide without options: Answer, Reply', () => {
    expect(waitingButtons(item('D', 'decide'))).toEqual(['answer', 'reply']);
    expect(waitingButtons(item('D', 'decide', [opts[0]]))).toEqual(['answer', 'reply']);
  });
  it('untagged items get Reply only and no Approve', () => {
    expect(waitingButtons(item('A', null))).toEqual(['reply']);
    expect(waitingButtons(item('D', null, opts))).toEqual(['reply']);
    expect(isUntagged(item('A', null))).toBe(true);
    expect(isUntagged(item('A', 'ok'))).toBe(false);
  });
});

describe('age', () => {
  const now = new Date(2026, 10, 18, 15, 0);
  it('counts whole local days', () => {
    expect(ageDays('2026-11-18', now)).toBe(0);
    expect(ageDays('2026-11-17', now)).toBe(1);
    expect(ageDays('2026-11-06', now)).toBe(12);
    expect(ageDays('2026-12-01', now)).toBe(0);
  });
  it('is null when the date is missing or invalid', () => {
    expect(ageDays(null, now)).toBeNull();
    expect(ageDays('soon', now)).toBeNull();
    expect(ageText(null, now)).toBe('');
  });
  it('says it in plain words', () => {
    expect(ageText('2026-11-18', now)).toBe('today');
    expect(ageText('2026-11-17', now)).toBe('1 d');
    expect(ageText('2026-11-06', now)).toBe('12 d');
  });
});

describe('panel state storage', () => {
  const fake = (): KeyValueStorage & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
  };
  it('defaults to all open', () => {
    expect(loadPanelState(fake(), 'o1')).toEqual(defaultPanelState());
  });
  it('saves and loads per org', () => {
    const s = fake();
    savePanelState(s, 'o1', { waiting: false, initiatives: true, departments: false });
    expect(s.data.has(panelStorageKey('o1'))).toBe(true);
    expect(loadPanelState(s, 'o1')).toEqual({ waiting: false, initiatives: true, departments: false });
    expect(loadPanelState(s, 'o2')).toEqual(defaultPanelState());
  });
  it('tolerates bad JSON and wrong shapes', () => {
    const s = fake();
    s.data.set(panelStorageKey('o1'), '{not json');
    expect(loadPanelState(s, 'o1')).toEqual(defaultPanelState());
    s.data.set(panelStorageKey('o1'), '"text"');
    expect(loadPanelState(s, 'o1')).toEqual(defaultPanelState());
    s.data.set(panelStorageKey('o1'), '{"waiting":false,"initiatives":"no"}');
    expect(loadPanelState(s, 'o1')).toEqual({ waiting: false, initiatives: true, departments: true });
  });
  it('does not throw when storage fails', () => {
    const bad: KeyValueStorage = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
    expect(loadPanelState(bad, 'o1')).toEqual(defaultPanelState());
    expect(() => savePanelState(bad, 'o1', defaultPanelState())).not.toThrow();
  });
});
