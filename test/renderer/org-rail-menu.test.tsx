// @vitest-environment jsdom
// The right-click menu of an org's rail item, in a real DOM.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from '../../src/renderer/Sidebar';
import type { OrgSummary } from '../../src/shared/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const org = (id: string, name: string, iconStamp: string | null): OrgSummary => ({ id, name, available: true, waitingCount: 0, iconStamp } as OrgSummary);
const noop = () => undefined;
let host: HTMLDivElement;
let root: Root;
let onSetIcon: ReturnType<typeof vi.fn>;
let onRemoveIcon: ReturnType<typeof vi.fn>;
let onSelect: ReturnType<typeof vi.fn>;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  onSetIcon = vi.fn();
  onRemoveIcon = vi.fn();
  onSelect = vi.fn();
  vi.stubGlobal('window', Object.assign(window, { coa: { getOrgIcon: () => Promise.resolve(null) } }));
  act(() =>
    root.render(<Sidebar orgs={[org('a', 'ACME', null), org('b', 'BOLT', '1-2')]} activeOrgId="a" onSelect={onSelect} onAdd={noop} onCreate={noop} onSettings={noop} onAbout={noop} onSetIcon={onSetIcon} onRemoveIcon={onRemoveIcon} />),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const tile = (name: string) => host.querySelector<HTMLButtonElement>(`button.org-icon[aria-label="${name}"]`)!;
const rightClick = (el: Element) => act(() => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 70, clientY: 90 })));
const items = () => Array.from(host.querySelectorAll<HTMLElement>('[role="menuitem"]')).map((b) => b.textContent);

describe('rail context menu', () => {
  it('right-click on an org without an icon: only "Set icon…", at the pointer, native menu suppressed', () => {
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 70, clientY: 90 });
    act(() => void tile('ACME').dispatchEvent(ev));
    expect(ev.defaultPrevented).toBe(true);
    expect(items()).toEqual(['Set icon…']);
    const menu = host.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu.style.left).toBe('70px');
    expect(menu.style.top).toBe('90px');
    expect(menu.getAttribute('aria-label')).toContain('ACME');
    expect(onSelect).not.toHaveBeenCalled();
  });
  it('an org with an icon also offers "Remove icon"', () => {
    rightClick(tile('BOLT'));
    expect(items()).toEqual(['Set icon…', 'Remove icon']);
  });
  it('"Set icon…" calls onSetIcon with that org and closes the menu', () => {
    rightClick(tile('BOLT'));
    act(() => host.querySelectorAll<HTMLElement>('[role="menuitem"]')[0].click());
    expect(onSetIcon).toHaveBeenCalledWith('b');
    expect(onRemoveIcon).not.toHaveBeenCalled();
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });
  it('"Remove icon" calls onRemoveIcon with that org', () => {
    rightClick(tile('BOLT'));
    act(() => host.querySelectorAll<HTMLElement>('[role="menuitem"]')[1].click());
    expect(onRemoveIcon).toHaveBeenCalledWith('b');
    expect(onSetIcon).not.toHaveBeenCalled();
  });
  it('focus lands on the first item; Escape and a press outside close it', () => {
    rightClick(tile('BOLT'));
    expect(document.activeElement?.textContent).toBe('Set icon…');
    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(host.querySelector('[role="menu"]')).toBeNull();
    rightClick(tile('BOLT'));
    act(() => void document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });
  it('arrow keys move between the items', () => {
    rightClick(tile('BOLT'));
    const menu = host.querySelector<HTMLElement>('[role="menu"]')!;
    act(() => void menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));
    expect(document.activeElement?.textContent).toBe('Remove icon');
  });
});
