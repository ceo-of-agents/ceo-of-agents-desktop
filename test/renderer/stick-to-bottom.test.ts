import { describe, expect, it } from 'vitest';
import { STICK_PX, createStickToBottom, type ScrollMetrics } from '../../src/renderer/stick-to-bottom';

/** A scroll box without a DOM: content height, viewport height, position. Applying a controller result scrolls it like the browser does. */
function box(scrollHeight: number, clientHeight = 500) {
  const b = {
    scrollHeight,
    clientHeight,
    scrollTop: Math.max(0, scrollHeight - clientHeight),
    metrics(): ScrollMetrics {
      return { scrollHeight: b.scrollHeight, scrollTop: b.scrollTop, clientHeight: b.clientHeight };
    },
    gap: () => b.scrollHeight - b.scrollTop - b.clientHeight,
    /** The content grows by `px` (streaming text, a step list, a card). */
    grow(px: number) {
      b.scrollHeight += px;
    },
    /** The reader scrolls to `top` by hand (a scroll event follows). */
    scrollTo(top: number) {
      b.scrollTop = Math.min(Math.max(0, top), b.scrollHeight - b.clientHeight);
    },
  };
  return b;
}

describe('stick to the bottom', () => {
  it('starts pinned with nothing new', () => {
    expect(createStickToBottom().state()).toEqual({ pinned: true, hasNew: false });
  });

  it('keeps the end in view while the last message grows, step after step', () => {
    const b = box(1200);
    const s = createStickToBottom();
    for (const px of [18, 22, 22, 44, 66, 22, 130, 22]) {
      b.grow(px);
      const top = s.onContentChange(b.metrics(), { newContent: true });
      expect(top).not.toBeNull();
      b.scrollTo(top!);
      s.onUserScroll(b.metrics()); // our own scroll event arrives
      expect(b.gap()).toBe(0);
    }
    expect(s.state()).toEqual({ pinned: true, hasNew: false });
  });

  it('is not unpinned by growth that lands before our own scroll event does', () => {
    const b = box(1200);
    const s = createStickToBottom();
    b.grow(300);
    b.scrollTo(s.onContentChange(b.metrics(), { newContent: true })!);
    b.grow(300); // more content before the scroll event is dispatched; the next resize callback has not run yet
    s.onUserScroll(b.metrics());
    expect(s.state().pinned).toBe(true);
    b.scrollTo(s.onContentChange(b.metrics(), { newContent: true })!);
    expect(b.gap()).toBe(0);
  });

  it('leaves the reader alone when scrolled up past the threshold, and marks new content', () => {
    const b = box(1200);
    const s = createStickToBottom();
    b.scrollTo(b.scrollTop - (STICK_PX + 1));
    s.onUserScroll(b.metrics());
    expect(s.state().pinned).toBe(false);
    const before = b.scrollTop;
    b.grow(60);
    expect(s.onContentChange(b.metrics(), { newContent: true })).toBeNull();
    expect(b.scrollTop).toBe(before);
    expect(s.state()).toEqual({ pinned: false, hasNew: true });
  });

  it('does not mark new content when nothing new arrived (a fold opens, a reflow), but keeps the reader where they are', () => {
    const b = box(1200);
    const s = createStickToBottom();
    b.scrollTo(100);
    s.onUserScroll(b.metrics());
    b.grow(80); // a step list unfolds
    expect(s.onContentChange(b.metrics(), { newContent: false })).toBeNull();
    expect(s.state()).toEqual({ pinned: false, hasNew: false });
    b.clientHeight -= 40; // the window got smaller
    expect(s.onContentChange(b.metrics(), { newContent: false })).toBeNull();
    expect(s.state().hasNew).toBe(false);
    b.grow(80); // new entries arrive
    expect(s.onContentChange(b.metrics(), { newContent: true })).toBeNull();
    expect(s.state()).toEqual({ pinned: false, hasNew: true });
  });

  it('still follows pinned growth of either kind', () => {
    const b = box(1200);
    const s = createStickToBottom();
    for (const newContent of [false, true]) {
      b.grow(60);
      expect(s.onContentChange(b.metrics(), { newContent })).toBe(b.scrollHeight - b.clientHeight);
    }
    expect(s.state()).toEqual({ pinned: true, hasNew: false });
  });

  it('pins again, and clears the mark, when the content shrinks until the reader is back at the end', () => {
    const b = box(1200);
    const s = createStickToBottom();
    b.scrollTo(b.scrollTop - 200);
    s.onUserScroll(b.metrics());
    b.grow(60); // the live line grows
    s.onContentChange(b.metrics(), { newContent: true });
    expect(s.state()).toEqual({ pinned: false, hasNew: true });
    b.grow(-(60 + 200 - STICK_PX)); // the live line is replaced by the shorter committed entry
    const top = s.onContentChange(b.metrics(), { newContent: false });
    expect(top).toBe(b.scrollHeight - b.clientHeight);
    expect(s.state()).toEqual({ pinned: true, hasNew: false });
    b.scrollTo(top!);
    b.grow(50);
    expect(s.onContentChange(b.metrics(), { newContent: true })).toBe(b.scrollHeight - b.clientHeight);
  });

  it('pins again when the window grows taller until the reader is back at the end', () => {
    const b = box(1200);
    const s = createStickToBottom();
    b.scrollTo(b.scrollTop - 200);
    s.onUserScroll(b.metrics());
    expect(s.state().pinned).toBe(false);
    b.clientHeight += 200 - STICK_PX; // the window got taller
    expect(s.onContentChange(b.metrics(), { newContent: false })).toBe(b.scrollHeight - b.clientHeight);
    expect(s.state()).toEqual({ pinned: true, hasNew: false });
  });

  it('stays unpinned when the shrink leaves the reader farther than the threshold from the end', () => {
    const b = box(1200);
    const s = createStickToBottom();
    b.scrollTo(b.scrollTop - 200);
    s.onUserScroll(b.metrics());
    b.grow(-(200 - STICK_PX - 1));
    expect(s.onContentChange(b.metrics(), { newContent: false })).toBeNull();
    expect(s.state().pinned).toBe(false);
  });

  it('intent to scroll up unpins right away, and the next content change does not move the scroll', () => {
    const b = box(1200);
    const s = createStickToBottom();
    b.scrollTo(b.scrollTop - 5); // a slow trackpad scroll, still inside the zone
    s.onUserIntentUp(b.metrics());
    expect(s.state().pinned).toBe(false);
    const before = b.scrollTop;
    b.grow(22); // streaming text lands before the scroll event does
    expect(s.onContentChange(b.metrics(), { newContent: true })).toBeNull();
    expect(b.scrollTop).toBe(before);
    s.onUserScroll(b.metrics()); // the scroll event, still inside the zone, does not pin again
    expect(s.state().pinned).toBe(false);
    b.scrollTo(b.scrollTop - 5);
    s.onUserScroll(b.metrics());
    b.grow(22);
    expect(s.onContentChange(b.metrics(), { newContent: false })).toBeNull();
    expect(s.state().pinned).toBe(false);
  });

  it('after an intent up inside the zone, scrolling down pins again', () => {
    const b = box(1200);
    const s = createStickToBottom();
    b.scrollTo(b.scrollTop - 10);
    s.onUserIntentUp(b.metrics());
    s.onUserScroll(b.metrics());
    expect(s.state().pinned).toBe(false);
    b.scrollTo(b.scrollTop + 5);
    s.onUserScroll(b.metrics());
    expect(s.state()).toEqual({ pinned: true, hasNew: false });
  });

  it('an up intent that moves nothing (a nested scroller took it) at the end pins again, with no Jump, and follows growth', () => {
    const b = box(1200);
    const s = createStickToBottom();
    const startTop = b.scrollTop;
    s.onUserIntentUp(b.metrics());
    expect(s.state().pinned).toBe(false);
    b.grow(22); // streaming text lands while the intent waits
    expect(s.onContentChange(b.metrics(), { newContent: true })).toBeNull();
    const top = s.onIntentSettled(b.metrics(), startTop); // no scroll event came
    expect(top).toBe(b.scrollHeight - b.clientHeight);
    expect(s.state()).toEqual({ pinned: true, hasNew: false });
    b.scrollTo(top!);
    b.grow(22);
    expect(s.onContentChange(b.metrics(), { newContent: true })).toBe(b.scrollHeight - b.clientHeight);
  });

  it('an up intent that moves nothing, with content grown past the threshold meanwhile, still follows for a reader who was pinned', () => {
    const b = box(1200);
    const s = createStickToBottom();
    const startTop = b.scrollTop;
    s.onUserIntentUp(b.metrics());
    b.grow(300);
    s.onContentChange(b.metrics(), { newContent: true });
    expect(s.onIntentSettled(b.metrics(), startTop)).toBe(b.scrollHeight - b.clientHeight);
    expect(s.state()).toEqual({ pinned: true, hasNew: false });
  });

  it('an up intent followed by a real scroll up past the threshold stays unpinned after the settle', () => {
    const b = box(1200);
    const s = createStickToBottom();
    const startTop = b.scrollTop;
    s.onUserIntentUp(b.metrics());
    b.scrollTo(b.scrollTop - (STICK_PX + 20));
    s.onUserScroll(b.metrics());
    expect(s.onIntentSettled(b.metrics(), startTop)).toBeNull();
    expect(s.state().pinned).toBe(false);
    b.grow(50);
    expect(s.onContentChange(b.metrics(), { newContent: true })).toBeNull();
    expect(s.state()).toEqual({ pinned: false, hasNew: true });
  });

  it('an up intent followed by a small real scroll up inside the zone stays unpinned after the settle', () => {
    const b = box(1200);
    const s = createStickToBottom();
    const startTop = b.scrollTop;
    s.onUserIntentUp(b.metrics());
    b.scrollTo(b.scrollTop - 5);
    s.onUserScroll(b.metrics());
    expect(s.onIntentSettled(b.metrics(), startTop)).toBeNull();
    expect(s.state().pinned).toBe(false);
    b.grow(22);
    expect(s.onContentChange(b.metrics(), { newContent: true })).toBeNull();
  });

  it('held does not stick after a settle: later growth inside the zone re-pins an unpinned reader', () => {
    const b = box(1200);
    const s = createStickToBottom();
    b.scrollTo(b.scrollTop - 10);
    const startTop = b.scrollTop;
    s.onUserIntentUp(b.metrics());
    expect(s.onContentChange(b.metrics(), { newContent: false })).toBeNull(); // held
    s.onIntentSettled(b.metrics(), startTop);
    expect(s.state().pinned).toBe(true);
    b.scrollTo(b.scrollTop - 5); // an unrelated scroll event inside the zone does not find a stale hold
    s.onUserScroll(b.metrics());
    expect(s.state().pinned).toBe(true);
  });

  it('a settle with no intent pending does nothing', () => {
    const b = box(1200);
    const s = createStickToBottom();
    expect(s.onIntentSettled(b.metrics(), b.scrollTop)).toBeNull();
    b.scrollTo(100);
    s.onUserScroll(b.metrics());
    expect(s.onIntentSettled(b.metrics(), 100)).toBeNull();
    expect(s.state().pinned).toBe(false);
  });

  it('an unpinned reader far above whose up intent moves nothing stays unpinned', () => {
    const b = box(1200);
    const s = createStickToBottom();
    b.scrollTo(300);
    s.onUserScroll(b.metrics());
    s.onUserIntentUp(b.metrics());
    expect(s.onIntentSettled(b.metrics(), 300)).toBeNull();
    expect(s.state().pinned).toBe(false);
  });

  it('a down intent within the threshold clears the hold and pins again', () => {
    const b = box(1200);
    const s = createStickToBottom();
    b.scrollTo(b.scrollTop - 10);
    s.onUserIntentUp(b.metrics());
    s.onUserScroll(b.metrics());
    expect(s.state().pinned).toBe(false);
    s.onUserIntentDown(b.metrics());
    expect(s.state()).toEqual({ pinned: true, hasNew: false });
    b.grow(22);
    expect(s.onContentChange(b.metrics(), { newContent: true })).toBe(b.scrollHeight - b.clientHeight);
  });

  it('a down intent far from the end does not pin, and the settle of an earlier up intent is then a no-op', () => {
    const b = box(1200);
    const s = createStickToBottom();
    b.scrollTo(200);
    s.onUserScroll(b.metrics());
    s.onUserIntentUp(b.metrics());
    s.onUserIntentDown(b.metrics());
    expect(s.state().pinned).toBe(false);
    expect(s.onIntentSettled(b.metrics(), 200)).toBeNull();
    expect(s.state().pinned).toBe(false);
  });

  it('an intent up with nothing above to scroll to is ignored', () => {
    const b = box(300);
    const s = createStickToBottom();
    s.onUserIntentUp(b.metrics());
    expect(s.state().pinned).toBe(true);
  });

  it('counts a position within the threshold as the bottom', () => {
    const b = box(1200);
    const s = createStickToBottom();
    b.scrollTo(b.scrollTop - STICK_PX);
    s.onUserScroll(b.metrics());
    expect(s.state().pinned).toBe(true);
    b.grow(100);
    expect(s.onContentChange(b.metrics(), { newContent: true })).toBe(b.scrollHeight - b.clientHeight);
  });

  it('stays pinned while the reader creeps up inside the threshold, and lets go past it', () => {
    const b = box(1200);
    const s = createStickToBottom();
    for (let i = 0; i < STICK_PX; i += 10) {
      b.scrollTo(b.scrollTop - 10);
      s.onUserScroll(b.metrics());
    }
    expect(s.state().pinned).toBe(true);
    b.scrollTo(b.scrollTop - 10);
    s.onUserScroll(b.metrics());
    expect(s.state().pinned).toBe(false);
  });

  it('sending a message pins, clears the mark and goes to the end', () => {
    const b = box(1200);
    const s = createStickToBottom();
    b.scrollTo(0);
    s.onUserScroll(b.metrics());
    b.grow(50);
    s.onContentChange(b.metrics(), { newContent: true });
    expect(s.state()).toEqual({ pinned: false, hasNew: true });
    const top = s.onSend(b.metrics());
    expect(top).toBe(b.scrollHeight - b.clientHeight);
    expect(s.state()).toEqual({ pinned: true, hasNew: false });
    b.scrollTo(top);
    b.grow(80); // the reply starts
    expect(s.onContentChange(b.metrics(), { newContent: true })).toBe(b.scrollHeight - b.clientHeight);
  });

  it('jumping pins, clears the mark and resumes following', () => {
    const b = box(1200);
    const s = createStickToBottom();
    b.scrollTo(200);
    s.onUserScroll(b.metrics());
    b.grow(40);
    s.onContentChange(b.metrics(), { newContent: true });
    expect(s.state().hasNew).toBe(true);
    const top = s.jump(b.metrics());
    expect(s.state()).toEqual({ pinned: true, hasNew: false });
    // A smooth scroll reports positions below its target on the way: they must not unpin.
    for (const at of [300, 500, 700]) {
      b.scrollTo(at);
      s.onUserScroll(b.metrics());
      expect(s.state().pinned).toBe(true);
    }
    b.scrollTo(top);
    s.onUserScroll(b.metrics());
    b.grow(100);
    expect(s.onContentChange(b.metrics(), { newContent: true })).toBe(b.scrollHeight - b.clientHeight);
  });

  it('scrolling back to the end by hand resumes following and clears the mark', () => {
    const b = box(1200);
    const s = createStickToBottom();
    b.scrollTo(100);
    s.onUserScroll(b.metrics());
    b.grow(200);
    expect(s.onContentChange(b.metrics(), { newContent: true })).toBeNull();
    expect(s.state()).toEqual({ pinned: false, hasNew: true });
    b.scrollTo(b.scrollHeight);
    s.onUserScroll(b.metrics());
    expect(s.state()).toEqual({ pinned: true, hasNew: false });
    b.grow(50);
    expect(s.onContentChange(b.metrics(), { newContent: true })).toBe(b.scrollHeight - b.clientHeight);
  });

  it('shows the end of a thread that is shorter than the window, and follows when it overflows', () => {
    const b = box(300);
    const s = createStickToBottom();
    expect(s.onContentChange(b.metrics(), { newContent: true })).toBe(0);
    b.grow(400);
    expect(s.onContentChange(b.metrics(), { newContent: true })).toBe(200);
  });

  it('a new thread starts pinned and unmarked', () => {
    const b = box(1200);
    const s = createStickToBottom();
    b.scrollTo(0);
    s.onUserScroll(b.metrics());
    b.grow(10);
    s.onContentChange(b.metrics(), { newContent: true });
    s.reset();
    expect(s.state()).toEqual({ pinned: true, hasNew: false });
  });
});
