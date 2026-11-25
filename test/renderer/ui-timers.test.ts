import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPausableTimer, createTooltipController, mergeToastRows, type ToastRow } from '../../src/renderer/ui/timers';
import { trapIndex } from '../../src/renderer/ui/hooks';
import { nextTabId } from '../../src/renderer/logic';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createPausableTimer', () => {
  it('fires once after the time', () => {
    const done = vi.fn();
    createPausableTimer(6000, done).start();
    vi.advanceTimersByTime(5999);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(done).toHaveBeenCalledTimes(1);
  });
  it('pausing keeps the time that is left, resuming continues from it', () => {
    const done = vi.fn();
    const t = createPausableTimer(6000, done);
    t.start();
    vi.advanceTimersByTime(4000);
    t.pause();
    expect(t.remaining()).toBe(2000);
    vi.advanceTimersByTime(60000);
    expect(done).not.toHaveBeenCalled();
    t.resume();
    vi.advanceTimersByTime(1999);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(done).toHaveBeenCalledTimes(1);
  });
  it('can be paused several times and never fires after cancel', () => {
    const done = vi.fn();
    const t = createPausableTimer(1000, done);
    t.start();
    vi.advanceTimersByTime(300);
    t.pause();
    t.resume();
    vi.advanceTimersByTime(300);
    t.pause();
    expect(t.remaining()).toBe(400);
    t.resume();
    t.cancel();
    vi.advanceTimersByTime(5000);
    expect(done).not.toHaveBeenCalled();
  });
});

describe('createTooltipController', () => {
  it('shows after the hover delay, not before', () => {
    const seen: boolean[] = [];
    const c = createTooltipController(400, (v) => seen.push(v));
    c.hover();
    vi.advanceTimersByTime(399);
    expect(c.isVisible()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(c.isVisible()).toBe(true);
    expect(seen).toEqual([true]);
  });
  it('leaving before the delay never shows it', () => {
    const c = createTooltipController(400, () => undefined);
    c.hover();
    vi.advanceTimersByTime(200);
    c.hide();
    vi.advanceTimersByTime(1000);
    expect(c.isVisible()).toBe(false);
  });
  it('keyboard focus shows it at once and cancels a pending hover', () => {
    const seen: boolean[] = [];
    const c = createTooltipController(400, (v) => seen.push(v));
    c.hover();
    c.focus();
    expect(c.isVisible()).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([true]);
    c.hide();
    expect(seen).toEqual([true, false]);
  });
});

describe('mergeToastRows', () => {
  const n = (id: number) => ({ id, orgId: null, text: `t${id}` });
  it('appends new notices as open', () => {
    expect(mergeToastRows([], [n(1), n(2)]).map((r) => [r.notice.id, r.phase])).toEqual([[1, 'open'], [2, 'open']]);
  });
  it('keeps a removed notice as fading so it can leave', () => {
    const rows = mergeToastRows([], [n(1), n(2)]);
    const next = mergeToastRows(rows, [n(2)]);
    expect(next.map((r) => [r.notice.id, r.phase])).toEqual([[1, 'fading'], [2, 'open']]);
  });
  it('does not push a collapsing row back to fading', () => {
    const rows: ToastRow<ReturnType<typeof n>>[] = [{ notice: n(1), phase: 'collapsing' }];
    expect(mergeToastRows(rows, [])[0].phase).toBe('collapsing');
  });
});

describe('trapIndex', () => {
  it('wraps at both ends and enters from outside', () => {
    expect(trapIndex(3, 2, false)).toBe(0);
    expect(trapIndex(3, 0, true)).toBe(2);
    expect(trapIndex(3, -1, false)).toBe(0);
    expect(trapIndex(3, -1, true)).toBe(2);
    expect(trapIndex(0, -1, false)).toBe(-1);
  });
});

describe('nextTabId', () => {
  const ids = ['cos', 'tab:a', 'tab:b'];
  it('moves with the arrows and wraps', () => {
    expect(nextTabId(ids, 'cos', 'ArrowRight')).toBe('tab:a');
    expect(nextTabId(ids, 'tab:b', 'ArrowRight')).toBe('cos');
    expect(nextTabId(ids, 'cos', 'ArrowLeft')).toBe('tab:b');
    expect(nextTabId(ids, 'tab:a', 'Home')).toBe('cos');
    expect(nextTabId(ids, 'tab:a', 'End')).toBe('tab:b');
  });
  it('ignores other keys and unknown tabs', () => {
    expect(nextTabId(ids, 'cos', 'a')).toBeNull();
    expect(nextTabId(ids, 'nope', 'ArrowRight')).toBeNull();
  });
});
