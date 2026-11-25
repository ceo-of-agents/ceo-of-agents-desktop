// Steps 6 and 7: departments (catalog picks, custom departments, your own agents or skills) and names.
import { t } from '../../shared/strings';
import { agentNames, blankCustom, blankOwn, departmentEntries, type DraftOwned } from '../create-org-logic';
import { Button } from '../ui/Button';
import { ChoiceField, DeferField, EntryCard, Field, MultiField, Notice, SelectField, Subhead, TextField, type Errors } from './fields';
import type { StepProps } from './types';

const blankOwned = (): DraftOwned => ({ item: '', owner: '' });

/** "What must it not do, and who does that instead": rows of an item and its owner, with Remove and an Add button. */
function OwnedList({ k, q, errors, list, onChange }: { k: string; q: string; errors: Errors; list: DraftOwned[]; onChange(next: DraftOwned[]): void }) {
  const set = (i: number, patch: Partial<DraftOwned>) => onChange(list.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <Field k={k} q={q} errors={errors}>
      {list.map((x, i) => (
        <div className="co-owned" key={i}>
          <TextField k={`${k}.${i}.item`} label={t('createOrg.ownedItem')} errors={errors} value={x.item} onChange={(v) => set(i, { item: v })} />
          <TextField k={`${k}.${i}.owner`} label={t('createOrg.q.departments.owner')} errors={errors} value={x.owner} onChange={(v) => set(i, { owner: v })} />
          {list.length > 1 && (
            <Button variant="quiet" small onClick={() => onChange(list.filter((_, j) => j !== i))}>
              {t('createOrg.remove')}
            </Button>
          )}
        </div>
      ))}
      <Button small onClick={() => onChange([...list, blankOwned()])}>
        {t('createOrg.addOwned')}
      </Button>
    </Field>
  );
}

export function DepartmentsStep({ draft, data, errors, update }: StepProps) {
  const personal = draft.purpose === 'personal';
  const entries = departmentEntries(draft, data);
  const catalog = data.catalog.filter((c) => !c.personalOnly || personal);
  return (
    <>
      {personal && <Notice>{t('createOrg.n.personalDepartments')}</Notice>}
      <MultiField
        k="departments"
        errors={errors}
        values={draft.catalog}
        options={[
          ...catalog.map((c) => ({ value: c.id, label: c.role, meaning: c.purpose, suggested: c.personalOnly })),
          { value: 'none', label: t('createOrg.o.noDepartments'), disabled: entries.length > 0 && !draft.noDepartments },
        ]}
        onToggle={(id, on) =>
          update((d) => {
            if (id === 'none') {
              d.noDepartments = on;
              return;
            }
            d.catalog = on ? [...d.catalog, id] : d.catalog.filter((x) => x !== id);
            if (on) d.noDepartments = false;
          })
        }
      />
      {draft.custom.map((c, i) => {
        const k = `departments.custom.${i}`;
        const set = (patch: Partial<typeof c>) => update((d) => void Object.assign(d.custom[i], patch));
        return (
          <EntryCard key={i} title={t('createOrg.cardCustom', { n: i + 1 })} onRemove={() => update((d) => void d.custom.splice(i, 1))}>
            <TextField k={`${k}.id`} q="departments.custom.id" errors={errors} mono value={c.id} onChange={(v) => set({ id: v })} />
            <TextField k={`${k}.role`} q="departments.custom.role" errors={errors} value={c.role} onChange={(v) => set({ role: v })} />
            <TextField k={`${k}.purpose`} q="departments.custom.purpose" errors={errors} value={c.purpose} onChange={(v) => set({ purpose: v })} />
            <TextField k={`${k}.scope`} q="departments.custom.scope" errors={errors} area list value={c.scope} onChange={(v) => set({ scope: v })} />
            <TextField k={`${k}.triggers`} q="departments.custom.triggers" errors={errors} area list value={c.triggers} onChange={(v) => set({ triggers: v })} />
            <OwnedList k={`${k}.exclusions`} q="departments.custom.exclusions" errors={errors} list={c.exclusions} onChange={(next) => set({ exclusions: next })} />
            <TextField k={`${k}.core_job`} q="departments.custom.core_job" errors={errors} value={c.coreJob} onChange={(v) => set({ coreJob: v })} />
          </EntryCard>
        );
      })}
      {draft.own.map((o, i) => {
        const k = `departments.own.${i}`;
        const set = (patch: Partial<typeof o>) => update((d) => void Object.assign(d.own[i], patch));
        return (
          <EntryCard key={i} title={t('createOrg.cardOwn', { n: i + 1 })} onRemove={() => update((d) => void d.own.splice(i, 1))}>
            <TextField k={`${k}.id`} q="departments.own.id" errors={errors} mono value={o.id} onChange={(v) => set({ id: v })} />
            <TextField k={`${k}.name`} q="departments.own.name" errors={errors} mono value={o.name} onChange={(v) => set({ name: v })} />
            <ChoiceField k={`${k}.kind`} q="departments.own.kind" errors={errors} columns={2} value={o.kind} options={(['agent', 'skill'] as const).map((x) => ({ value: x, label: t(`createOrg.o.kind.${x}`) }))} onChange={(v) => set({ kind: v as 'agent' | 'skill' })} />
            <TextField k={`${k}.location`} q="departments.own.location" errors={errors} value={o.location} onChange={(v) => set({ location: v })} />
            <TextField k={`${k}.purpose`} q="departments.own.purpose" errors={errors} value={o.purpose} onChange={(v) => set({ purpose: v })} />
            <TextField k={`${k}.use_when`} q="departments.own.use_when" errors={errors} area list value={o.useWhen} onChange={(v) => set({ useWhen: v })} />
            <OwnedList k={`${k}.must_not`} q="departments.own.must_not" errors={errors} list={o.mustNot} onChange={(next) => set({ mustNot: next })} />
            <SelectField
              k={`${k}.replaces`}
              q="departments.own.replaces"
              errors={errors}
              value={o.replaces ?? ''}
              options={[{ value: 'none', label: t('createOrg.o.replaces.none') }, ...catalog.map((c) => ({ value: c.id, label: c.role }))]}
              onChange={(v) => set({ replaces: v === '' ? null : v })}
            />
          </EntryCard>
        );
      })}
      <div className="co-add-row">
        <Button onClick={() => update((d) => void d.custom.push(blankCustom()))}>{t('createOrg.addCustom')}</Button>
        <Button onClick={() => update((d) => void d.own.push(blankOwn()))}>{t('createOrg.addOwn')}</Button>
      </div>
    </>
  );
}

export function NamesStep({ draft, data, errors, update }: StepProps) {
  const entries = departmentEntries(draft, data);
  const agents = agentNames(draft, data);
  return (
    <>
      <TextField k="names.cos" errors={errors} value={draft.names.cos} onChange={(v) => update((d) => void (d.names.cos = v))} />
      {entries.length > 0 && (
        <>
          <Subhead>{t('createOrg.q.names.departments')}</Subhead>
          <p className="co-help">{t('createOrg.h.names.departments')}</p>
        </>
      )}
      {entries.map((e) => (
        <TextField
          key={e.id}
          k={`names.departments.${e.id}`}
          label={`${e.role} (${e.id})`}
          errors={errors}
          value={draft.names.departments[e.id] ?? ''}
          below={agents[e.id] && draft.names.departments[e.id] ? <p className="co-help mono">{agents[e.id]}</p> : undefined}
          onChange={(v) => update((d) => void (d.names.departments[e.id] = v))}
        />
      ))}
      <DeferField k="names.ceo" errors={errors} value={draft.names.ceo} onChange={(v) => update((d) => void (d.names.ceo = v))} />
    </>
  );
}
