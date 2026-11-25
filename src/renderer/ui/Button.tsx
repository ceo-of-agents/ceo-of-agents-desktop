import { useLayoutEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Spinner } from './Spinner';

export type ButtonVariant = 'secondary' | 'primary' | 'you' | 'you-outline' | 'quiet';

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant;
  small?: boolean;
  /** An icon before the label (16 px). */
  icon?: ReactNode;
  /** Loading: `aria-busy`, width kept, a spinner (after 300 ms), the "-ing" label, not clickable. */
  loading?: boolean;
  loadingLabel?: ReactNode;
  children: ReactNode;
}

export function buttonClass(variant: ButtonVariant = 'secondary', small = false, extra?: string): string {
  return ['btn', variant === 'secondary' ? '' : variant, small ? 'small' : '', extra ?? ''].filter(Boolean).join(' ');
}

export function Button({ variant = 'secondary', small, icon, loading, loadingLabel, children, className, onClick, disabled, ...rest }: Props) {
  const ref = useRef<HTMLButtonElement>(null);
  const restWidth = useRef(0);
  // Remember the width the button has at rest, so the loading label never makes it jump.
  useLayoutEffect(() => {
    if (!loading && ref.current) restWidth.current = ref.current.offsetWidth;
  });
  return (
    <button
      {...rest}
      ref={ref}
      className={buttonClass(variant, small, className)}
      disabled={disabled}
      aria-busy={loading ? true : undefined}
      style={loading && restWidth.current ? { ...rest.style, minWidth: restWidth.current } : rest.style}
      onClick={loading ? undefined : onClick}
    >
      {loading ? <Spinner /> : icon}
      {loading && loadingLabel !== undefined ? loadingLabel : children}
    </button>
  );
}
