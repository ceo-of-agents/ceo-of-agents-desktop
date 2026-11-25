import type { ReactNode } from 'react';

/** Expand and collapse through grid rows (0fr to 1fr, 220 ms). The caller owns the toggle and its `aria-expanded`/`aria-controls`. */
export function Fold({ open, id, className, children }: { open: boolean; id?: string; className?: string; children: ReactNode }) {
  return (
    <div id={id} className={`fold${className ? ` ${className}` : ''}`} data-open={open}>
      <div className="fold-inner">{children}</div>
    </div>
  );
}
