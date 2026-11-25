// Pure logic of the "Waiting on you" focus view: the deck, where the view stands in it, links, labels
// and announcements. No React, no window: tested in test/renderer/focus-logic.test.ts.
import type { DecisionOption, WaitingItem } from '../shared/types';
import { t, tn } from '../shared/strings';
import { asksTheCeo } from '../shared/waiting';
import { flattenGroups, groupWaiting, waitingKindKey } from './panel-logic';

/**
 * The deck: the waiting items in the panel's order (groups by the parent's urgency, then date; high urgency first, then oldest)
 * minus those in a pending or sent stage. A child is its own slide right after its parent (and after the siblings before it); a
 * `{wait}` group heading asks nothing and has no slide. An action takes its item out of the deck at once, and only that item: a
 * parent's action never takes its children with it. An undo puts it back at its place.
 */
export function buildDeck(items: WaitingItem[], pendingCodes: ReadonlySet<string>): WaitingItem[] {
  return flattenGroups(groupWaiting(items)).filter((i) => asksTheCeo(i) && !pendingCodes.has(i.code));
}

/** How many items the hq lists under `code` (its children). */
export const childCountOf = (items: readonly WaitingItem[], code: string): number => items.filter((i) => i.parent === code).length;

/** Where the view stands: the current item's code and its index in the last deck it saw. */
export interface FocusPosition {
  code: string | null;
  index: number;
}

/**
 * The position after the deck changed (an action, an undo, hq state re-read). The current item is kept by its code. When it
 * left, the item now at the same position is shown, clamped to the deck (after the last item: the new last one). An empty
 * deck has no position.
 */
export function resolveFocus(deck: readonly WaitingItem[], prev: FocusPosition): FocusPosition {
  if (deck.length === 0) return { code: null, index: 0 };
  const at = prev.code === null ? -1 : deck.findIndex((i) => i.code === prev.code);
  if (at >= 0) return { code: prev.code, index: at };
  const index = Math.max(0, Math.min(prev.index, deck.length - 1));
  return { code: deck[index].code, index };
}

export type FocusMove = 'previous' | 'next' | 'first' | 'last';

/** The index after a move. No wrap: it stops at both ends. */
export function moveIndex(index: number, count: number, move: FocusMove): number {
  if (count <= 0) return 0;
  const to = move === 'first' ? 0 : move === 'last' ? count - 1 : move === 'previous' ? index - 1 : index + 1;
  return Math.max(0, Math.min(count - 1, to));
}

/** The key of a move from a keyboard key, null for any other key. */
export function moveForKey(key: string): FocusMove | null {
  return key === 'ArrowLeft' ? 'previous' : key === 'ArrowRight' ? 'next' : key === 'Home' ? 'first' : key === 'End' ? 'last' : null;
}

/** How many items of the deck were not in the previous one: the "new items" announcement. */
export function newItemCount(prevCodes: ReadonlySet<string>, deck: readonly WaitingItem[]): number {
  return deck.filter((i) => !prevCodes.has(i.code)).length;
}

// ---------- the code the view stands on, per org, for the app session ----------

const remembered = new Map<string, string>();
export const rememberedCode = (orgId: string): string | null => remembered.get(orgId) ?? null;
export const rememberCode = (orgId: string, code: string | null): void => {
  if (code === null) remembered.delete(orgId);
  else remembered.set(orgId, code);
};

/** Where to open: the remembered item when it still waits, else the first. */
export function openingPosition(deck: readonly WaitingItem[], code: string | null): FocusPosition {
  return resolveFocus(deck, { code, index: 0 });
}

// ---------- the decision card ----------

/** The option the Recommendation names: the first "(a)"-style key in its text that is one of the options. */
export function recommendedKey(recommendation: string, options: readonly DecisionOption[]): string | null {
  const keys = new Set(options.map((o) => o.key));
  for (const m of recommendation.matchAll(/\(([a-z0-9]+)\)/gi)) {
    const key = m[1].toLowerCase();
    if (keys.has(key)) return key;
  }
  return null;
}

// ---------- link chips ----------

export interface LinkChip {
  url: string;
  kind: 'issue' | 'pr' | 'host';
  /** The chip text, in sentence case (the CSS uppercases it). */
  label: string;
}

const MD_LINK_RE = /\]\((<)?(https:\/\/[^\s)>]+)/gi;
const BARE_URL_RE = /https:\/\/[^\s<>()[\]"'`]+/gi;
const TRAILING = /[.,;:!?*_~]+$/;

/** Every https link of the texts (Markdown links and plain addresses), in order of first appearance, without duplicates. */
export function extractLinks(...texts: Array<string | null | undefined>): string[] {
  const seen: string[] = [];
  const add = (raw: string) => {
    const cleaned = raw.replace(TRAILING, '');
    let url: string;
    try {
      const u = new URL(cleaned);
      if (u.protocol !== 'https:' || !u.hostname) return;
      url = u.href;
    } catch {
      return;
    }
    if (!seen.includes(url)) seen.push(url);
  };
  for (const text of texts) {
    if (!text) continue;
    const found: Array<{ at: number; url: string }> = [];
    for (const m of text.matchAll(MD_LINK_RE)) found.push({ at: m.index ?? 0, url: m[2] });
    for (const m of text.matchAll(BARE_URL_RE)) found.push({ at: m.index ?? 0, url: m[0] });
    found.sort((a, b) => a.at - b.at);
    for (const f of found) add(f.url);
  }
  return seen;
}

/** The chip of a link: "Issue #12", "PR #7" for GitHub issue and pull request addresses, else the host name. */
export function linkChip(url: string): LinkChip {
  const u = new URL(url);
  const m = u.hostname === 'github.com' ? /^\/[^/]+\/[^/]+\/(issues|pull)\/(\d+)(?:\/|$)/.exec(u.pathname) : null;
  if (m) return { url, kind: m[1] === 'issues' ? 'issue' : 'pr', label: t(m[1] === 'issues' ? 'waiting.link.issue' : 'waiting.link.pr', { number: m[2] }) };
  return { url, kind: 'host', label: u.hostname };
}

/** The chips of an item: the links of its text and, for a decide item, of its card (context, options, recommendation). The card itself gets no chip. */
export function linkChipsOf(item: WaitingItem): LinkChip[] {
  const card = item.card;
  return extractLinks(item.text, card?.context, card?.recommendation, ...(card?.options.map((o) => o.label) ?? [])).map(linkChip);
}

// ---------- labels and announcements ----------

/** "Approving ACME-A12…" from the pending strings: the label without its ellipsis, the code, the ellipsis. */
export function pendingStripText(label: string, code: string): string {
  return `${label.replace(/…$/, '')} ${code}…`;
}

/** "3 of 12" */
export const positionText = (index: number, count: number): string => t('waiting.focus.position', { index: index + 1, count });

/** The slide's accessible name: "3 of 12: ACME-A12". */
export const slideLabel = (index: number, count: number, code: string): string => t('waiting.focus.slide', { index: index + 1, count, code });

/** The announcement of a move: "3 of 12. Approve, ACME-A12, high." (an untagged item has no kind). */
export function moveAnnouncement(index: number, count: number, item: WaitingItem): string {
  const kindKey = waitingKindKey(item);
  const parts = [kindKey ? t(kindKey) : null, item.code, item.urgency && item.urgency !== 'normal' ? t(`waiting.urgency.${item.urgency}`) : null].filter(Boolean);
  return `${positionText(index, count)}. ${parts.join(', ')}.`;
}

export const newItemsAnnouncement = (count: number): string => tn('waiting.focus.newItems', count);

/** The announcement when an action starts: "Approving ACME-A12. Undo available." */
export function pendingAnnouncement(code: string, label: string): string {
  return t('waiting.focus.pendingUndo', { what: label.replace(/…$/, ''), code });
}
