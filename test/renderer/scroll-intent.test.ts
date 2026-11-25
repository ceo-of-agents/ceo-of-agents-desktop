import { describe, expect, it } from 'vitest';
import { isControlTarget, scrollKeyIntent, scrollerConsumes, wheelIntent } from '../../src/renderer/scroll-intent';

const target = (tag: string, role: string | null = null, editable = false) => ({ tag, role, editable });

describe('wheelIntent', () => {
  it('reads the vertical direction', () => {
    expect(wheelIntent(0, -40, false)).toBe('up');
    expect(wheelIntent(0, 40, false)).toBe('down');
    expect(wheelIntent(5, -40, false)).toBe('up');
  });
  it('ignores a mostly horizontal or diagonal-dominant swipe, a zero turn, and a nested scroller', () => {
    expect(wheelIntent(-60, -20, false)).toBeNull();
    expect(wheelIntent(60, 20, false)).toBeNull();
    expect(wheelIntent(30, 0, false)).toBeNull();
    expect(wheelIntent(0, 0, false)).toBeNull();
    expect(wheelIntent(0, -40, true)).toBeNull();
    expect(wheelIntent(0, 40, true)).toBeNull();
  });
});

describe('scrollerConsumes', () => {
  const box = { overflowY: 'auto', scrollTop: 50, scrollHeight: 400, clientHeight: 200 };
  it('takes the wheel while it can scroll that way', () => {
    expect(scrollerConsumes(box, -10)).toBe(true);
    expect(scrollerConsumes(box, 10)).toBe(true);
    expect(scrollerConsumes({ ...box, overflowY: 'scroll' }, -10)).toBe(true);
  });
  it('lets the wheel through at the edge it pushes against', () => {
    expect(scrollerConsumes({ ...box, scrollTop: 0 }, -10)).toBe(false);
    expect(scrollerConsumes({ ...box, scrollTop: 200 }, 10)).toBe(false);
    expect(scrollerConsumes({ ...box, scrollTop: 0 }, 10)).toBe(true);
  });
  it('does not take it when it does not scroll vertically', () => {
    expect(scrollerConsumes({ ...box, overflowY: 'visible' }, -10)).toBe(false);
    expect(scrollerConsumes({ ...box, overflowY: 'hidden' }, -10)).toBe(false);
    expect(scrollerConsumes({ ...box, scrollHeight: 200 }, -10)).toBe(false); // a code block that only scrolls sideways
  });
});

describe('scrollKeyIntent', () => {
  const body = target('DIV');
  it('maps the scrolling keys when the target is plain content', () => {
    for (const k of ['PageUp', 'ArrowUp', 'Home']) expect(scrollKeyIntent(k, false, body)).toBe('up');
    for (const k of ['PageDown', 'ArrowDown', 'End', ' ']) expect(scrollKeyIntent(k, false, body)).toBe('down');
    expect(scrollKeyIntent(' ', true, body)).toBe('up');
    expect(scrollKeyIntent('a', false, body)).toBeNull();
    expect(scrollKeyIntent('Enter', false, body)).toBeNull();
    expect(scrollKeyIntent('ArrowUp', false, null)).toBe('up');
  });
  it('ignores a key on a control', () => {
    for (const t of [target('BUTTON'), target('A'), target('INPUT'), target('TEXTAREA'), target('SELECT'), target('DIV', 'button'), target('DIV', 'menuitem'), target('DIV', null, true)]) {
      expect(isControlTarget(t)).toBe(true);
      expect(scrollKeyIntent('ArrowUp', false, t)).toBeNull();
      expect(scrollKeyIntent('PageUp', false, t)).toBeNull();
      expect(scrollKeyIntent(' ', false, t)).toBeNull();
    }
    expect(isControlTarget(target('DIV', 'article'))).toBe(false);
    expect(isControlTarget(target('div'))).toBe(false);
    expect(isControlTarget(target('button'))).toBe(true);
  });
});
