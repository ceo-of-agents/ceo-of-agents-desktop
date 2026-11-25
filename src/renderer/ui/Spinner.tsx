import { useDelayed } from './hooks';
import { DELAY_LOADER_MS } from './timers';

/** A rotating arc. Shows only after `delay` ms (default 300) so fast actions never flash a loader; `delay={0}` shows it at once. */
export function Spinner({ size = 12, delay = DELAY_LOADER_MS, className }: { size?: 10 | 12; delay?: number; className?: string }) {
  const show = useDelayed(true, delay);
  if (!show) return null;
  return <span className={`spinner${size === 10 ? ' s10' : ''}${className ? ` ${className}` : ''}`} aria-hidden="true" />;
}
