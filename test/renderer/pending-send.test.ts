import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPendingStore, SENT_GRACE_MS, UNDO_MS } from '../../src/renderer/pending-send';

describe('pending send (undo window)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits 4 s, then sends once and shows "sent"', () => {
    const store = createPendingStore();
    const send = vi.fn(() => Promise.resolve());
    expect(store.start('o1', 'A-1', 'approve', undefined, send)).toBe(true);
    expect(store.get('o1', 'A-1')?.stage).toBe('undo');
    vi.advanceTimersByTime(UNDO_MS - 1);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.get('o1', 'A-1')?.stage).toBe('sent');
  });

  it('undo cancels the send', () => {
    const store = createPendingStore();
    const send = vi.fn();
    store.start('o1', 'A-1', 'done', undefined, send);
    vi.advanceTimersByTime(1000);
    expect(store.undo('o1', 'A-1')).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(send).not.toHaveBeenCalled();
    expect(store.get('o1', 'A-1')).toBeUndefined();
  });

  it('cannot undo after the message was sent', () => {
    const store = createPendingStore();
    store.start('o1', 'A-1', 'approve', undefined, () => undefined);
    vi.advanceTimersByTime(UNDO_MS);
    expect(store.undo('o1', 'A-1')).toBe(false);
  });

  it('keeps one state per org and code: another org never sees it, the same code in two orgs does not clash', () => {
    const store = createPendingStore();
    const a = vi.fn();
    const b = vi.fn();
    store.start('o1', 'A-1', 'approve', undefined, a);
    expect(store.get('o2', 'A-1')).toBeUndefined();
    expect(store.start('o2', 'A-1', 'decline', undefined, b)).toBe(true);
    store.undo('o2', 'A-1');
    vi.advanceTimersByTime(UNDO_MS);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });

  it('still sends when nothing observes it (the org was switched away): the user chose it', () => {
    const store = createPendingStore();
    const send = vi.fn();
    store.start('o1', 'A-1', 'option', 'b', send);
    // no subscriber, no observe call: the timer lives in the store
    vi.advanceTimersByTime(UNDO_MS);
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.get('o1', 'A-1')).toMatchObject({ kind: 'option', optionKey: 'b' });
  });

  it('refuses a second start for the same item while one is pending', () => {
    const store = createPendingStore();
    expect(store.start('o1', 'A-1', 'approve', undefined, () => undefined)).toBe(true);
    expect(store.start('o1', 'A-1', 'decline', undefined, () => undefined)).toBe(false);
  });

  it('clears the state when the send fails', async () => {
    const store = createPendingStore();
    store.start('o1', 'A-1', 'approve', undefined, () => Promise.reject(new Error('x')));
    await vi.advanceTimersByTimeAsync(UNDO_MS);
    expect(store.get('o1', 'A-1')).toBeUndefined();
  });

  it('observe: a sent item that left the list is cleared', () => {
    const store = createPendingStore();
    store.start('o1', 'A-1', 'approve', undefined, () => undefined);
    vi.advanceTimersByTime(UNDO_MS);
    store.observe('o1', true, new Set(['A-1']), Date.now());
    expect(store.get('o1', 'A-1')?.sawBusy).toBe(true);
    store.observe('o1', true, new Set(), Date.now());
    expect(store.get('o1', 'A-1')).toBeUndefined();
  });

  it('observe: still there when the chief of staff turn ends: back to normal', () => {
    const store = createPendingStore();
    store.start('o1', 'A-1', 'approve', undefined, () => undefined);
    vi.advanceTimersByTime(UNDO_MS);
    store.observe('o1', false, new Set(['A-1']), null);
    expect(store.get('o1', 'A-1')?.stage).toBe('sent'); // the turn has not started yet
    store.observe('o1', true, new Set(['A-1']), Date.now());
    store.observe('o1', false, new Set(['A-1']), null);
    expect(store.get('o1', 'A-1')).toBeUndefined();
  });

  it('observe: ignores other orgs and items still in their undo window', () => {
    const store = createPendingStore();
    store.start('o1', 'A-1', 'approve', undefined, () => undefined);
    store.observe('o1', false, new Set(), null);
    expect(store.get('o1', 'A-1')?.stage).toBe('undo');
    vi.advanceTimersByTime(UNDO_MS);
    store.observe('o2', false, new Set(), null);
    expect(store.get('o1', 'A-1')?.stage).toBe('sent');
  });

  it('gives up on "sent" when the turn never starts', () => {
    const store = createPendingStore();
    store.start('o1', 'A-1', 'approve', undefined, () => undefined);
    vi.advanceTimersByTime(UNDO_MS + SENT_GRACE_MS);
    expect(store.get('o1', 'A-1')).toBeUndefined();
  });

  it('does not give up while the turn is running', () => {
    const store = createPendingStore();
    store.start('o1', 'A-1', 'approve', undefined, () => undefined);
    vi.advanceTimersByTime(UNDO_MS);
    store.observe('o1', true, new Set(['A-1']), Date.now());
    vi.advanceTimersByTime(SENT_GRACE_MS * 3);
    expect(store.get('o1', 'A-1')?.stage).toBe('sent');
  });

  it('busy at send time: the earlier turn does not count, the card stays "sent" until its own turn ends', () => {
    const store = createPendingStore();
    const send = vi.fn(() => Promise.resolve());
    const earlier = Date.now(); // the chief of staff is already working on another message
    store.observe('o1', true, new Set(['A-1']), earlier);
    vi.advanceTimersByTime(1000);
    store.start('o1', 'A-1', 'approve', undefined, send);
    vi.advanceTimersByTime(UNDO_MS);
    expect(send).toHaveBeenCalledTimes(1);
    store.observe('o1', true, new Set(['A-1']), earlier);
    expect(store.get('o1', 'A-1')?.sawBusy).toBe(false);
    // the earlier turn runs past the grace time: still "sent", so the buttons do not come back
    vi.advanceTimersByTime(SENT_GRACE_MS * 2);
    expect(store.get('o1', 'A-1')?.stage).toBe('sent');
    // the earlier turn ends: our message is still queued, the card must not return to normal
    store.observe('o1', false, new Set(['A-1']), null);
    expect(store.get('o1', 'A-1')?.stage).toBe('sent');
    // our turn starts, then ends with the item still there: back to normal
    vi.advanceTimersByTime(10);
    store.observe('o1', true, new Set(['A-1']), Date.now());
    expect(store.get('o1', 'A-1')?.sawBusy).toBe(true);
    store.observe('o1', false, new Set(['A-1']), null);
    expect(store.get('o1', 'A-1')).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('busy at send time with no idle gap between turns: counts the next turn by its start time', () => {
    const store = createPendingStore();
    const earlier = Date.now();
    vi.advanceTimersByTime(500);
    store.start('o1', 'A-1', 'done', undefined, () => undefined);
    vi.advanceTimersByTime(UNDO_MS);
    store.observe('o1', true, new Set(['A-1']), earlier);
    expect(store.get('o1', 'A-1')?.sawBusy).toBe(false);
    vi.advanceTimersByTime(10);
    store.observe('o1', true, new Set(['A-1']), Date.now());
    expect(store.get('o1', 'A-1')?.sawBusy).toBe(true);
    store.observe('o1', false, new Set(['A-1']), null);
    expect(store.get('o1', 'A-1')).toBeUndefined();
  });

  it('notifies subscribers on every change', () => {
    const store = createPendingStore();
    const l = vi.fn();
    const off = store.subscribe(l);
    store.start('o1', 'A-1', 'approve', undefined, () => undefined);
    const v = store.version();
    store.undo('o1', 'A-1');
    expect(l).toHaveBeenCalledTimes(2);
    expect(store.version()).toBeGreaterThan(v);
    off();
    store.start('o1', 'A-2', 'done', undefined, () => undefined);
    expect(l).toHaveBeenCalledTimes(2);
  });
});
