// Framework-free timer logic behind the UI primitives, so it can be tested with fake timers.

export const DELAY_LOADER_MS = 300;
export const TOOLTIP_DELAY_MS = 400;
export const TOAST_MS = 6000;

/** A timer that can be paused and resumed; `onDone` fires once, when the remaining time has run out. */
export function createPausableTimer(ms: number, onDone: () => void) {
  let remaining = ms;
  let startedAt = 0;
  let handle: ReturnType<typeof setTimeout> | null = null;
  let done = false;
  const run = () => {
    startedAt = Date.now();
    handle = setTimeout(() => {
      handle = null;
      done = true;
      remaining = 0;
      onDone();
    }, remaining);
  };
  return {
    start() {
      if (!handle && !done) run();
    },
    pause() {
      if (!handle) return;
      clearTimeout(handle);
      handle = null;
      remaining = Math.max(0, remaining - (Date.now() - startedAt));
    },
    resume() {
      if (!handle && !done) run();
    },
    cancel() {
      if (handle) clearTimeout(handle);
      handle = null;
      done = true;
    },
    remaining: () => (handle ? Math.max(0, remaining - (Date.now() - startedAt)) : remaining),
  };
}

/** Hover opens a tooltip after `delay`; keyboard focus opens it at once; leaving, blur and Escape close it. */
export function createTooltipController(delay: number, onChange: (visible: boolean) => void) {
  let handle: ReturnType<typeof setTimeout> | null = null;
  let visible = false;
  const set = (v: boolean) => {
    if (v !== visible) {
      visible = v;
      onChange(v);
    }
  };
  const clear = () => {
    if (handle) clearTimeout(handle);
    handle = null;
  };
  return {
    hover() {
      if (visible || handle) return;
      handle = setTimeout(() => {
        handle = null;
        set(true);
      }, delay);
    },
    focus() {
      clear();
      set(true);
    },
    hide() {
      clear();
      set(false);
    },
    isVisible: () => visible,
  };
}

/** Phases of a toast row: open, fading out (opacity), then collapsing (its slot folds away). */
export type ToastPhase = 'open' | 'fading' | 'collapsing';
export interface ToastRow<T extends { id: number }> {
  notice: T;
  phase: ToastPhase;
}

/** Keeps rows for notices that left the list so they can animate out; new notices are appended as open. */
export function mergeToastRows<T extends { id: number }>(rows: ToastRow<T>[], notices: T[]): ToastRow<T>[] {
  const live = new Set(notices.map((n) => n.id));
  const known = new Set(rows.map((r) => r.notice.id));
  const next = rows.map((r) => (live.has(r.notice.id) || r.phase !== 'open' ? r : { ...r, phase: 'fading' as ToastPhase }));
  for (const n of notices) if (!known.has(n.id)) next.push({ notice: n, phase: 'open' });
  return next;
}
