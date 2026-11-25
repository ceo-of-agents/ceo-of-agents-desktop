import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { DELAY_LOADER_MS } from './timers';

/** True once `active` has stayed true for `ms`; false again at once when it turns false. Loaders use it so fast actions never flash one. */
export function useDelayed(active: boolean, ms: number = DELAY_LOADER_MS): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!active) {
      setOn(false);
      return;
    }
    if (ms <= 0) {
      setOn(true);
      return;
    }
    const id = setTimeout(() => setOn(true), ms);
    return () => clearTimeout(id);
  }, [active, ms]);
  return active && (ms <= 0 || on);
}

export type PresenceState = 'open' | 'closed';

/** Keeps an element mounted for `exitMs` after `present` turns false, so its exit animation can play. Style it with `[data-state]`. */
export function usePresence(present: boolean, exitMs: number): { mounted: boolean; state: PresenceState } {
  const [mounted, setMounted] = useState(present);
  useEffect(() => {
    if (present) {
      setMounted(true);
      return;
    }
    const id = setTimeout(() => setMounted(false), exitMs);
    return () => clearTimeout(id);
  }, [present, exitMs]);
  return { mounted: present || mounted, state: present ? 'open' : 'closed' };
}

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Where Tab goes next inside a trap of `count` focusable elements: wraps at both ends. `current` is -1 when focus is outside the list. */
export function trapIndex(count: number, current: number, shift: boolean): number {
  if (count === 0) return -1;
  if (current < 0) return shift ? count - 1 : 0;
  return shift ? (current - 1 + count) % count : (current + 1) % count;
}

/** Moves focus into `ref` when `active` turns true, traps Tab inside it, and gives focus back to the previous element when it turns false. */
export function useFocusTrap(ref: RefObject<HTMLElement>, active: boolean, opts: { trap?: boolean } = {}): void {
  const trap = opts.trap ?? true;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const items = () => Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
    (items()[0] ?? el).focus();
    const onKey = (e: KeyboardEvent) => {
      if (!trap || e.key !== 'Tab') return;
      const list = items();
      if (list.length === 0) {
        e.preventDefault();
        return;
      }
      const idx = list.indexOf(document.activeElement as HTMLElement);
      const target = trapIndex(list.length, idx, e.shiftKey);
      const wrapsOrEscapes = idx < 0 || (e.shiftKey ? idx === 0 : idx === list.length - 1);
      if (wrapsOrEscapes) {
        e.preventDefault();
        list[target].focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (previous?.isConnected) previous.focus();
    };
  }, [ref, active, trap]);
}

/** Calls `onDismiss` on Escape and, when `outside` is given, on a mouse press outside it. */
export function useDismiss(active: boolean, onDismiss: () => void, outside?: RefObject<HTMLElement>): void {
  const cb = useRef(onDismiss);
  cb.current = onDismiss;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        cb.current();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (outside?.current && !outside.current.contains(e.target as Node)) cb.current();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [active, outside]);
}
