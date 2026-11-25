import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../shared/strings';
import { COPIED_MS, writeClipboard } from './copy-logic';
import { AlertCircle, Check, Copy } from './icons';

type CopyState = 'idle' | 'copied' | 'failed';

/** An icon button that copies `text` as plain text. The icon turns into a check for a moment (or an alert when the write is
 * refused), then goes back. The timer is cleared on unmount. */
export function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  const copy = useCallback(() => {
    void writeClipboard(text).then((ok) => {
      if (!alive.current) return;
      if (timer.current) clearTimeout(timer.current);
      setState(ok ? 'copied' : 'failed');
      timer.current = setTimeout(() => setState('idle'), COPIED_MS);
    });
  }, [text]);
  const shown = state === 'copied' ? t('copy.copied') : state === 'failed' ? t('copy.failed') : label;
  const Icon = state === 'copied' ? Check : state === 'failed' ? AlertCircle : Copy;
  return (
    <button type="button" className={`icon-btn s24 copy-btn${state === 'idle' ? '' : ' done'}${className ? ` ${className}` : ''}`} aria-label={shown} title={shown} data-state={state} onClick={copy}>
      <Icon />
    </button>
  );
}
