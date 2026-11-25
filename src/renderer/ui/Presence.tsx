import type { ReactNode } from 'react';
import { usePresence, type PresenceState } from './hooks';

/**
 * Keeps its content mounted for `exitMs` after `present` turns false, so an exit animation can play.
 * The child gets the state ('open' | 'closed') to put in `data-state`; CSS animates on it.
 */
export function Presence({ present, exitMs, children }: { present: boolean; exitMs: number; children: (state: PresenceState) => ReactNode }) {
  const { mounted, state } = usePresence(present, exitMs);
  return mounted ? <>{children(state)}</> : null;
}
