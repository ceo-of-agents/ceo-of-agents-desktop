// Steps 10 and 11: policy (only where it applies) and repositories with attribution.
import { t } from '../../shared/strings';
import { applicability, blankRepo, type Draft } from '../create-org-logic';
import { Button } from '../ui/Button';
import { ChoiceField, DeferField, EntryCard, laterOption, Notice, TextField, type Option } from './fields';
import type { StepProps } from './types';

/** The meaning line of an option when the strings have one (`<key>.m`), else none. */
function meaningOf(key: string): string | undefined {
  const m = t(`${key}.m`);
  return m === `${key}.m` ? undefined : m;
}

const yesNo = (): Option[] => [
  { value: 'yes', label: t('createOrg.o.yes') },
  { value: 'no', label: t('createOrg.o.no') },
];
const yn = (v: boolean | null): string | null => (v === null ? null : v ? 'yes' : 'no');

export function PolicyStep({ draft, errors, update }: StepProps) {
  const a = applicability(draft);
  return (
    <>
      {a.employerRules && <DeferField k="employer_rules" errors={errors} allowNone mono value={draft.employerRules} onChange={(v) => update((d) => void (d.employerRules = v))} />}
      {a.policy && (
        <>
          <ChoiceField
            k="policy"
            errors={errors}
            value={draft.policy.mode}
            options={[{ value: 'repo', label: t('createOrg.o.policy.repo') }, { value: 'none', label: t('createOrg.o.policy.none') }, laterOption()]}
            onChange={(v) => update((d) => void (d.policy.mode = v as Draft['policy']['mode']))}
          />
          {draft.policy.mode === 'repo' && (
            <>
              <TextField k="policy.repo" errors={errors} mono value={draft.policy.repo} onChange={(v) => update((d) => void (d.policy.repo = v))} />
              <TextField k="policy.local" errors={errors} mono value={draft.policy.local} onChange={(v) => update((d) => void (d.policy.local = v))} />
              <TextField k="policy.pin" errors={errors} mono value={draft.policy.pin} onChange={(v) => update((d) => void (d.policy.pin = v))} />
            </>
          )}
        </>
      )}
    </>
  );
}

export function ReposAttributionStep({ draft, errors, update }: StepProps) {
  const a = applicability(draft);
  const slugs = draft.repos.items.map((r) => r.slug.trim()).filter((s) => s !== '');
  return (
    <>
      <DeferField k="remote.hq" errors={errors} allowNone mono value={draft.remoteHq} onChange={(v) => update((d) => void (d.remoteHq = v))} />
      {draft.purpose === 'personal' && <Notice>{t('createOrg.n.remotePersonal')}</Notice>}
      {draft.remoteHq.mode === 'none' && <Notice>{t('createOrg.n.noRemote')}</Notice>}
      {a.policiesRepo && (
        <>
          <TextField k="policies_repo.path" errors={errors} mono value={draft.policiesRepo.path} onChange={(v) => update((d) => void (d.policiesRepo.path = v))} />
          <DeferField k="policies_repo.remote" errors={errors} allowNone mono value={draft.policiesRepo.remote} onChange={(v) => update((d) => void (d.policiesRepo.remote = v))} />
        </>
      )}
      {a.hostedOn && (
        <ChoiceField
          k="remote.hosted_on"
          errors={errors}
          value={draft.hostedOn}
          options={(['personal', 'employer', 'undecided'] as const).map((h) => ({ value: h, label: t(`createOrg.o.hostedOn.${h}`) }))}
          onChange={(v) => update((d) => void (d.hostedOn = v as Draft['hostedOn']))}
        />
      )}
      {a.repos && (
        <>
          <ChoiceField
            k="repos"
            errors={errors}
            value={draft.repos.mode}
            options={[{ value: 'list', label: t('createOrg.o.repos.list') }, { value: 'none', label: t('createOrg.o.none') }, laterOption()]}
            onChange={(v) => update((d) => void (d.repos.mode = v as Draft['repos']['mode']))}
          />
          {draft.repos.mode === 'list' && (
            <>
              {draft.repos.items.map((r, i) => {
                const k = `repos.${i}`;
                const set = (patch: Partial<typeof r>) => update((d) => void Object.assign(d.repos.items[i], patch));
                return (
                  <EntryCard key={i} title={t('createOrg.cardRepo', { n: i + 1 })} onRemove={() => update((d) => void d.repos.items.splice(i, 1))}>
                    <TextField k={`${k}.slug`} q="repos.slug" errors={errors} mono value={r.slug} onChange={(v) => set({ slug: v })} />
                    <TextField k={`${k}.role`} q="repos.role" errors={errors} value={r.role} onChange={(v) => set({ role: v })} />
                    <ChoiceField k={`${k}.visibility`} q="repos.visibility" errors={errors} columns={2} value={r.visibility} options={(['public', 'private'] as const).map((x) => ({ value: x, label: t(`createOrg.o.visibility.${x}`) }))} onChange={(v) => set({ visibility: v as 'public' | 'private' })} />
                    <ChoiceField k={`${k}.protected`} q="repos.protected" errors={errors} columns={2} value={yn(r.protected)} options={yesNo()} onChange={(v) => set({ protected: v === 'yes' })} />
                    <ChoiceField k={`${k}.exists`} q="repos.exists" errors={errors} columns={2} value={yn(r.exists)} options={yesNo()} onChange={(v) => set({ exists: v === 'yes' })} />
                  </EntryCard>
                );
              })}
              <div className="co-add-row">
                <Button onClick={() => update((d) => void d.repos.items.push(blankRepo()))}>{t('createOrg.addRepo')}</Button>
              </div>
              <ChoiceField
                k="issues_home"
                errors={errors}
                value={draft.issuesHome.trim() === '' ? null : draft.issuesHome.trim()}
                options={[...slugs.map((s) => ({ value: s, label: s })), { value: 'hq', label: t('createOrg.o.issuesHome.hq') }]}
                onChange={(v) => update((d) => void (d.issuesHome = v))}
              />
              <Notice>{t('createOrg.n.reposFolder')}</Notice>
            </>
          )}
          <ChoiceField
            k="roadmap"
            errors={errors}
            value={draft.roadmap.mode}
            options={[{ value: 'board', label: t('createOrg.o.roadmap.board') }, { value: 'none', label: t('createOrg.o.none') }, laterOption()]}
            onChange={(v) => update((d) => void (d.roadmap.mode = v as Draft['roadmap']['mode']))}
          />
          {draft.roadmap.mode === 'board' && (
            <>
              <TextField k="roadmap.url" errors={errors} mono value={draft.roadmap.url} onChange={(v) => update((d) => void (d.roadmap.url = v))} />
              <TextField k="roadmap.status_field" errors={errors} value={draft.roadmap.statusField} onChange={(v) => update((d) => void (d.roadmap.statusField = v))} />
            </>
          )}
        </>
      )}
      <ChoiceField
        k="attribution"
        errors={errors}
        value={draft.attribution.mode}
        options={[
          ...(['default', 'custom', 'none'] as const).map((m) => ({ value: m, label: t(`createOrg.o.attribution.${m}`), meaning: meaningOf(`createOrg.o.attribution.${m}`) })),
          laterOption(),
        ]}
        onChange={(v) => update((d) => void (d.attribution.mode = v as Draft['attribution']['mode']))}
      />
      {draft.attribution.mode === 'custom' && (
        <>
          <TextField k="attribution.commit" errors={errors} value={draft.attribution.commit} onChange={(v) => update((d) => void (d.attribution.commit = v))} />
          <TextField k="attribution.pr" errors={errors} value={draft.attribution.pr} onChange={(v) => update((d) => void (d.attribution.pr = v))} />
        </>
      )}
    </>
  );
}
