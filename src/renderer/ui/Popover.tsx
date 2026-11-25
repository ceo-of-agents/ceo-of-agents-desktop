import { useRef, type ReactNode, type RefObject } from 'react';
import { useDismiss, useFocusTrap } from './hooks';
import { Presence } from './Presence';

/**
 * A popover anchored by CSS to its relative parent (`.popover`: 300 px, right-aligned, 8 px below).
 * Enters 180 ms, exits 120 ms. Closes on Escape and on a press outside `container`; focus moves in on open and back on close.
 */
export function Popover({ open, onClose, container, label, className, children }: { open: boolean; onClose(): void; container: RefObject<HTMLElement>; label: string; /** Extra class on the `.popover` (a narrower menu). */ className?: string; children: ReactNode }) {
  return (
    <Presence present={open} exitMs={120}>
      {(state) => (
        <PopoverBody state={state} onClose={onClose} container={container} label={label} className={className}>
          {children}
        </PopoverBody>
      )}
    </Presence>
  );
}

function PopoverBody({ state, onClose, container, label, className, children }: { state: 'open' | 'closed'; onClose(): void; container: RefObject<HTMLElement>; label: string; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const open = state === 'open';
  useFocusTrap(ref, open, { trap: false });
  useDismiss(open, onClose, container);
  return (
    <div ref={ref} className={`popover${className ? ` ${className}` : ''}`} role="dialog" aria-label={label} tabIndex={-1} data-state={state}>
      {children}
    </div>
  );
}
