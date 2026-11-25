// @vitest-environment jsdom
// Parent and child items in "Waiting on you": grouping, counts, the collapsed card, the children's own actions and the focus deck.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidePanel } from '../../src/renderer/SidePanel';
import { WaitingFocus } from '../../src/renderer/WaitingFocus';
import { buildDeck, childCountOf, moveAnnouncement } from '../../src/renderer/focus-logic';
import { flattenGroups, groupWaiting, waitingActionSpecs, waitingKindKey } from '../../src/renderer/panel-logic';
import { waitingButtons } from '../../src/renderer/logic';
import { pendingStore } from '../../src/renderer/pending-send';
import { countAsks } from '../../src/shared/waiting';
import type { CoaApi, WaitingEntry, WaitingItem } from '../../src/shared/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => undefined;
const item = (code: string, patch: Partial<WaitingItem> = {}): WaitingItem => ({
  code, kind: 'A', urgency: 'normal', text: `Text of ${code}`, since: '2026-11-10', escalate: false, action: 'ok', ...patch,
});
const codes = (xs: WaitingItem[]) => xs.map((x) => x.code);

// Beta launch (high, ok) with two children; a {wait} decision group (normal, older) with one child; a plain item (low); an orphan child.
const LIST: WaitingItem[] = [
  item('A-1', { urgency: 'low', since: '2026-11-01', action: 'do', text: 'Plain, no children' }),
  item('A-7', { urgency: 'high', since: '2026-11-12', text: 'Launch the beta once the items below are done' }),
  item('A-8', { parent: 'A-7', since: '2026-11-12', text: 'Approve the store copy' }),
  item('D-5', { parent: 'A-7', kind: 'D', action: 'decide', since: '2026-11-13', text: 'Decide the beta price' }),
  item('D-3', { kind: 'D', action: 'wait', since: '2026-11-05', text: 'Pricing model decided (decision 0012)' }),
  item('A-9', { parent: 'D-3', action: 'do', urgency: 'low', since: '2026-11-15', text: 'Update the price in the store console' }),
  item('A-20', { parent: 'GONE-1', action: 'do', since: '2026-11-14', text: 'Child whose parent is not in the list' }),
];

describe('groupWaiting', () => {
  it('orders the groups by the parent urgency (high first), then date (oldest first); children stay in file order', () => {
    const g = groupWaiting(LIST);
    expect(codes(g.map((x) => x.item))).toEqual(['A-7', 'A-1', 'D-3', 'A-20']);
    expect(codes(g[0].children)).toEqual(['A-8', 'D-5']);
    expect(g[1].children).toEqual([]);
    expect(codes(g[2].children)).toEqual(['A-9']);
  });
  it('a child is never sorted on its own: a low urgency child stays under a high parent', () => {
    const g = groupWaiting([item('P', { urgency: 'low' }), item('C', { parent: 'P', urgency: 'high' }), item('Q', { urgency: 'normal' })]);
    expect(codes(g.map((x) => x.item))).toEqual(['P', 'Q']);
    expect(codes(g[0].children)).toEqual(['C']);
  });
  it('a child whose parent is missing shows as a top-level item', () => {
    expect(codes(groupWaiting([item('C', { parent: 'NOPE' })]).map((x) => x.item))).toEqual(['C']);
  });
  it('flattens as parent, then its children', () => {
    expect(codes(flattenGroups(groupWaiting(LIST)))).toEqual(['A-7', 'A-8', 'D-5', 'A-1', 'D-3', 'A-9', 'A-20']);
  });
  it('does not change its input', () => {
    const copy = structuredClone(LIST);
    groupWaiting(LIST);
    expect(LIST).toEqual(copy);
  });
});

describe('counting and kinds', () => {
  it('counts ok, do and decide lines, children included, and leaves out {wait} and unparsed lines', () => {
    const entries: WaitingEntry[] = [...LIST, { unparsed: '- odd line' }];
    expect(countAsks(entries)).toBe(6);
    expect(countAsks([])).toBe(0);
  });
  it('a {wait} group heading has no button and its own kind label', () => {
    expect(waitingButtons(LIST[4])).toEqual([]);
    expect(waitingActionSpecs(LIST[4])).toEqual({ visible: [], more: [] });
    expect(waitingKindKey(LIST[4])).toBe('waiting.kind.wait');
  });
  it('a child keeps the buttons of its own kind', () => {
    expect(waitingButtons(LIST[2])).toEqual(['approve', 'decline', 'reply']);
    expect(waitingButtons(LIST[5])).toEqual(['done', 'reply']);
  });
});

describe('the focus deck', () => {
  it('puts each child right after its parent, as its own slide, and leaves the {wait} heading out', () => {
    expect(codes(buildDeck(LIST, new Set()))).toEqual(['A-7', 'A-8', 'D-5', 'A-1', 'A-9', 'A-20']);
  });
  it('an action on a parent takes only the parent out, never its children', () => {
    expect(codes(buildDeck(LIST, new Set(['A-7'])))).toEqual(['A-8', 'D-5', 'A-1', 'A-9', 'A-20']);
  });
  it('an action on a child takes only that child out', () => {
    expect(codes(buildDeck(LIST, new Set(['A-8'])))).toEqual(['A-7', 'D-5', 'A-1', 'A-9', 'A-20']);
  });
  it('knows how many children a parent has', () => {
    expect(childCountOf(LIST, 'A-7')).toBe(2);
    expect(childCountOf(LIST, 'A-1')).toBe(0);
  });
  it('announces a child with its own kind and code', () => {
    expect(moveAnnouncement(1, 6, LIST[2])).toBe('2 of 6. APPROVE, A-8.');
  });
});

let host: HTMLDivElement;
let root: Root;
let send: ReturnType<typeof vi.fn>;
const onAnswer = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse('2026-11-19T10:00:00Z'));
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  send = vi.fn().mockResolvedValue(undefined);
  (window as unknown as { coa: Partial<CoaApi> }).coa = { send, openExternal: vi.fn() } as unknown as Partial<CoaApi>;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  onAnswer.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  pendingStore.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const panel = (waiting: WaitingEntry[]) =>
  act(() =>
    root.render(
      <SidePanel
        orgId="o1" cosName="Ada" waiting={waiting} initiatives={[]} departments={[]} tabs={[]} busyTabIds={[]} cosBusy={false} cosTurnStartedAt={null} hidden={false}
        onAnswer={onAnswer} onChat={noop} onOpenChart={noop} looks={{}} revealWaiting={0} onOpenFocus={noop}
      />,
    ),
  );
const click = (el: Element) => act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
const toggles = () => Array.from(host.querySelectorAll<HTMLButtonElement>('.w-group > button'));
const fold = (code: string) => host.querySelector<HTMLElement>(`#wg-o1-${code}`)!;

describe('the Waiting panel with children', () => {
  it('shows each parent collapsed with its number of children', () => {
    panel(LIST);
    expect(toggles().map((b) => b.textContent)).toEqual(['2 items below', '1 item below']);
    expect(toggles().every((b) => b.getAttribute('aria-expanded') === 'false')).toBe(true);
    expect(fold('A-7').dataset.open).toBe('false');
  });
  it('counts the asks, children included and {wait} left out, in the header', () => {
    panel(LIST);
    expect(host.querySelector('.section-head .count, .section-head .count-badge')?.textContent).toBe('6');
  });
  it('lists the groups by the parent urgency, then date', () => {
    panel(LIST);
    const order = Array.from(host.querySelectorAll('.w-head .code')).map((c) => c.textContent);
    expect(order).toEqual(['A-7', 'A-8', 'D-5', 'A-1', 'D-3', 'A-9', 'A-20']);
  });
  it('a {wait} parent has a group chip, no violet bar and no buttons of its own', () => {
    panel(LIST);
    const card = Array.from(host.querySelectorAll('.item.waiting')).find((c) => c.querySelector('.w-head .code')?.textContent === 'D-3')!;
    expect(card.classList.contains('neutral')).toBe(true);
    expect(card.querySelector(':scope > .w-head .chip')?.textContent).toBe('GROUP');
    expect(card.querySelector(':scope > .w-head .chip.kind')).toBeNull();
    // only its own children carry buttons
    expect(Array.from(card.querySelectorAll(':scope > .w-actions-wrap'))).toHaveLength(0);
  });
  it('expands on the toggle, and a child keeps its own actions under its own code', () => {
    panel(LIST);
    click(toggles()[0]);
    expect(toggles()[0].getAttribute('aria-expanded')).toBe('true');
    expect(fold('A-7').dataset.open).toBe('true');
    const child = Array.from(fold('A-7').querySelectorAll('.item.waiting')).find((c) => c.querySelector('.code')?.textContent === 'A-8')!;
    const approve = Array.from(child.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === 'Approve')!;
    click(approve);
    act(() => void vi.advanceTimersByTime(4100));
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0][2])).toContain('A-8');
    expect(String(send.mock.calls[0][2])).not.toContain('A-7');
  });
  it('an action on the parent does not touch its children', () => {
    panel(LIST);
    const parent = host.querySelector('.item.waiting')!;
    expect(parent.querySelector('.code')?.textContent).toBe('A-7');
    const approve = Array.from(parent.querySelectorAll<HTMLButtonElement>(':scope > .w-actions-wrap button')).find((b) => b.textContent === 'Approve')!;
    click(approve);
    act(() => void vi.advanceTimersByTime(4100));
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0][2])).toContain('A-7');
    expect(String(send.mock.calls[0][2])).not.toMatch(/A-8|D-5/);
  });
  it('an item without children shows no toggle', () => {
    panel([item('A-1')]);
    expect(toggles()).toHaveLength(0);
  });
});

describe('the focus view with children', () => {
  const focus = (items: WaitingItem[]) => act(() => root.render(<WaitingFocus open orgId="o9" items={items} onClose={noop} onReply={noop} />));
  const press = (key: string) => act(() => host.querySelector('.fv-sheet')!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
  const label = () => host.querySelector('[aria-roledescription="slide"]')?.getAttribute('aria-label');

  it('walks parent, then children, then the next group; the {wait} heading has no slide', () => {
    focus(LIST);
    expect(label()).toBe('1 of 6: A-7');
    expect(host.querySelector('.fv-slide')?.textContent).toContain('2 items under this one, next in this view');
    press('ArrowRight');
    expect(label()).toBe('2 of 6: A-8');
    expect(host.querySelector('.fv-slide')?.textContent).toContain('Under A-7');
    press('ArrowRight');
    press('ArrowRight');
    press('ArrowRight');
    expect(label()).toBe('5 of 6: A-9');
    expect(host.querySelector('.fv-slide')?.textContent).toContain('Under D-3');
  });
  it('a slide of an item without children says nothing about children', () => {
    focus([item('A-1')]);
    expect(host.querySelector('.fv-slide')?.textContent).not.toContain('under this one');
    expect(host.querySelector('.fv-slide')?.textContent).not.toContain('Under ');
  });
});
