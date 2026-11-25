import { useEffect, useRef } from 'react';

/** A ref whose element takes focus once, when it first shows (a title with tabindex -1: focus goes to the title, not a button). */
export function useFocusOnMount<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return ref;
}
