// Pure helpers of the side panel (restyle pass 3): whole-panel collapse, the keyboard shortcut, option labels,
// the order of waiting items, the "Recent chats" list of a department. No React, no window: tested in test/renderer/panel-logic.test.ts.
import type { OrgId, PluginActionState, PrereqStatus, SignInState, WaitingItem } from '../shared/types';
import { stripMarkdown } from './markdown-safety';
import { prereqChecks, waitingButtons, type KeyValueStorage, type PrereqId } from './logic';

// ---------- whole-panel collapse ----------

export const panelHiddenKey = (orgId: OrgId): string => `coa.panelHidden.${orgId}`;

/** True when the user hid the whole side panel of this org. Missing or bad data means shown. */
export function loadPanelHidden(storage: KeyValueStorage, orgId: OrgId): boolean {
  try {
    return storage.getItem(panelHiddenKey(orgId)) === '1';
  } catch {
    return false;
  }
}

export function savePanelHidden(storage: KeyValueStorage, orgId: OrgId, hidden: boolean): void {
  try {
    storage.setItem(panelHiddenKey(orgId), hidden ? '1' : '0');
  } catch {
    // storage full or blocked: the state just is not remembered
  }
}

/** The subset of a keyboard event the shortcut check reads. */
export interface KeyLike {
  code: string;
  metaKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}

/** Cmd+Option+S. Matched on the physical key (`code`), because Option+S types another character (`key` is "ss" on a Mac). */
export function isPanelShortcut(e: KeyLike): boolean {
  return e.code === 'KeyS' && e.metaKey && e.altKey && !e.ctrlKey && !e.shiftKey;
}

// ---------- waiting items ----------

export const OPTION_LABEL_MAX = 32;

/** An option label cut to `max` characters with an ellipsis (whole text when it fits). Counts characters, not UTF-16 units. */
export function cutLabel(label: string, max: number = OPTION_LABEL_MAX): string {
  const flat = label.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

/** True when any option label of the item is longer than the button limit (counted on the text without Markdown markers). */
export function hasLongOption(item: WaitingItem, max: number = OPTION_LABEL_MAX): boolean {
  return (item.options ?? []).some((o) => Array.from(stripMarkdown(o.label).replace(/\s+/g, ' ').trim()).length > max);
}

/** Urgent items first, then the oldest first; an item without a date goes after the dated ones. Stable, does not change the input. */
export function sortWaiting(items: WaitingItem[]): WaitingItem[] {
  const day = (w: WaitingItem) => (w.since && /^\d{4}-\d{2}-\d{2}/.test(w.since) ? w.since.slice(0, 10) : null);
  return items
    .map((w, i) => ({ w, i }))
    .sort((a, b) => {
      const ua = a.w.urgency === 'high' ? 0 : 1;
      const ub = b.w.urgency === 'high' ? 0 : 1;
      if (ua !== ub) return ua - ub;
      const da = day(a.w);
      const db = day(b.w);
      if (da !== db) return da === null ? 1 : db === null ? -1 : da < db ? -1 : 1;
      return a.i - b.i;
    })
    .map((x) => x.w);
}

/** A top-level item with the items listed under it (plugin schemas state/1 and todo/1, "Parent and child items"); `children` is empty for a plain item. */
export interface WaitingGroup {
  item: WaitingItem;
  children: WaitingItem[];
}

/**
 * The panel's groups: the top-level items in `sortWaiting` order (so a group sits where its parent's urgency and date put it),
 * each with its children in the order of the hq file. An item whose `parent` is not in the list is shown as a top-level item.
 */
export function groupWaiting(items: WaitingItem[]): WaitingGroup[] {
  const codes = new Set(items.map((i) => i.code));
  const kids = new Map<string, WaitingItem[]>();
  const tops: WaitingItem[] = [];
  for (const i of items) {
    if (i.parent && i.parent !== i.code && codes.has(i.parent)) kids.set(i.parent, [...(kids.get(i.parent) ?? []), i]);
    else tops.push(i);
  }
  return sortWaiting(tops).map((item) => ({ item, children: kids.get(item.code) ?? [] }));
}

/** The groups one after the other: each parent, then its children. */
export const flattenGroups = (groups: readonly WaitingGroup[]): WaitingItem[] => groups.flatMap((g) => [g.item, ...g.children]);

/** "6 November" (with the year when it is not the current one) from a YYYY-MM-DD date, read as a local day. Empty when unknown. */
export function sinceLabel(since: string | null, now: Date = new Date(), locale?: string): string {
  const m = since ? /^(\d{4})-(\d{2})-(\d{2})/.exec(since) : null;
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'long', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
}

/** "17 Nov" (with the year when it is not the current one) from a YYYY-MM-DD date, read as a local day. Empty when unknown. */
export function dayLabel(day: string | null, now: Date = new Date(), locale: string | undefined = 'en-GB'): string {
  const m = day ? /^(\d{4})-(\d{2})-(\d{2})/.exec(day) : null;
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
}

// ---------- waiting item actions (5.9) ----------

export type ActionVariant = 'secondary' | 'you' | 'you-outline' | 'quiet';
export type ActionId = 'approve' | 'decline' | 'done' | 'answer' | 'reply' | 'option';

export interface ActionSpec {
  id: ActionId;
  variant: ActionVariant;
  /** Set for an option: its letter and its label (Markdown source). */
  optionKey?: string;
  optionLabel?: string;
}

/** String key of the kind chip of a waiting item: a todo item (T) has its own label, the others follow their kind tag; null when untagged. */
export const waitingKindKey = (item: WaitingItem): string | null => (item.action === 'wait' ? 'waiting.kind.wait' : item.kind === 'T' ? 'waiting.kind.todo' : item.action ? `waiting.kind.${item.action}` : null);

export const MAX_OPTION_BUTTONS = 3;

/**
 * The buttons of a waiting item, by kind (the table of 5.9): one primary action per kind and Reply on every item.
 * An item without a kind tag gets Reply only, as a secondary button: the app cannot know the right action.
 * `more` holds the options after the third: they unfold under "More options".
 */
export function waitingActionSpecs(item: WaitingItem): { visible: ActionSpec[]; more: ActionSpec[] } {
  const untagged = item.action === null;
  const specs: ActionSpec[] = waitingButtons(item).map((b): ActionSpec => {
    if (b === 'approve' || b === 'done' || b === 'answer') return { id: b, variant: 'you' };
    if (b === 'decline') return { id: 'decline', variant: 'secondary' };
    if (b === 'reply') return { id: 'reply', variant: untagged ? 'secondary' : 'quiet' };
    const key = b.slice('option:'.length);
    return { id: 'option', variant: 'you-outline', optionKey: key, optionLabel: item.options?.find((o) => o.key === key)?.label ?? key };
  });
  const options = specs.filter((s) => s.id === 'option');
  if (options.length <= MAX_OPTION_BUTTONS) return { visible: specs, more: [] };
  const more = options.slice(MAX_OPTION_BUTTONS);
  return { visible: specs.filter((s) => !more.includes(s)), more };
}

/** Rows of a list whose removed items stay for a while, marked `leaving`, so they can animate out. */
export interface LeavingRow<T> {
  key: string;
  item: T;
  leaving: boolean;
}

/** The current items in order, plus the rows that were in `prev` and are gone, kept (leaving) at their old position. */
export function mergeLeaving<T>(prev: LeavingRow<T>[], items: T[], keyOf: (x: T) => string): LeavingRow<T>[] {
  const rows: LeavingRow<T>[] = items.map((item) => ({ key: keyOf(item), item, leaving: false }));
  const live = new Set(rows.map((r) => r.key));
  prev.forEach((r, i) => {
    if (live.has(r.key)) return;
    rows.splice(Math.min(i, rows.length), 0, { ...r, leaving: true });
  });
  return rows;
}

// ---------- departments: how a recent chat is shown ----------

/** Key of the string that says what a pending (undo window) message is doing. */
export const pendingLabelKeyOf = (kind: 'approve' | 'decline' | 'done' | 'option'): string => `waiting.pending.${kind}`;

// ---------- prerequisites (5.14) ----------

export type PrereqMark = 'done' | 'action' | 'failed' | 'checking' | 'waiting';

/**
 * The mark of one prerequisite row. done: all good. action: something the user must do (install, sign in).
 * failed: the check itself failed, or an install or sign-in went wrong. checking: a check, install or sign-in is running.
 * waiting: cannot be checked yet (it depends on another step).
 */
export function prereqMark(id: PrereqId, p: PrereqStatus, signIn: SignInState, pluginAction: PluginActionState | null, rechecking = false): PrereqMark {
  const ok = prereqChecks(p).find((c) => c.id === id)?.ok ?? null;
  if (id === 'signin') {
    if (signIn.running) return 'checking';
    if (ok === true) return 'done';
    if (signIn.error) return 'failed';
    if (ok === null) return 'waiting';
    return rechecking ? 'checking' : 'action';
  }
  if (id === 'plugin') {
    if (pluginAction?.running && pluginAction.action === 'install') return 'checking';
    if (ok === true) return 'done';
    if (pluginAction?.error || p.plugin?.state === 'unknown') return 'failed';
    if (ok === null) return 'waiting';
    return rechecking ? 'checking' : 'action';
  }
  if (ok === true) return 'done';
  return rechecking ? 'checking' : 'action';
}

/** The string key of the words that say the state of a row. */
export const prereqMarkKey = (m: PrereqMark): string => `prereq.status.${m}`;
