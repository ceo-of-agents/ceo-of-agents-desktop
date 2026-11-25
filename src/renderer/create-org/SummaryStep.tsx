// Step 12 (spec section 6): every answer by step with Edit, the to-dos the setup adds, and the question the wizard asks at summary time.
import { t } from '../../shared/strings';
import { questionKey, summaryRows, todos, type StepId } from '../create-org-logic';
import { stepLabelKey } from '../create-org-flow';
import { Button } from '../ui/Button';
import { ChoiceField } from './fields';
import type { StepProps } from './types';

export function SummaryStep({ draft, data, errors, update, onEdit }: StepProps & { onEdit(step: StepId): void }) {
  const blocks = summaryRows(draft, data).filter((b) => b.step !== 'summary');
  const list = todos(draft);
  return (
    <>
      {blocks.map((b) => (
        <section className="co-sum" key={b.step} aria-labelledby={`co-sum-${b.step}`}>
          <div className="co-sum-head">
            <h3 id={`co-sum-${b.step}`}>{t(stepLabelKey(b.step))}</h3>
            <Button variant="quiet" small aria-label={`${t('createOrg.edit')}: ${t(stepLabelKey(b.step))}`} onClick={() => onEdit(b.step)}>
              {t('createOrg.edit')}
            </Button>
          </div>
          <dl>
            {b.rows.map((r) => (
              <div className="co-sum-row" key={r.key}>
                <dt>{t(questionKey(r.key))}</dt>
                <dd className={r.mono ? 'mono' : undefined}>
                  {r.later ? (
                    <>
                      <span className="chip">{t('createOrg.later')}</span> <span className="muted">{t('createOrg.deferred')}</span>
                    </>
                  ) : r.valueKey ? (
                    t(r.valueKey)
                  ) : (
                    r.value
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      <section className="co-sum" aria-labelledby="co-todos">
        <h3 id="co-todos">{t('createOrg.todos', { count: list.length })}</h3>
        {list.length === 0 ? (
          <p className="muted">{t('createOrg.todosNone')}</p>
        ) : (
          <ul className="co-todos">
            {list.map((x, i) => (
              <li key={i}>
                <span className="chip">{t(`createOrg.urgency.${x.urgency}`)}</span> <span>{t(x.label, x.vars)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <ChoiceField
        k="enable_plugin"
        errors={errors}
        columns={2}
        value={draft.enablePlugin === null ? null : draft.enablePlugin ? 'yes' : 'no'}
        options={[{ value: 'yes', label: t('createOrg.o.yes') }, { value: 'no', label: t('createOrg.o.no') }]}
        onChange={(v) => update((d) => void (d.enablePlugin = v === 'yes'))}
      />
    </>
  );
}
