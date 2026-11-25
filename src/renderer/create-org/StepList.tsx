// The step list (spec section 3): a list of buttons with the current step marked, done steps with a check, steps that need attention with an orange "!".
import { t } from '../../shared/strings';
import { stepClickable, stepLabelKey, stepState } from '../create-org-flow';
import type { StepId } from '../create-org-logic';
import { Check } from '../icons';

interface Props {
  steps: StepId[];
  current: StepId;
  done: StepId[];
  attention: StepId[];
  visited: StepId[];
  /** The run has started: the list is frozen. */
  frozen: boolean;
  onGo(step: StepId): void;
}

export function StepList({ steps, current, done, attention, visited, frozen, onGo }: Props) {
  return (
    <nav className="co-side" aria-label={t('createOrg.stepsLabel')}>
      <ol className="co-steps-list">
        {steps.map((s) => {
          const state = stepState(s, current, done, attention);
          const can = !frozen && stepClickable(state, visited.includes(s));
          return (
            <li key={s}>
              <button type="button" className={`co-step-row ${state}`} aria-current={state === 'current' && !frozen ? 'step' : undefined} aria-disabled={!can || undefined} onClick={() => can && state !== 'current' && onGo(s)}>
                <span>{t(stepLabelKey(s))}</span>
                {state === 'done' && <Check size={14} className="co-step-check" aria-label={t('prereq.status.done')} role="img" />}
                {state === 'attention' && (
                  <span className="co-bang" role="img" aria-label={t('createOrg.needsAttention')}>
                    !
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
