import { describe, expect, it, vi } from 'vitest';
import type { CoaApi, TabInfo } from '../../src/shared/types';
import { closeDecision, closeTargetFor, runCloseChoice, visibleTabsOf } from '../../src/renderer/logic';

const tab = (tabId: string, o: Partial<TabInfo> = {}): TabInfo => ({
  tabId, orgId: 'o', agent: 'max', persona: 'Max', role: 'Engineering', status: 'open', openedAt: `2026-01-0${tabId}T10:00:00Z`, closedAt: null, notePath: null, pendingWork: false, ...o,
});

describe('visibleTabsOf', () => {
  it('shows open and handing-over chats; a closed chat leaves no trace', () => {
    const tabs = [tab('1'), tab('3', { status: 'closed' }), tab('4', { status: 'closed', notePath: 'inbox/x.md' }), tab('5', { status: 'handing-over' })];
    expect(visibleTabsOf(tabs).map((x) => x.tabId)).toEqual(['1', '5']);
  });
});

describe('closeTargetFor', () => {
  const visible = [tab('1'), tab('3', { status: 'handing-over' })];
  it('does nothing for the CoS, unknown and handing-over tabs', () => {
    expect(closeTargetFor('cos', visible)).toBeNull();
    expect(closeTargetFor('tab:zz', visible)).toBeNull();
    expect(closeTargetFor('tab:3', visible)).toBeNull();
  });
  it('closes an open tab', () => expect(closeTargetFor('tab:1', visible)).toBe('1'));
});

describe('closeDecision', () => {
  it('a chat with work that was not handed over asks first, busy or not', () => {
    const work = tab('1', { pendingWork: true });
    expect(closeDecision(work, false)).toBe('ask-handover');
    expect(closeDecision(work, true)).toBe('ask-handover');
  });
  it('a busy chat with no pending work flag yet (its first tool turn) asks too', () => {
    expect(closeDecision(tab('1'), true)).toBe('ask-handover');
  });
  it('an idle chat with no pending work closes at once', () => {
    expect(closeDecision(tab('1'), false)).toBe('close');
    expect(closeDecision({ pendingWork: undefined } as unknown as TabInfo, false)).toBe('close');
  });
});

describe('runCloseChoice', () => {
  const api = () => ({ handOver: vi.fn().mockResolvedValue(undefined), closeTab: vi.fn().mockResolvedValue(undefined) }) satisfies Pick<CoaApi, 'handOver' | 'closeTab'>;
  it('hand over calls handOver', async () => {
    const a = api();
    await runCloseChoice('handover', a, 'o', 't1');
    expect(a.handOver).toHaveBeenCalledWith('o', 't1');
    expect(a.closeTab).not.toHaveBeenCalled();
  });
  it('close without handover calls closeTab', async () => {
    const a = api();
    await runCloseChoice('close', a, 'o', 't1');
    expect(a.closeTab).toHaveBeenCalledWith('o', 't1');
    expect(a.handOver).not.toHaveBeenCalled();
  });
  it('cancel calls nothing', () => {
    const a = api();
    expect(runCloseChoice('cancel', a, 'o', 't1')).toBeNull();
    expect(a.handOver).not.toHaveBeenCalled();
    expect(a.closeTab).not.toHaveBeenCalled();
  });
});
