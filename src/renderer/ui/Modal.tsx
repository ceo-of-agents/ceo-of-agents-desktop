import { useRef, type ReactNode } from 'react';
import { useDismiss, useFocusTrap } from './hooks';
import { Presence } from './Presence';

/** A modal dialog: backdrop and box animate in (180 ms) and out (120 ms), Escape and a backdrop click close it, focus is trapped while open. */
export function Modal({ open, onClose, label, role = 'dialog', describedBy, children }: { open: boolean; onClose(): void; label: string; role?: 'dialog' | 'alertdialog'; describedBy?: string; children: ReactNode }) {
  return (
    <Presence present={open} exitMs={120}>
      {(state) => (
        <ModalBody state={state} onClose={onClose} label={label} role={role} describedBy={describedBy}>
          {children}
        </ModalBody>
      )}
    </Presence>
  );
}

function ModalBody({ state, onClose, label, role, describedBy, children }: { state: 'open' | 'closed'; onClose(): void; label: string; role: 'dialog' | 'alertdialog'; describedBy?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const open = state === 'open';
  useFocusTrap(ref, open);
  useDismiss(open, onClose);
  return (
    <div className="modal-backdrop" data-state={state} onClick={onClose}>
      <div ref={ref} className="modal" role={role} aria-modal="true" aria-label={label} aria-describedby={describedBy} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
