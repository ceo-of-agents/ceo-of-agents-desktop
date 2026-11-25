import { useEffect, useRef, useState } from 'react';
import { ChevronRight } from './icons';
import type { Notice } from './logic';
import { Tooltip } from './ui/Tooltip';
import { TOAST_MS, createPausableTimer, mergeToastRows, type ToastPhase, type ToastRow } from './ui/timers';

export { TOAST_MS };
const FADE_MS = 120;
const COLLAPSE_MS = 220;

/** One toast: it stays 6 s; hovering or focusing it pauses the timer. */
function Toast({ notice, active, onDone, onAction }: { notice: Notice; active: boolean; onDone(id: number): void; onAction?(notice: Notice): void }) {
  const timer = useRef<ReturnType<typeof createPausableTimer> | null>(null);
  useEffect(() => {
    if (!active) return;
    const tm = createPausableTimer(TOAST_MS, () => onDone(notice.id));
    timer.current = tm;
    tm.start();
    return () => tm.cancel();
  }, [active, notice.id, onDone]);
  const action = notice.action && onAction ? notice.action : null;
  return (
    <div
      className={`toast${action ? ' has-action' : ''}`}
      role="status"
      onMouseEnter={() => timer.current?.pause()}
      onMouseLeave={() => timer.current?.resume()}
      onFocus={() => timer.current?.pause()}
      onBlur={() => timer.current?.resume()}
      // The whole toast is a target for the mouse; the button inside is the one for the keyboard and for screen readers.
      onClick={action ? (e) => !(e.target as HTMLElement).closest('button') && onAction?.(notice) : undefined}
    >
      {action ? <span className="toast-text">{notice.text}</span> : notice.text}
      {action && (
        <Tooltip label={action.label} placement="top">
          <button className="icon-btn s24 toast-action" aria-label={action.label} onClick={() => onAction?.(notice)}>
            <ChevronRight size={16} />
          </button>
        </Tooltip>
      )}
    </div>
  );
}

export function Toasts({ notices, onDone, onAction }: { notices: Notice[]; onDone(id: number): void; onAction?(notice: Notice): void }) {
  const [rows, setRows] = useState<ToastRow<Notice>[]>(() => mergeToastRows([], notices));
  const scheduled = useRef(new Set<number>());
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => setRows((cur) => mergeToastRows(cur, notices)), [notices]);

  // A notice that left the list fades, then its slot folds away, then its row is dropped.
  useEffect(() => {
    for (const r of rows) {
      const id = r.notice.id;
      if (r.phase !== 'fading' || scheduled.current.has(id)) continue;
      scheduled.current.add(id);
      timers.current.push(setTimeout(() => setRows((cur) => cur.map((x) => (x.notice.id === id ? { ...x, phase: 'collapsing' as ToastPhase } : x))), FADE_MS));
      timers.current.push(
        setTimeout(() => {
          setRows((cur) => cur.filter((x) => x.notice.id !== id));
          scheduled.current.delete(id);
        }, FADE_MS + COLLAPSE_MS),
      );
    }
  }, [rows]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  return (
    <div className="toasts">
      {rows.map((r) => (
        <div key={r.notice.id} className="toast-slot" data-phase={r.phase}>
          <div className="toast-slot-inner">
            <Toast notice={r.notice} active={r.phase === 'open'} onDone={onDone} onAction={onAction} />
          </div>
        </div>
      ))}
    </div>
  );
}
