import { describe, expect, it, vi } from 'vitest';
import { draftText } from '../../src/renderer/draft-text';

describe('draftText', () => {
  it('keeps the text per chat and tells only that chat\'s listeners', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = draftText.subscribe('o1|cos', a);
    draftText.subscribe('o1|t2', b);
    draftText.set('o1|cos', 'hello');
    expect(draftText.get('o1|cos')).toBe('hello');
    expect(draftText.get('o1|t2')).toBe('');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    draftText.set('o1|cos', 'hello'); // same text: no change
    expect(a).toHaveBeenCalledTimes(1);
    offA();
    draftText.set('o1|cos', 'hello again');
    expect(a).toHaveBeenCalledTimes(1);
    draftText.set('o1|cos', '');
    draftText.set('o1|t2', '');
  });

  it('forgets a chat, or a whole org, and tells the listeners', () => {
    const l = vi.fn();
    draftText.set('o2|cos', 'a');
    draftText.set('o2|t1', 'b');
    draftText.set('o3|cos', 'c');
    const off = draftText.subscribe('o2|cos', l);
    draftText.deleteOrg('o2');
    expect(draftText.get('o2|cos')).toBe('');
    expect(draftText.get('o2|t1')).toBe('');
    expect(draftText.get('o3|cos')).toBe('c');
    expect(l).toHaveBeenCalledTimes(1);
    draftText.delete('o3|cos');
    expect(draftText.size()).toBe(0);
    off();
  });
});
