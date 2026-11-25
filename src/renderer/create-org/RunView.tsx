// The running state (spec section 8): the real activity line, elapsed time, the milestones that appeared in the folder, the details fold,
// permission cards of the run and, when the wizard waits for an answer, its message verbatim with a reply box.
import { useEffect, useId, useRef, useState } from 'react';
import type { SetupFacts } from '../../shared/setup';
import type { PermissionRequest, ThreadInfo } from '../../shared/types';
import { t } from '../../shared/strings';
import { formatElapsed, looksLikeQuestion, mentionsNonEmptyFolder, milestones, runSteps, throttleStep, type Throttled } from '../create-org-run';
import { Check, ChevronRight } from '../icons';
import { livePhase } from '../logic';
import { Markdown } from '../Markdown';
import { PermissionCard } from '../ThreadView';
import { Button } from '../ui/Button';
import { Fold } from '../ui/Fold';
import { Spinner } from '../ui/Spinner';
import { ReplyBox } from './ReplyBox';

const ACTIVITY_MS = 2000;

/** The latest value, but never changing more often than every `ms` (the live region says at most one thing per interval). */
function useThrottledLine(value: string, ms: number): string {
  const [state, setState] = useState<Throttled>({ shown: value, at: Date.now() });
  useEffect(() => {
    const { next, waitMs } = throttleStep(state, value, Date.now(), ms);
    if (next !== state) setState(next);
    if (waitMs > 0) {
      const id = setTimeout(() => setState((s) => throttleStep(s, value, Date.now(), ms).next), waitMs);
      return () => clearTimeout(id);
    }
  }, [value, ms, state]);
  return state.shown;
}

function useElapsed(startedAt: number): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return formatElapsed(now - startedAt);
}

interface Props {
  name: string;
  phase: 'working' | 'asking';
  startedAt: number;
  facts: SetupFacts;
  thread: ThreadInfo | undefined;
  /** The wizard's latest message, shown verbatim when it waits for an answer. */
  message: string | null;
  permissions: PermissionRequest[];
  onSend(text: string): void;
  onStop(): void;
}

export function RunView({ name, phase, startedAt, facts, thread, message, permissions, onSend, onStop }: Props) {
  const title = useRef<HTMLHeadingElement>(null);
  const [fold, setFold] = useState(false);
  const foldId = useId();
  const elapsed = useElapsed(startedAt);
  const live = livePhase({ permissionPending: permissions.length > 0, streaming: thread?.streaming ?? '', current: thread?.activity?.current });
  const line = useThrottledLine(live.text, ACTIVITY_MS);
  // Focus goes to the title, not a button: on first show and again when the wizard starts asking.
  useEffect(() => {
    title.current?.focus();
  }, [phase]);
  const steps = runSteps(thread);
  // The wizard's Step 0 message about a folder that is not empty: continuing needs an explicit, worded confirmation, never one click.
  // Yes and No only for a message that asks something.
  const oneClick = looksLikeQuestion(message) && !mentionsNonEmptyFolder(message);
  return (
    <div className="co-run">
      <h2 className="co-title" tabIndex={-1} ref={title}>
        {phase === 'asking' ? t('createOrg.asking') : t('createOrg.running', { name })}
      </h2>
      {phase === 'working' ? (
        <>
          <div className="co-live">
            <Spinner />
            <span className="co-live-text" aria-hidden="true">
              {line}
            </span>
            <span className="sr-only" aria-live="polite">
              {line}
            </span>
            <span className="co-elapsed tnum" aria-label={t('createOrg.elapsed', { time: elapsed })}>
              {elapsed}
            </span>
          </div>
          <ul className="co-milestones" aria-label={t('createOrg.milestones')}>
            {milestones(facts).map((m) => (
              <li key={m.id} className={m.done ? 'done' : undefined}>
                <span className={`mark20 ${m.done ? 'done' : 'waiting'}`} aria-hidden="true">
                  {m.done && <Check size={12} strokeWidth={3} />}
                </span>
                <span>{t(`createOrg.milestone.${m.id}`)}</span>
                <span className="sr-only">{m.done ? t('prereq.status.done') : t('prereq.status.waiting')}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="co-ask">
          <div className="text md co-message">
            <Markdown text={message ?? ''} />
          </div>
          {oneClick && (
            <div className="co-run-actions">
              <Button variant="primary" onClick={() => onSend(t('createOrg.o.yes'))}>
                {t('createOrg.o.yes')}
              </Button>
              <Button onClick={() => onSend(t('createOrg.o.no'))}>{t('createOrg.o.no')}</Button>
            </div>
          )}
          <ReplyBox label={t(oneClick ? 'createOrg.replyOwn' : 'createOrg.reply')} onSend={onSend} />
        </div>
      )}
      {permissions.map((p) => (
        <PermissionCard key={p.requestId} request={p} />
      ))}
      {steps.length > 0 && (
        <div className="co-details">
          <button type="button" className="step-summary" aria-expanded={fold} aria-controls={foldId} onClick={() => setFold((o) => !o)}>
            <ChevronRight size={10} className="chev" />
            <span>{t('createOrg.details')}</span>
          </button>
          <Fold open={fold} id={foldId}>
            <ul className="co-steps">
              {steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </Fold>
        </div>
      )}
      <div className="co-run-foot">
        <Button onClick={onStop}>{t('createOrg.stop')}</Button>
      </div>
    </div>
  );
}
