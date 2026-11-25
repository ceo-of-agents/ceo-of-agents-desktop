import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDeck, extractLinks, linkChip, linkChipsOf, moveAnnouncement, moveForKey, moveIndex, newItemCount, newItemsAnnouncement, openingPosition, pendingAnnouncement,
  pendingStripText, positionText, recommendedKey, rememberCode, rememberedCode, resolveFocus, slideLabel,
} from '../../src/renderer/focus-logic';
import { createPendingStore, UNDO_MS } from '../../src/renderer/pending-send';
import type { WaitingItem } from '../../src/shared/types';

const item = (code: string, patch: Partial<WaitingItem> = {}): WaitingItem => ({
  code, kind: 'A', urgency: 'normal', text: `Text of ${code}`, since: '2026-11-10', escalate: false, action: 'ok', ...patch,
});
const codes = (deck: WaitingItem[]) => deck.map((i) => i.code);

describe('deck', () => {
  const items = [item('A-3', { since: '2026-11-12' }), item('A-1', { since: '2026-11-01' }), item('A-2', { urgency: 'high', since: '2026-11-15' })];

  it('is in the panel order: high urgency first, then oldest', () => {
    expect(codes(buildDeck(items, new Set()))).toEqual(['A-2', 'A-1', 'A-3']);
  });
  it('leaves out the items that are pending or sent', () => {
    expect(codes(buildDeck(items, new Set(['A-1'])))).toEqual(['A-2', 'A-3']);
  });
});

describe('where the view stands', () => {
  const deckOf = (...cs: string[]) => cs.map((c) => item(c));

  it('keeps the current item by its code when others arrive or leave (re-read)', () => {
    const before = deckOf('A-1', 'A-2', 'A-3');
    const pos = resolveFocus(before, { code: 'A-2', index: 1 });
    expect(pos).toEqual({ code: 'A-2', index: 1 });
    // two new items sort in before it: the view does not jump, only the index changes
    expect(resolveFocus(deckOf('N-1', 'A-1', 'N-2', 'A-2', 'A-3'), pos)).toEqual({ code: 'A-2', index: 3 });
    // an item after it leaves
    expect(resolveFocus(deckOf('A-1', 'A-2'), pos)).toEqual({ code: 'A-2', index: 1 });
  });

  it('shows the item now at the same position when the current one left', () => {
    expect(resolveFocus(deckOf('A-1', 'A-3'), { code: 'A-2', index: 1 })).toEqual({ code: 'A-3', index: 1 });
  });

  it('clamps to the new last item when the last one left', () => {
    expect(resolveFocus(deckOf('A-1', 'A-2'), { code: 'A-3', index: 2 })).toEqual({ code: 'A-2', index: 1 });
  });

  it('has no position on an empty deck', () => {
    expect(resolveFocus([], { code: 'A-1', index: 0 })).toEqual({ code: null, index: 0 });
  });

  it('opens on the remembered item when it still waits, else the first', () => {
    const deck = deckOf('A-1', 'A-2', 'A-3');
    expect(openingPosition(deck, 'A-3')).toEqual({ code: 'A-3', index: 2 });
    expect(openingPosition(deck, 'GONE-1')).toEqual({ code: 'A-1', index: 0 });
    expect(openingPosition(deck, null)).toEqual({ code: 'A-1', index: 0 });
  });

  it('remembers one code per org', () => {
    rememberCode('o1', 'A-2');
    rememberCode('o2', 'B-1');
    expect(rememberedCode('o1')).toBe('A-2');
    expect(rememberedCode('o2')).toBe('B-1');
    rememberCode('o1', null);
    expect(rememberedCode('o1')).toBeNull();
    expect(rememberedCode('o2')).toBe('B-1');
  });
});

describe('moves', () => {
  it('stops at both ends (no wrap)', () => {
    expect(moveIndex(0, 3, 'previous')).toBe(0);
    expect(moveIndex(2, 3, 'next')).toBe(2);
    expect(moveIndex(1, 3, 'next')).toBe(2);
    expect(moveIndex(1, 3, 'previous')).toBe(0);
    expect(moveIndex(1, 3, 'first')).toBe(0);
    expect(moveIndex(1, 3, 'last')).toBe(2);
    expect(moveIndex(0, 1, 'next')).toBe(0);
    expect(moveIndex(0, 0, 'last')).toBe(0);
  });
  it('maps the keys: arrows, Home, End; nothing else (no letter shortcut for an action)', () => {
    expect(moveForKey('ArrowLeft')).toBe('previous');
    expect(moveForKey('ArrowRight')).toBe('next');
    expect(moveForKey('Home')).toBe('first');
    expect(moveForKey('End')).toBe('last');
    for (const k of ['a', 'Enter', ' ', 'y', 'ArrowUp', 'Escape']) expect(moveForKey(k)).toBeNull();
  });
});

describe('deck with the pending store (action, undo)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const items = [item('A-1', { since: '2026-11-01' }), item('A-2', { since: '2026-11-02' }), item('A-3', { since: '2026-11-03' })];
  const deckNow = (store: ReturnType<typeof createPendingStore>) => buildDeck(items, new Set(store.list('o1').map((p) => p.code)));

  it('an action takes its item out at once and the view shows the next one; after the last, the new last', () => {
    const store = createPendingStore();
    let pos = resolveFocus(deckNow(store), { code: 'A-2', index: 1 });
    store.start('o1', 'A-2', 'approve', undefined, () => undefined);
    pos = resolveFocus(deckNow(store), pos);
    expect(pos).toEqual({ code: 'A-3', index: 1 });
    store.start('o1', 'A-3', 'decline', undefined, () => undefined);
    pos = resolveFocus(deckNow(store), pos);
    expect(pos).toEqual({ code: 'A-1', index: 0 });
    expect(codes(deckNow(store))).toEqual(['A-1']);
  });

  it('an undo puts the item back in its sorted place and the view goes back to it; the count follows', () => {
    const store = createPendingStore();
    let pos = resolveFocus(deckNow(store), { code: 'A-2', index: 1 });
    store.start('o1', 'A-2', 'done', undefined, () => undefined);
    pos = resolveFocus(deckNow(store), pos);
    expect(deckNow(store)).toHaveLength(2);
    // the view sets the code it wants back, then undoes
    pos = { code: 'A-2', index: pos.index };
    expect(store.undo('o1', 'A-2')).toBe(true);
    expect(codes(deckNow(store))).toEqual(['A-1', 'A-2', 'A-3']);
    expect(resolveFocus(deckNow(store), pos)).toEqual({ code: 'A-2', index: 1 });
  });

  it('a sent item stays out of the deck until the panel drops it; several actions can run at once', () => {
    const store = createPendingStore();
    store.start('o1', 'A-1', 'approve', undefined, () => undefined);
    store.start('o1', 'A-2', 'approve', undefined, () => undefined);
    vi.advanceTimersByTime(UNDO_MS);
    expect(store.list('o1').map((p) => p.stage)).toEqual(['sent', 'sent']);
    expect(codes(deckNow(store))).toEqual(['A-3']);
  });

  it('all items handled: an empty deck, no position', () => {
    const store = createPendingStore();
    for (const c of ['A-1', 'A-2', 'A-3']) store.start('o1', c, 'approve', undefined, () => undefined);
    expect(deckNow(store)).toEqual([]);
    expect(resolveFocus(deckNow(store), { code: 'A-3', index: 2 }).code).toBeNull();
  });

  it('lists the pending items of one org only, oldest first', () => {
    const store = createPendingStore();
    store.start('o1', 'A-1', 'approve', undefined, () => undefined);
    vi.advanceTimersByTime(10);
    store.start('o1', 'A-2', 'approve', undefined, () => undefined);
    store.start('o2', 'A-9', 'approve', undefined, () => undefined);
    expect(store.list('o1').map((p) => p.code)).toEqual(['A-1', 'A-2']);
    expect(store.list('o2').map((p) => p.code)).toEqual(['A-9']);
  });
});

describe('new items', () => {
  it('counts the items that were not known before', () => {
    expect(newItemCount(new Set(['A-1']), [item('A-1'), item('A-2'), item('A-3')])).toBe(2);
    expect(newItemCount(new Set(['A-1', 'A-2']), [item('A-1')])).toBe(0);
  });
  it('announces one or many', () => {
    expect(newItemsAnnouncement(1)).toBe('1 new item');
    expect(newItemsAnnouncement(3)).toBe('3 new items');
  });
});

describe('recommended option', () => {
  const options = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' }];
  it('is the first "(a)"-style key of the recommendation that is an option', () => {
    expect(recommendedKey('(b), proposed by business.', options)).toBe('b');
    expect(recommendedKey('I suggest option (c) over (a).', options)).toBe('c');
    expect(recommendedKey('Take (B).', options)).toBe('b');
  });
  it('skips a key that is not an option and returns null when none matches', () => {
    expect(recommendedKey('(z) is not one, (a) is.', options)).toBe('a');
    expect(recommendedKey('needs analysis by design-brand', options)).toBeNull();
    expect(recommendedKey('', options)).toBeNull();
  });
});

describe('link chips', () => {
  it('labels GitHub issues and pull requests, any other link by its host', () => {
    expect(linkChip('https://github.com/acme/app/issues/94')).toMatchObject({ kind: 'issue', label: 'Issue #94' });
    expect(linkChip('https://github.com/acme/app/pull/12')).toMatchObject({ kind: 'pr', label: 'PR #12' });
    expect(linkChip('https://github.com/acme/app/pull/12/files')).toMatchObject({ kind: 'pr', label: 'PR #12' });
    expect(linkChip('https://github.com/acme/app')).toMatchObject({ kind: 'host', label: 'github.com' });
    expect(linkChip('https://docs.example.com/a/b?x=1')).toMatchObject({ kind: 'host', label: 'docs.example.com' });
  });
  it('takes Markdown links and plain addresses, in order of first appearance, without duplicates', () => {
    const text = 'See [the PR](https://github.com/acme/app/pull/12), also https://example.com/x. Again https://github.com/acme/app/pull/12 and (https://example.org/y).';
    expect(extractLinks(text)).toEqual(['https://github.com/acme/app/pull/12', 'https://example.com/x', 'https://example.org/y']);
  });
  it('takes https only', () => {
    expect(extractLinks('http://plain.example.com and javascript:alert(1) and ftp://x.example.com and [m](http://a.example.com)')).toEqual([]);
  });
  it('reads the item text and, for a decide item, its card', () => {
    const it = item('D-1', {
      action: 'decide', text: 'Decide, see https://github.com/acme/app/issues/5',
      card: { context: 'Background: https://example.com/doc', options: [{ key: 'a', label: 'a' }], recommendation: '(a) per [PR](https://github.com/acme/app/pull/7)', proposedBy: 'x', escalate: false },
    });
    expect(linkChipsOf(it).map((c) => c.label)).toEqual(['Issue #5', 'example.com', 'PR #7']);
    expect(linkChipsOf(item('A-1'))).toEqual([]);
  });
});

describe('labels and announcements', () => {
  it('position, slide label and the announcement of a move', () => {
    expect(positionText(2, 12)).toBe('3 of 12');
    expect(slideLabel(2, 12, 'A-12')).toBe('3 of 12: A-12');
    expect(moveAnnouncement(2, 12, item('A-12', { urgency: 'high' }))).toBe('3 of 12. APPROVE, A-12, HIGH.');
    expect(moveAnnouncement(0, 1, item('A-1', { action: null }))).toBe('1 of 1. A-1.');
  });
  it('the undo strip and the action announcement use the pending strings', () => {
    expect(pendingStripText('Approving…', 'A-12')).toBe('Approving A-12…');
    expect(pendingAnnouncement('A-12', 'Approving…')).toBe('Approving A-12. Undo available.');
  });
});
