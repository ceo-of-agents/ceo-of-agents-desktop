// Steps 8 and 9: approval gates (what agents may do on their own) and model tiers.
import { t } from '../../shared/strings';
import type { GateAction, GateTier } from '../../shared/setup';
import { departmentEntries, type Draft } from '../create-org-logic';
import { ChoiceField, Field, MultiField, Notice, SelectField, Subhead } from './fields';
import type { StepProps } from './types';

const TIERS: GateTier[] = ['free', 'notice', 'ok'];
const rank = (tier: GateTier): number => TIERS.indexOf(tier);

/** The gates the plugin ships, grouped by tier, read only: the CEO sees what the table says before moving anything. */
function GateTable({ gates }: { gates: GateAction[] }) {
  return (
    <div className="co-gates">
      {TIERS.map((tier) => (
        <section key={tier} aria-label={t(`createOrg.o.tier.${tier}`)}>
          <h4>{t(`createOrg.o.tier.${tier}`)}</h4>
          <ul>
            {gates.filter((g) => g.tier === tier).map((g) => (
              <li key={g.id}>
                <code>{g.id}</code> <span className="muted">{g.meaning}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** One list of moves ("stricter" or "looser"): each action that can move that way has a select of the groups it can move to. */
function MoveList({ kind, draft, data, errors, update }: { kind: 'stricter' | 'looser' } & Pick<StepProps, 'draft' | 'data' | 'errors' | 'update'>) {
  const moves = draft.gates[kind];
  const targets = (g: GateAction): GateTier[] => TIERS.filter((x) => (kind === 'stricter' ? rank(x) > rank(g.tier) && x !== 'free' : rank(x) < rank(g.tier) && x !== 'ok'));
  const rows = data.gates.filter((g) => !g.locked && targets(g).length > 0);
  return (
    <Field k={`gates.${kind}`} q={`gates.${kind}`} errors={errors}>
      {rows.map((g) => (
        <SelectField
          key={g.id}
          k={`gates.${g.id}.${kind}`}
          label={`${g.id} (${t(`createOrg.o.tier.${g.tier}`)})`}
          errors={g.id in moves && (kind === 'stricter' || !(g.id in draft.gates.stricter)) ? { [`gates.${g.id}.${kind}`]: errors[`gates.${g.id}`] ?? '' } : {}}
          value={moves[g.id] ?? ''}
          options={targets(g).map((x) => ({ value: x, label: t(`createOrg.o.tier.${x}`) }))}
          onChange={(v) =>
            update((d) => {
              if (v === '') delete d.gates[kind][g.id];
              else d.gates[kind][g.id] = v as GateTier;
            })
          }
        />
      ))}
    </Field>
  );
}

export function GatesStep({ draft, data, errors, update }: StepProps) {
  const advisory = departmentEntries(draft, data)
    .filter((e) => e.from === 'catalog' && data.catalog.find((c) => c.id === e.id)?.advisory)
    .map((e) => e.role);
  return (
    <>
      <ChoiceField
        k="gates"
        errors={errors}
        value={draft.gates.mode}
        options={(['accept', 'custom'] as const).map((m) => ({ value: m, label: t(`createOrg.o.gates.${m}`) }))}
        onChange={(v) => update((d) => void (d.gates.mode = v as Draft['gates']['mode']))}
      />
      <GateTable gates={data.gates} />
      {advisory.length > 0 && <Notice>{t('createOrg.n.advisory', { names: advisory.join(', ') })}</Notice>}
      {draft.gates.mode === 'custom' && (
        <>
          <MoveList kind="stricter" draft={draft} data={data} errors={errors} update={update} />
          <MoveList kind="looser" draft={draft} data={data} errors={errors} update={update} />
        </>
      )}
      <ChoiceField
        k="destructive"
        errors={errors}
        value={draft.destructive}
        options={(['deny', 'ask'] as const).map((x) => ({ value: x, label: t(`createOrg.o.destructive.${x}`) }))}
        onChange={(v) => update((d) => void (d.destructive = v as Draft['destructive']))}
      />
    </>
  );
}

export function ModelsStep({ draft, data, errors, update }: StepProps) {
  const tier = (id: string) => ({ value: id, label: t(`createOrg.o.tier.${id}`) });
  const mine = departmentEntries(draft, data).filter((e) => e.from !== 'own');
  return (
    <>
      <Notice>{t('createOrg.n.workers')}</Notice>
      <ChoiceField k="models.cos" errors={errors} value={draft.models.cos} options={data.tiers.map(tier)} onChange={(v) => update((d) => void (d.models.cos = v))} />
      <ChoiceField k="models.departments" errors={errors} value={draft.models.departments} options={data.tiers.map(tier)} onChange={(v) => update((d) => void (d.models.departments = v))} />
      {mine.length > 0 && (
        <>
          <Subhead>{t('createOrg.q.models.overrides')}</Subhead>
          <p className="co-help">{t('createOrg.h.models.overrides')}</p>
          {mine.map((e) => (
            <SelectField
              key={e.id}
              k={`models.overrides.${e.id}`}
              label={`${e.role} (${e.id})`}
              errors={errors}
              value={draft.models.overrides[e.id] ?? ''}
              options={data.tiers.map(tier)}
              onChange={(v) =>
                update((d) => {
                  if (v === '') delete d.models.overrides[e.id];
                  else {
                    d.models.overrides[e.id] = v;
                    d.models.topWorkers = d.models.topWorkers.filter((x) => x !== e.id);
                  }
                })
              }
            />
          ))}
          <MultiField
            k="models.top_workers"
            errors={errors}
            values={draft.models.topWorkers}
            options={mine.map((e) => ({ value: e.id, label: `${e.role} (${e.id})`, disabled: e.id in draft.models.overrides }))}
            onToggle={(id, on) => update((d) => void (d.models.topWorkers = on ? [...d.models.topWorkers, id] : d.models.topWorkers.filter((x) => x !== id)))}
          />
        </>
      )}
    </>
  );
}
