import { cloneElement, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { usePresence } from './hooks';
import { TOOLTIP_DELAY_MS, createTooltipController } from './timers';

type Placement = 'bottom' | 'right' | 'top';
type Child = ReactElement<{
  onMouseEnter?(e: MouseEvent): void;
  onMouseLeave?(e: MouseEvent): void;
  onMouseDown?(e: MouseEvent): void;
  onFocus?(e: FocusEvent): void;
  onBlur?(e: FocusEvent): void;
  'aria-describedby'?: string;
}>;

let nextId = 1;

function place(rect: DOMRect, tip: { width: number; height: number }, placement: Placement): { top: number; left: number } {
  const gap = 6;
  let top = rect.bottom + gap;
  let left = rect.left + rect.width / 2 - tip.width / 2;
  if (placement === 'top') top = rect.top - gap - tip.height;
  if (placement === 'right') {
    top = rect.top + rect.height / 2 - tip.height / 2;
    left = rect.right + gap;
  }
  const maxLeft = window.innerWidth - tip.width - 8;
  return { top: Math.max(8, Math.min(top, window.innerHeight - tip.height - 8)), left: Math.max(8, Math.min(left, maxLeft)) };
}

/**
 * A tooltip for one child element (an icon button, an org tile). Shows after 400 ms of hover, at once on keyboard focus;
 * enters in 120 ms, exits in 80 ms. An empty `label` turns it off. It replaces the native `title`.
 */
export function Tooltip({ label, content, placement = 'bottom', children }: { label: string; /** Rich content shown instead of the label text (the label still turns the tooltip on or off). */ content?: ReactNode; placement?: Placement; children: Child }) {
  const [visible, setVisible] = useState(false);
  const anchor = useRef<HTMLElement | null>(null);
  const tip = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const id = useMemo(() => `tt-${nextId++}`, []);
  const controller = useMemo(() => createTooltipController(TOOLTIP_DELAY_MS, setVisible), []);
  const { mounted, state } = usePresence(visible && !!label, 80);

  useEffect(() => () => controller.hide(), [controller]);
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && controller.hide();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [visible, controller]);
  useLayoutEffect(() => {
    if (mounted && state === 'open' && anchor.current && tip.current) setPos(place(anchor.current.getBoundingClientRect(), tip.current.getBoundingClientRect(), placement));
  }, [mounted, state, placement, label]);

  const props = children.props;
  // The child may have a ref of its own (a callback or an object): keep it next to the anchor.
  const own = (children as unknown as { ref?: ((el: HTMLElement | null) => void) | { current: HTMLElement | null } | null }).ref;
  const child = cloneElement(children, {
    ref: (el: HTMLElement | null) => {
      anchor.current = el;
      if (typeof own === 'function') own(el);
      else if (own) own.current = el;
    },
    'aria-describedby': mounted ? id : props['aria-describedby'],
    onMouseEnter: (e: MouseEvent) => {
      props.onMouseEnter?.(e);
      if (label) controller.hover();
    },
    onMouseLeave: (e: MouseEvent) => {
      props.onMouseLeave?.(e);
      controller.hide();
    },
    onMouseDown: (e: MouseEvent) => {
      props.onMouseDown?.(e);
      controller.hide();
    },
    onFocus: (e: FocusEvent) => {
      props.onFocus?.(e);
      if (label && (e.target as HTMLElement).matches(':focus-visible')) controller.focus();
    },
    onBlur: (e: FocusEvent) => {
      props.onBlur?.(e);
      controller.hide();
    },
  } as never);

  return (
    <>
      {child}
      {mounted && label
        ? createPortal(
            <div ref={tip} id={id} role="tooltip" className="tooltip" data-state={state} style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: 'hidden' }}>
              {content ?? label}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
