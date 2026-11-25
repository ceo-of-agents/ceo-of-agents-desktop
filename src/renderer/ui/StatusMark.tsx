import { Spinner } from './Spinner';

export type StatusState = 'ok' | 'syncing' | 'attention' | 'degraded' | 'error';

/** The marks of 5.4: ok dot, syncing arc, attention ring, degraded half ring, error disc with "!". Always with its label (colour is never alone). */
export function StatusMark({ state, label }: { state: StatusState; label: string }) {
  return (
    <span className="status-mark" data-state={state}>
      <span className="mark-box" key={state} aria-hidden="true">
        {state === 'syncing' ? <Spinner size={10} delay={0} /> : <span className="mark">{state === 'error' ? '!' : null}</span>}
      </span>
      <span className="mark-label">{label}</span>
    </span>
  );
}
