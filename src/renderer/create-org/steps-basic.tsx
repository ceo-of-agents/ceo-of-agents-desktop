// Steps 1 to 5: language and profile, purpose and level, name and id, about the org, file language.
import { t } from '../../shared/strings';
import { stageKey, stagesFor, aboutVariant, suggestedId, type Draft } from '../create-org-logic';
import { Button } from '../ui/Button';
import { ChoiceField, Notice, TextField } from './fields';
import type { StepProps } from './types';

const PURPOSES = ['job', 'product', 'startup', 'company', 'personal'] as const;
const LEVELS = ['company', 'holding'] as const;

const meaning = (key: string): string => t(`${key}.m`);

export function LanguageProfileStep({ draft, errors, update }: StepProps) {
  return (
    <>
      <TextField k="language.chat" errors={errors} value={draft.language.chat} maxLength={2} mono onChange={(v) => update((d) => void (d.language.chat = v))} />
      <ChoiceField
        k="ceo.profile"
        errors={errors}
        value={draft.profile}
        options={(['technical', 'non-technical'] as const).map((p) => ({ value: p, label: t(`createOrg.o.profile.${p}`), meaning: meaning(`createOrg.o.profile.${p}`) }))}
        onChange={(v) => update((d) => void (d.profile = v as Draft['profile']))}
      />
    </>
  );
}

export function PurposeLevelStep({ draft, errors, changePurpose }: StepProps) {
  return (
    <>
      <ChoiceField
        k="org.purpose"
        errors={errors}
        value={draft.purpose}
        options={PURPOSES.map((p) => ({ value: p, label: t(`createOrg.o.purpose.${p}`), meaning: meaning(`createOrg.o.purpose.${p}`) }))}
        onChange={(v) => changePurpose({ purpose: v as (typeof PURPOSES)[number] })}
      />
      {draft.purpose === 'job' && <Notice>{t('createOrg.n.job')}</Notice>}
      {draft.purpose === 'personal' && <Notice>{t('createOrg.n.personal')}</Notice>}
      {draft.purpose === 'company' && (
        <ChoiceField
          k="org.level"
          errors={errors}
          value={draft.level}
          options={LEVELS.map((l) => ({ value: l, label: t(`createOrg.o.level.${l}`), meaning: meaning(`createOrg.o.level.${l}`) }))}
          onChange={(v) => changePurpose({ level: v as (typeof LEVELS)[number] })}
        />
      )}
      {draft.purpose !== null && draft.purpose !== 'company' && <Notice>{t('createOrg.n.levelNotAsked')}</Notice>}
    </>
  );
}

export function NameIdStep({ draft, errors, update }: StepProps) {
  const suggestion = suggestedId(draft.name);
  return (
    <>
      <TextField k="org.name" errors={errors} value={draft.name} onChange={(v) => update((d) => void (d.name = v))} />
      <TextField
        k="org.id"
        errors={errors}
        value={draft.id}
        mono
        maxLength={8}
        onChange={(v) => update((d) => void (d.id = v))}
        below={
          suggestion && suggestion !== draft.id.trim() ? (
            <Button variant="quiet" small className="co-suggest" onClick={() => update((d) => void (d.id = suggestion))}>
              {t('createOrg.useSuggestion', { suggestion })}
            </Button>
          ) : undefined
        }
      />
    </>
  );
}

export function AboutStep({ draft, errors, update }: StepProps) {
  const v = aboutVariant(draft.purpose, draft.level);
  return (
    <>
      <TextField k="about.what" q={`about.what.${v}`} errors={errors} area value={draft.about.what} onChange={(x) => update((d) => void (d.about.what = x))} />
      <TextField k="about.why" q={`about.why.${v}`} errors={errors} area value={draft.about.why} onChange={(x) => update((d) => void (d.about.why = x))} />
      <ChoiceField
        k="about.stage"
        q={`about.stage.${v}`}
        errors={errors}
        value={draft.about.stage}
        options={stagesFor(draft.purpose, draft.level).map((s) => ({ value: s, label: t(stageKey(s)) }))}
        onChange={(x) => update((d) => void (d.about.stage = x))}
      />
    </>
  );
}

export function FileLanguageStep({ draft, errors, update }: StepProps) {
  return <TextField k="language.files" errors={errors} value={draft.language.files} maxLength={2} mono onChange={(v) => update((d) => void (d.language.files = v))} />;
}
