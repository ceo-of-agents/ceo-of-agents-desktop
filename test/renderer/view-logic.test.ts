import { describe, expect, it } from 'vitest';
import { CHART_VIEW, closeChart, currentChat, isChartOpen, openChart, tabOrder, toggleChart, viewFor, type ChartOpen } from '../../src/renderer/view-logic';

const tabs = [{ tabId: 'a1' }, { tabId: 'b2' }];

describe('tabOrder', () => {
  it('is the chief of staff then the department chats, never the chart', () => {
    expect(tabOrder(tabs)).toEqual(['cos', 'tab:a1', 'tab:b2']);
    expect(tabOrder([])).toEqual(['cos']);
    expect(tabOrder(tabs)).not.toContain(CHART_VIEW);
  });
});

describe('chart open state', () => {
  it('opens, closes and toggles per org, returning the same object when nothing changes', () => {
    const none: ChartOpen = {};
    expect(isChartOpen(none, 'x')).toBe(false);
    const open = openChart(none, 'x');
    expect(isChartOpen(open, 'x')).toBe(true);
    expect(openChart(open, 'x')).toBe(open);
    const closed = closeChart(open, 'x');
    expect(isChartOpen(closed, 'x')).toBe(false);
    expect(closeChart(closed, 'x')).toBe(closed);
    expect(closeChart(none, 'x')).toBe(none);
    expect(isChartOpen(toggleChart(none, 'x'), 'x')).toBe(true);
    expect(isChartOpen(toggleChart(open, 'x'), 'x')).toBe(false);
  });

  it('keeps orgs independent', () => {
    const a = openChart({}, 'a');
    expect(viewFor(a, 'a')).toBe('chart');
    expect(viewFor(a, 'b')).toBe('chat');
    const both = openChart(a, 'b');
    const bClosed = closeChart(both, 'b');
    expect(viewFor(bClosed, 'a')).toBe('chart');
    expect(viewFor(bClosed, 'b')).toBe('chat');
  });
});

describe('chart and chats', () => {
  it('selecting a chat closes the chart (the select step is closeChart on the org)', () => {
    let open: ChartOpen = openChart({}, 'x');
    let selected: Record<string, string> = { x: 'cos' };
    // What App.select does for a chat: remember it and close the chart for that org.
    selected = { ...selected, x: 'tab:a1' };
    open = closeChart(open, 'x');
    expect(viewFor(open, 'x')).toBe('chat');
    expect(currentChat(selected.x, tabs)).toBe('tab:a1');
  });

  it('keeps the last chat while the chart is open and shows it again on close', () => {
    const selected = { x: 'tab:b2' };
    let open: ChartOpen = {};
    open = openChart(open, 'x');
    expect(viewFor(open, 'x')).toBe('chart');
    expect(currentChat(selected.x, tabs)).toBe('tab:b2');
    open = closeChart(open, 'x');
    expect(viewFor(open, 'x')).toBe('chat');
    expect(currentChat(selected.x, tabs)).toBe('tab:b2');
  });

  it('falls back to the chief of staff when the remembered chat was closed meanwhile', () => {
    const open = openChart({}, 'x');
    expect(isChartOpen(open, 'x')).toBe(true);
    expect(currentChat('tab:b2', [{ tabId: 'a1' }])).toBe('cos');
    expect(currentChat('tab:b2', [])).toBe('cos');
  });

  it('defaults to the chief of staff and never resolves to the chart id', () => {
    expect(currentChat(undefined, tabs)).toBe('cos');
    expect(currentChat('cos', tabs)).toBe('cos');
    expect(currentChat(CHART_VIEW, tabs)).toBe('cos');
  });
});
