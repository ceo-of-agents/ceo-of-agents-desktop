import { useEffect, useRef, type KeyboardEvent } from 'react';
import { t } from '../shared/strings';
import { useDismiss } from './ui/hooks';
import { railMenuItems } from './org-icon-actions';

/** The right-click menu of an org's rail item: "Set icon…" and, when it has one, "Remove icon". Fixed at the pointer; Escape or a press outside closes it. */
export function OrgRailMenu({ name, hasIcon, x, y, onSet, onRemove, onClose }: { name: string; hasIcon: boolean; x: number; y: number; onSet(): void; onRemove(): void; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(true, onClose, ref);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, []);
  // The position is taken at the click: a resized window or a scrolled rail would leave the menu behind, so it closes.
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('blur', close);
    };
  }, [onClose]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[at < 0 ? 0 : next].focus();
  };
  const run = (go: () => void) => () => {
    onClose();
    go();
  };
  return (
    <div ref={ref} className="rail-menu" role="menu" aria-label={t('orgIcon.menu.label', { name })} style={{ left: x, top: y }} onKeyDown={onKey}>
      {railMenuItems(hasIcon).map((item) => (
        <button key={item} role="menuitem" className="rail-menu-item" onClick={run(item === 'set' ? onSet : onRemove)}>
          {t(item === 'set' ? 'orgIcon.menu.set' : 'orgIcon.menu.remove')}
        </button>
      ))}
    </div>
  );
}
