// The two hooks of the liveness feature that touch the clock and the window: a one-second tick, and the "seen" rule
// (dispatch-logic.ts) applied to the active org.
import { useEffect, useRef, useState } from 'react';
import type { Dispatch, OrgId } from '../shared/types';
import { api } from './api';
import { dispatchesToAck, nextAckDelayMs, syncAckMemory, type AckContext } from './dispatch-logic';

/** The current time in ms, updated once per second while `enabled` (no timer otherwise). */
export function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [enabled]);
  return enabled ? now : Date.now();
}

const hasFocus = (): boolean => typeof document !== 'undefined' && document.hasFocus() && document.visibilityState !== 'hidden';

/** True while the window has focus and is visible (document.hasFocus plus focus, blur and visibilitychange). */
export function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(hasFocus);
  useEffect(() => {
    const update = () => setFocused(hasFocus());
    update();
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  return focused;
}

/**
 * Tells the main process which ended dispatches of the active org the user has now seen (`dispatchesToAck`), and wakes
 * itself when the next one becomes old enough. The main process answers with a new `dispatches` list.
 * `visibleThread`: the thread the main area shows (`cos` or `tab:<tabId>`), null when none; `threadBusy` and `reportPending`: its state.
 */
export function useDispatchAck(orgId: OrgId | null, dispatches: Dispatch[], visibleThread: string | null, threadBusy: boolean, reportPending = false): void {
  const focused = useWindowFocused();
  const firstSeen = useRef(new Map<string, number>());
  const acked = useRef(new Set<string>());
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!orgId) return;
    const now = Date.now();
    syncAckMemory(dispatches, firstSeen.current, acked.current, now);
    const pending = dispatches.filter((d) => !acked.current.has(d.id));
    const ctx: AckContext = { visibleThread, windowFocused: focused, threadBusy, reportPending, nowMs: now, firstSeen: firstSeen.current };
    const send = dispatchesToAck(pending, ctx);
    if (send.length > 0) {
      for (const id of send) acked.current.add(id);
      api()
        .ackDispatches(orgId, send)
        .catch(() => {
          for (const id of send) acked.current.delete(id);
        });
    }
    const delay = nextAckDelayMs(pending, ctx);
    if (delay === null) return;
    const timer = setTimeout(() => setTick((n) => n + 1), delay + 50);
    return () => clearTimeout(timer);
  }, [orgId, dispatches, visibleThread, threadBusy, reportPending, focused, tick]);
}
