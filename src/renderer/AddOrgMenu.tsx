import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { t } from '../shared/strings';
import { FolderOpen, FolderPlus, Plus } from './icons';
import { Popover } from './ui/Popover';
import { Tooltip } from './ui/Tooltip';

/** The "+" in the rail: a menu with "Create a new org" and "Open an existing org". */
export function AddOrgMenu({ onCreate, onOpen }: { onCreate(): void; onOpen(): void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // The rail list scrolls (overflow clips), so the menu is fixed and placed from the "+" button's position when it opens.
  const [at, setAt] = useState({ x: 0, y: 0 });
  const toggle = () => {
    const r = box.current?.getBoundingClientRect();
    if (r) setAt({ x: r.right + 8, y: r.top });
    setOpen((o) => !o);
  };
  // The position is taken when the menu opens: a resized window or a scrolled rail would leave it behind, so it closes.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    // Scroll does not bubble: listen in the capture phase and close only for a scroll of something that holds the "+" (the rail list).
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && box.current && e.target.contains(box.current)) setOpen(false);
    };
    window.addEventListener('resize', close);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);
  const pick = (go: () => void) => () => {
    setOpen(false);
    go();
  };
  // Up and Down move between the items (wrapping); Enter and Space activate the focused button natively.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[at < 0 ? (e.key === 'ArrowDown' ? 0 : items.length - 1) : next].focus();
  };
  return (
    <div className="add-org" ref={box} style={{ '--add-x': `${at.x}px`, '--add-y': `${at.y}px` } as CSSProperties}>
      <Tooltip label={open ? '' : t('sidebar.addOrg')} placement="right">
        <button className="org-icon add" aria-label={t('sidebar.addOrg')} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
          <Plus />
        </button>
      </Tooltip>
      <Popover open={open} onClose={() => setOpen(false)} container={box} className="add-menu" label={t('sidebar.addOrg')}>
        <div role="menu" aria-label={t('sidebar.addOrg')} onKeyDown={onKey}>
          <button role="menuitem" className="add-menu-item" onClick={pick(onCreate)}>
            <FolderPlus className="add-menu-icon" />
            <span className="add-menu-text">
              <span className="add-menu-title">{t('addOrg.create')}</span>
              <span className="add-menu-hint">{t('addOrg.createHint')}</span>
            </span>
          </button>
          <button role="menuitem" className="add-menu-item" onClick={pick(onOpen)}>
            <FolderOpen className="add-menu-icon" />
            <span className="add-menu-text">
              <span className="add-menu-title">{t('addOrg.open')}</span>
              <span className="add-menu-hint">{t('addOrg.openHint')}</span>
            </span>
          </button>
        </div>
      </Popover>
    </div>
  );
}
