// Stick-to-bottom controller of the thread: when to follow the end as content grows, when to leave the reader alone,
// and when to show the "Jump to latest" button with its new-content dot. Pure: no DOM access, the view passes the
// scroll metrics in and applies the scrollTop that comes back.

/** How close to the end (px) still counts as "at the bottom". */
export const STICK_PX = 40;

export interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export interface StickState {
  /** The view follows the end as content grows. */
  pinned: boolean;
  /** Something new arrived while the view was not pinned. */
  hasNew: boolean;
}

const endOf = (m: ScrollMetrics): number => Math.max(0, m.scrollHeight - m.clientHeight);
const gapOf = (m: ScrollMetrics): number => m.scrollHeight - m.scrollTop - m.clientHeight;

export interface StickToBottom {
  state(): StickState;
  /**
   * A scroll event (the user, or our own scroll arriving late). Reaching the end (within STICK_PX) pins and clears the
   * new-content mark. Leaving it pins off only when the position moved up: content growing under a pending scroll event
   * widens the gap without the position moving, and must not count as the reader scrolling away.
   */
  onUserScroll(m: ScrollMetrics): void;
  /**
   * The content or the box changed size. Returns the scrollTop to set when pinned. Not pinned: a reader who is back within
   * STICK_PX of the end (the content shrank, the window grew) is pinned again and gets the scrollTop; otherwise `newContent`
   * (new entries, a permission card, longer streaming text, not a mere reflow or a fold opening) marks new content and null comes back.
   */
  onContentChange(m: ScrollMetrics, opts: { newContent: boolean }): number | null;
  /**
   * The reader shows intent to scroll up (wheel up, touch drag, PageUp/ArrowUp/Home) before the scroll event lands: unpin now, so
   * a content change in between does not pull the reader back. Inside the STICK_PX zone the unpin holds until the reader scrolls down.
   * An intent that moves nothing (a nested scroller took the wheel, a key on a control) is dropped by `onIntentSettled`.
   */
  onUserIntentUp(m: ScrollMetrics): void;
  /**
   * The reader shows intent to scroll down (wheel down, touch drag up, PageDown/ArrowDown/End/Space): a hold from an earlier up intent
   * ends, and within STICK_PX of the end the view is pinned again.
   */
  onUserIntentDown(m: ScrollMetrics): void;
  /**
   * A frame or two after an up intent, the view reports the position again with the one it had at the intent (`startTop`). Moved: the
   * scroll events decide, nothing to do. Not moved: the intent did nothing, so the hold ends and a reader who was pinned before it is
   * pinned again. Returns the scrollTop to set when that pins again (content may have grown meanwhile), else null.
   */
  onIntentSettled(m: ScrollMetrics, startTop: number): number | null;
  /** The user sent a message: follow again from the end. Returns the scrollTop to set. */
  onSend(m: ScrollMetrics): number;
  /** The Jump button: follow again, mark read. Returns the scrollTop to set. */
  jump(m: ScrollMetrics): number;
  /** A different thread is shown: pinned, nothing new. */
  reset(): void;
}

export function createStickToBottom(): StickToBottom {
  let pinned = true;
  let hasNew = false;
  let lastTop: number | null = null; // null: no position seen yet
  // The reader asked to scroll up inside the STICK_PX zone: stay unpinned there until the position moves down (or past the zone).
  let held = false;
  // An up intent waits for its scroll event; `prePinned` is whether the reader was following the end before it.
  let intent: { prePinned: boolean } | null = null;

  const follow = (m: ScrollMetrics): number => {
    pinned = true;
    hasNew = false;
    held = false;
    intent = null;
    // The position we scroll from, not the target: a smooth scroll reports positions below its target on the way down, which are not "moved up".
    lastTop = m.scrollTop;
    return endOf(m);
  };

  return {
    state: () => ({ pinned, hasNew }),
    onUserScroll(m) {
      const prev = lastTop;
      const movedUp = prev === null || m.scrollTop < prev;
      lastTop = m.scrollTop;
      if (gapOf(m) <= STICK_PX) {
        if (held && prev !== null && m.scrollTop <= prev) return; // still going up inside the zone
        pinned = true;
        hasNew = false;
        held = false;
      } else {
        held = false;
        if (movedUp) pinned = false;
      }
    },
    onContentChange(m, { newContent }) {
      lastTop = m.scrollTop;
      if (pinned) return endOf(m);
      if (gapOf(m) <= STICK_PX) {
        if (!held) return follow(m);
        if (newContent) hasNew = true;
        return null;
      }
      held = false;
      if (newContent) hasNew = true;
      return null;
    },
    onUserIntentUp(m) {
      if (m.scrollTop <= 0) return; // nothing above to scroll to
      if (!intent) intent = { prePinned: pinned };
      pinned = false;
      held = gapOf(m) <= STICK_PX;
      lastTop = m.scrollTop;
    },
    onUserIntentDown(m) {
      intent = null;
      held = false;
      if (gapOf(m) <= STICK_PX) {
        pinned = true;
        hasNew = false;
      }
    },
    onIntentSettled(m, startTop) {
      const pending = intent;
      intent = null;
      if (!pending || m.scrollTop !== startTop) return null;
      held = false;
      if (pending.prePinned || gapOf(m) <= STICK_PX) return follow(m);
      return null;
    },
    onSend: follow,
    jump: follow,
    reset() {
      pinned = true;
      hasNew = false;
      held = false;
      intent = null;
      lastTop = null;
    },
  };
}
