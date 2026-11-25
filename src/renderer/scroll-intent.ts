// What counts as "the reader means to scroll the thread" before the scroll event lands. Pure helpers (plain data in, answer out) plus one DOM
// walk (`nestedScrollerConsumes`) that gathers the data for them. The thread view feeds the answers to the stick-to-bottom controller.

export type Intent = 'up' | 'down';

/** Facts about a vertically scrollable box between the wheel's target and the thread body. */
export interface ScrollerInfo {
  overflowY: string;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Whether this box takes a wheel turn of `deltaY` itself (it scrolls, and is not already at the edge that turn pushes against). */
export function scrollerConsumes(s: ScrollerInfo, deltaY: number): boolean {
  if (!/^(auto|scroll|overlay)$/.test(s.overflowY)) return false;
  const max = s.scrollHeight - s.clientHeight;
  if (max <= 0) return false;
  return deltaY < 0 ? s.scrollTop > 0 : s.scrollTop < max - 1;
}

/** A wheel event as an intent: none for a mostly horizontal swipe, a zero turn, or one a nested scroller takes. */
export function wheelIntent(deltaX: number, deltaY: number, insideNestedScroller: boolean): Intent | null {
  if (insideNestedScroller || deltaY === 0 || Math.abs(deltaX) > Math.abs(deltaY)) return null;
  return deltaY < 0 ? 'up' : 'down';
}

/** The part of a keyboard target that decides whether a key scrolls the page or is taken by the control. */
export interface KeyTarget {
  tag: string;
  role: string | null;
  editable: boolean;
}

const CONTROL_TAGS = new Set(['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT', 'SUMMARY', 'OPTION']);
const CONTROL_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'tab', 'slider', 'spinbutton',
  'combobox', 'listbox', 'textbox', 'searchbox', 'scrollbar', 'tree', 'treeitem', 'grid', 'gridcell', 'menu', 'menubar', 'tablist',
]);

/** Whether the focused element handles arrow, page and space keys itself, so the key does not scroll the thread. */
export function isControlTarget(t: KeyTarget | null): boolean {
  if (!t) return false;
  return t.editable || CONTROL_TAGS.has(t.tag.toUpperCase()) || (t.role !== null && CONTROL_ROLES.has(t.role.toLowerCase()));
}

/** A key as an intent: PageUp/ArrowUp/Home (and Shift+Space) up, PageDown/ArrowDown/End/Space down; none when the target is a control. */
export function scrollKeyIntent(key: string, shift: boolean, target: KeyTarget | null): Intent | null {
  if (isControlTarget(target)) return null;
  switch (key) {
    case 'PageUp':
    case 'ArrowUp':
    case 'Home':
      return 'up';
    case 'PageDown':
    case 'ArrowDown':
    case 'End':
      return 'down';
    case ' ':
      return shift ? 'up' : 'down';
    default:
      return null;
  }
}

/** The facts `isControlTarget` needs, read from an event target (anything that is not an element has no facts: not a control). */
export function keyTargetOf(target: EventTarget | null): KeyTarget | null {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return null;
  return { tag: target.tagName, role: target.getAttribute('role'), editable: target.isContentEditable };
}

/** Walks from the wheel's target up to (not including) `root` and tells whether a box in between takes this wheel turn. */
export function nestedScrollerConsumes(target: EventTarget | null, root: HTMLElement, deltaY: number): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  for (let el: HTMLElement | null = target; el && el !== root; el = el.parentElement) {
    const info: ScrollerInfo = { overflowY: getComputedStyle(el).overflowY, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    if (scrollerConsumes(info, deltaY)) return true;
  }
  return false;
}
