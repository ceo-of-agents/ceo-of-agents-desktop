// @vitest-environment jsdom
// The focus view in a real DOM: where focus lands, the keyboard, and what the actions do.
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WaitingFocus } from '../../src/renderer/WaitingFocus';
import { useFocusOrg } from '../../src/renderer/useFocusOrg';
import { pendingStore } from '../../src/renderer/pending-send';
import type { CoaApi, WaitingItem } from '../../src/shared/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => undefined;
const item = (code: string, since: string, patch: Partial<WaitingItem> = {}): WaitingItem => ({
  code, kind: 'A', urgency: 'normal', text: `Text of ${code}`, since, escalate: false, action: 'ok', ...patch,
});
const decide = item('D-1', '2026-11-13', {
  kind: 'D', action: 'decide', text: 'Which plan?',
  options: [{ key: 'a', label: 'Free tier' }, { key: 'b', label: 'Paid tier' }],
  card: { context: 'c', recommendation: '(b)', options: [{ key: 'a', label: 'Free tier' }, { key: 'b', label: 'Paid tier' }], proposedBy: null, escalate: false },
});
const ITEMS = [item('A-1', '2026-11-10'), item('A-2', '2026-11-11', { action: 'do' }), item('A-3', '2026-11-12'), decide];

let host: HTMLDivElement;
let root: Root;
let send: ReturnType<typeof vi.fn>;
// The view remembers its item per org for the app session, so each test uses its own org.
let orgSeq = 0;
let org = 'o1';

const mount = (items: WaitingItem[] = ITEMS, open = true) => {
  act(() => root.render(<WaitingFocus open={open} orgId={org} items={items} onClose={noop} onReply={noop} />));
};
const slide = () => host.querySelector<HTMLElement>('[aria-roledescription="slide"]');
const slideLabel = () => slide()?.getAttribute('aria-label');
const button = (text: string) => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === text)!;
const byLabel = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const click = (el: Element) => act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
const press = (key: string) => act(() => slide()!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
const focusOnSlide = () => {
  expect(document.activeElement).toBe(slide());
  expect(document.activeElement?.tagName).not.toBe('BUTTON');
};

beforeEach(() => {
  org = `o${++orgSeq}`;
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse('2026-11-19T10:00:00Z'));
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  send = vi.fn().mockResolvedValue(undefined);
  (window as unknown as { coa: Partial<CoaApi> }).coa = { send, openExternal: vi.fn() } as unknown as Partial<CoaApi>;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  pendingStore.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('WaitingFocus focus management', () => {
  it('after mount, focus is on the slide region, not on an action button', () => {
    mount();
    expect(slideLabel()).toBe('1 of 4: A-1');
    focusOnSlide();
  });

  it('after Next, Previous and Undo, focus is on the slide region again', () => {
    mount();
    click(byLabel('Next item'));
    expect(slideLabel()).toBe('2 of 4: A-2');
    focusOnSlide();
    click(byLabel('Previous item'));
    expect(slideLabel()).toBe('1 of 4: A-1');
    focusOnSlide();
    click(button('Approve'));
    expect(slideLabel()).toBe('1 of 3: A-2');
    focusOnSlide();
    click(button('Undo'));
    expect(slideLabel()).toBe('1 of 4: A-1');
    focusOnSlide();
  });
});

describe('WaitingFocus keyboard', () => {
  it('ArrowRight, ArrowLeft, End and Home move, with no wrap', () => {
    mount();
    press('ArrowLeft');
    expect(slideLabel()).toBe('1 of 4: A-1');
    press('ArrowRight');
    expect(slideLabel()).toBe('2 of 4: A-2');
    press('End');
    expect(slideLabel()).toBe('4 of 4: D-1');
    press('ArrowRight');
    expect(slideLabel()).toBe('4 of 4: D-1');
    press('ArrowLeft');
    expect(slideLabel()).toBe('3 of 4: A-3');
    press('Home');
    expect(slideLabel()).toBe('1 of 4: A-1');
    focusOnSlide();
  });
});

describe('WaitingFocus actions', () => {
  it('Approve starts the pending action, takes the item out of the deck, and sends after the undo window', () => {
    const start = vi.spyOn(pendingStore, 'start');
    mount();
    click(button('Approve'));
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0].slice(0, 3)).toEqual([org, 'A-1', 'approve']);
    expect(slideLabel()).toBe('1 of 3: A-2');
    act(() => void vi.advanceTimersByTime(200)); // the leaving copy of the old slide is gone
    expect(host.textContent).not.toContain('Text of A-1');
    expect(send).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(4000));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe(org);
    expect(send.mock.calls[0][1]).toBe('cos');
    expect(send.mock.calls[0][2]).toContain('A-1');
  });

  it('Decline starts a decline and removes the item', () => {
    const start = vi.spyOn(pendingStore, 'start');
    mount();
    click(button('Decline'));
    expect(start.mock.calls[0].slice(0, 3)).toEqual([org, 'A-1', 'decline']);
    expect(slideLabel()).toBe('1 of 3: A-2');
  });

  it('Done on a {do} item starts a done and removes the item', () => {
    const start = vi.spyOn(pendingStore, 'start');
    mount();
    press('ArrowRight');
    expect(slideLabel()).toBe('2 of 4: A-2');
    click(button('Done'));
    expect(start.mock.calls[0].slice(0, 3)).toEqual([org, 'A-2', 'done']);
    act(() => void vi.advanceTimersByTime(200));
    expect(host.textContent).not.toContain('Text of A-2');
    expect(host.querySelector('[aria-roledescription="slide"]')?.getAttribute('aria-label')).toMatch(/of 3: /);
  });

  it('an option of a decide item starts an option action with its key and removes the item', () => {
    const start = vi.spyOn(pendingStore, 'start');
    mount();
    press('End');
    expect(slideLabel()).toBe('4 of 4: D-1');
    click(host.querySelectorAll<HTMLButtonElement>('.fv-option')[1]);
    expect(start.mock.calls[0].slice(0, 4)).toEqual([org, 'D-1', 'option', 'b']);
    expect(slideLabel()).toBe('3 of 3: A-3');
  });

  it('Undo cancels the pending action, restores the item to the deck and sends nothing', () => {
    mount();
    click(button('Approve'));
    expect(slideLabel()).toBe('1 of 3: A-2');
    click(button('Undo'));
    expect(slideLabel()).toBe('1 of 4: A-1');
    expect(host.textContent).toContain('Text of A-1');
    act(() => void vi.advanceTimersByTime(5000));
    expect(send).not.toHaveBeenCalled();
  });
});

describe('useFocusOrg', () => {
  // The focus view must not reopen on its own when the user comes back to an org.
  it('closes when the active org changes, so coming back does not reopen it', () => {
    let active: string | null = 'A';
    let switchTo: (id: string | null) => void = noop;
    let focus: ReturnType<typeof useFocusOrg> = [null, noop];
    function Harness() {
      const [org, setActiveOrg] = useState<string | null>('A');
      switchTo = setActiveOrg;
      active = org;
      focus = useFocusOrg(org);
      return null;
    }
    act(() => root.render(<Harness />));
    const isOpen = () => focus[0] !== null && focus[0] === active;
    expect(isOpen()).toBe(false);
    act(() => focus[1]('A'));
    expect(isOpen()).toBe(true);
    act(() => switchTo('B'));
    expect(isOpen()).toBe(false);
    act(() => switchTo('A'));
    expect(isOpen()).toBe(false);
    expect(focus[0]).toBeNull();
    // Opening again for the current org still works.
    act(() => focus[1]('A'));
    expect(isOpen()).toBe(true);
  });
});
