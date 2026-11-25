import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { t } from '../shared/strings';

const FOLD_MS = 220;

/**
 * Text clamped to `lines` lines (5.10). When it is really cut (measured, not guessed) a quiet "Show more" follows on its own line,
 * and the clamped text is clickable too. The height animates between the clamped and the full height (a measured max-height,
 * 220 ms); `-webkit-line-clamp` only applies while the text is at rest, collapsed. The caller owns `open`.
 */
export function ClampText({ open, onToggle, lines, className, text, children }: {
  open: boolean;
  onToggle(): void;
  lines: 2 | 3;
  className?: string;
  /** The source text: the measure runs again when it changes. */
  text: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [clamped, setClamped] = useState(!open);
  const [cut, setCut] = useState(false);
  const was = useRef(open);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !clamped) return;
    const measure = () => setCut(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, clamped]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || was.current === open) return;
    was.current = open;
    clearTimeout(timer.current);
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 18;
    // Set the DOM first (the class and the max-height must change in the same frame), then let React catch up.
    el.style.maxHeight = `${el.offsetHeight}px`;
    if (open) {
      el.classList.remove('clamp');
      setClamped(false);
      void el.offsetHeight; // commit the start height so the transition runs
      el.style.maxHeight = `${el.scrollHeight}px`;
      timer.current = setTimeout(() => { el.style.maxHeight = ''; }, FOLD_MS);
    } else {
      void el.offsetHeight;
      el.style.maxHeight = `${lh * lines}px`;
      timer.current = setTimeout(() => {
        el.classList.add('clamp');
        el.style.maxHeight = '';
        setClamped(true);
      }, FOLD_MS);
    }
  }, [open, lines]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onClick = (e: MouseEvent) => {
    if (!cut || open || (e.target as HTMLElement).closest('a') || window.getSelection()?.toString()) return;
    onToggle();
  };
  return (
    <div className="clamp-wrap">
      <div ref={ref} className={`clamp-text lines-${lines}${clamped ? ' clamp' : ''}${cut && !open ? ' cut' : ''} ${className ?? ''}`} onClick={onClick}>
        {children}
      </div>
      {(cut || open) && (
        <button className="show-more" aria-expanded={open} onClick={onToggle}>
          {t(open ? 'panel.showLess' : 'panel.showMore')}
        </button>
      )}
    </div>
  );
}
