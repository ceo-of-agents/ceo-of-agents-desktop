// The done state (spec section 9) and the error state (section 10) of "Create a new org".
import { useId, useState, type ReactNode } from 'react';
import type { SetupFacts } from '../../shared/setup';
import { t } from '../../shared/strings';
import { INSTALL_COMMAND, initFleetCommand } from '../create-org-run';
import { Check, ChevronRight, X } from '../icons';
import { Markdown } from '../Markdown';
import { Button } from '../ui/Button';
import { Fold } from '../ui/Fold';
import { ReplyBox } from './ReplyBox';
import { useFocusOnMount } from './useFocusOnMount';

type MarkKind = 'done' | 'action' | 'failed';

/** The 20 px status mark of the prerequisites list: green disc with a check, orange "!", red "x". Words always go with it. */
function Mark({ kind, label }: { kind: MarkKind; label: string }) {
  return (
    <span className={`mark20 ${kind}`} role="img" aria-label={label}>
      {kind === 'done' && <Check size={12} strokeWidth={3} />}
      {kind === 'action' && <span className="bang">!</span>}
      {kind === 'failed' && <X size={12} strokeWidth={3} />}
    </span>
  );
}

const markWords = (k: MarkKind): string => t(k === 'done' ? 'prereq.status.done' : k === 'action' ? 'prereq.status.action' : 'prereq.status.failed');

function Item({ kind, children }: { kind: MarkKind; children: ReactNode }) {
  return (
    <li>
      <Mark kind={kind} label={markWords(kind)} />
      <div className="co-item-body">{children}</div>
    </li>
  );
}

interface DoneProps {
  name: string;
  cosName: string;
  folder: string;
  facts: SetupFacts;
  todoCount: number;
  /** The wizard's last message. */
  message: string | null;
  error: string | null;
  opening: boolean;
  onOpen(): void;
  /** A reply to the wizard (the run is still alive until the CEO opens the org). */
  onSend(text: string): void;
}

export function DoneView({ name, cosName, folder, facts, todoCount, message, error, opening, onOpen, onSend }: DoneProps) {
  // The plugin is not enabled or nothing was committed: the wizard may still be waiting for an answer (the app cannot read its
  // questions), so its last message stays visible, open, with the reply box.
  const incomplete = !facts.pluginEnabled || !facts.commit;
  const [fold, setFold] = useState(incomplete);
  const foldId = useId();
  const titleRef = useFocusOnMount<HTMLHeadingElement>();
  return (
    <div className="co-run">
      <h2 className="co-title" tabIndex={-1} ref={titleRef}>
        {t('createOrg.ready', { name })}
      </h2>
      <ul className="co-checks">
        <Item kind="done">{t('createOrg.done.hq', { folder })}</Item>
        {facts.pluginEnabled ? (
          <Item kind="done">{t('createOrg.done.plugin')}</Item>
        ) : (
          <Item kind="action">
            {t('createOrg.done.pluginNo')}
            <pre className="co-code">{INSTALL_COMMAND}</pre>
          </Item>
        )}
        {facts.commit ? <Item kind="done">{t('createOrg.done.saved', { commit: facts.commit })}</Item> : <Item kind="action">{t('createOrg.done.savedNo')}</Item>}
        <Item kind="done">{t('createOrg.done.todos', { count: todoCount })}</Item>
      </ul>
      {error && <p className="error-text">{error}</p>}
      <div className="co-run-actions">
        <Button variant="primary" loading={opening} loadingLabel={t('createOrg.opening')} onClick={onOpen}>
          {t('createOrg.openCos', { cosName })}
        </Button>
      </div>
      {message && (
        <div className="co-details">
          <button type="button" className="step-summary" aria-expanded={fold} aria-controls={foldId} onClick={() => setFold((o) => !o)}>
            <ChevronRight size={10} className="chev" />
            <span>{t(incomplete ? 'createOrg.lastMessage' : 'createOrg.details')}</span>
          </button>
          <Fold open={fold} id={foldId}>
            <div className="co-fold-body">
              <div className="text md co-message">
                <Markdown text={message} />
              </div>
              {incomplete && <ReplyBox label={t('createOrg.reply')} onSend={onSend} />}
            </div>
          </Fold>
        </div>
      )}
    </div>
  );
}

interface FailedProps {
  /** The hq exists but a check failed (title "Created with problems"), else "The org was not created". */
  created: boolean;
  /** What the wizard reported, verbatim. */
  text: string;
  answersFile: string;
  folder: string;
  steps: string[];
  /** "Try again" only while the folder is still empty. */
  canRetry: boolean;
  onRetry(): void;
  onBack(): void;
}

export function FailedView({ created, text, answersFile, folder, steps, canRetry, onRetry, onBack }: FailedProps) {
  const [fold, setFold] = useState(false);
  const foldId = useId();
  const titleRef = useFocusOnMount<HTMLHeadingElement>();
  return (
    <div className="co-run">
      <div className="co-fail-head">
        <Mark kind="failed" label={markWords('failed')} />
        <h2 className="co-title" tabIndex={-1} ref={titleRef}>
          {t(created ? 'createOrg.problems' : 'createOrg.failed')}
        </h2>
      </div>
      {text && <pre className="co-verbatim">{text}</pre>}
      <p className="muted">{t('createOrg.answersKept')}</p>
      {answersFile && (
        <>
          <p className="co-help">{t('createOrg.answersFile')}</p>
          <code className="co-path">{answersFile}</code>
          <p className="muted">{t('createOrg.terminal', { folder })}</p>
          <pre className="co-code">{initFleetCommand(answersFile)}</pre>
        </>
      )}
      <div className="co-run-actions">
        {canRetry && (
          <Button variant="primary" onClick={onRetry}>
            {t('createOrg.tryAgain')}
          </Button>
        )}
        <Button onClick={onBack}>{t('createOrg.backToSummary')}</Button>
      </div>
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
    </div>
  );
}
