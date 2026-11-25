// The controls of the "Create a new org" steps (spec sections 4 and 5): a field with its label, help and error line, radio cards,
// checkbox cards, text inputs, "Answer later" and repeating entries. Nothing here preselects an answer.
import type { ReactNode } from 'react';
import { t } from '../../shared/strings';
import { AlertCircle, ChevronRight, Info } from '../icons';
import { fieldId } from '../create-org-flow';
import { helpKey, questionKey, type Deferrable } from '../create-org-logic';
import { Button } from '../ui/Button';

export type Errors = Record<string, string>;

/** The ids a field's label, help and error line get; controls point at them with aria-labelledby and aria-describedby. */
const ids = (k: string) => ({ label: `${fieldId(k)}-label`, help: `${fieldId(k)}-help`, error: `${fieldId(k)}-error`, control: fieldId(k) });

interface FieldProps {
  /** The error key and the DOM id base. */
  k: string;
  /** The schema key of the question; defaults to `k`. */
  q?: string;
  errors: Errors;
  /** The question may be deferred: "(you can answer later)" after the label. */
  canWait?: boolean;
  /** One per line is added to the help (a list typed as text). */
  list?: boolean;
  /** A label of its own (a repeated entry); the question's help is then left out. */
  label?: string;
  /** The label is for one input (a `label` element); else the label names the group of controls. */
  input?: boolean;
  /** `radiogroup` for a single choice. */
  group?: 'radiogroup' | 'group';
  children: ReactNode;
}

export function Field({ k, q = k, errors, canWait, list, label: own, input, group, children }: FieldProps) {
  const i = ids(k);
  const error = errors[k];
  const help = own ? '' : [t(helpKey(q)), list ? t('createOrg.onePerLine') : ''].filter((x) => x !== '' && x !== helpKey(q)).join(' ');
  const label = (
    <>
      {own ?? t(questionKey(q))}
      {canWait && <span className="co-wait"> {t('createOrg.canWait')}</span>}
    </>
  );
  return (
    <div className="co-field" data-invalid={error ? 'true' : undefined}>
      {input ? (
        <label className="co-label" id={i.label} htmlFor={i.control}>
          {label}
        </label>
      ) : (
        <div className="co-label" id={i.label}>
          {label}
        </div>
      )}
      {help && (
        <p className="co-help" id={i.help}>
          {help}
        </p>
      )}
      {input ? children : (
        <div className="co-group" role={group ?? 'group'} aria-labelledby={i.label} aria-describedby={describedBy(k, !!help, !!error)} aria-invalid={error && group === 'radiogroup' ? true : undefined}>
          {children}
        </div>
      )}
      {error && <ErrorLine id={i.error} text={t(error)} />}
    </div>
  );
}

function describedBy(k: string, help: boolean, error: boolean): string | undefined {
  const i = ids(k);
  return [help ? i.help : '', error ? i.error : ''].filter(Boolean).join(' ') || undefined;
}

export function ErrorLine({ id, text }: { id?: string; text: string }) {
  return (
    <p className="co-error" id={id}>
      <AlertCircle size={12} />
      <span>{text}</span>
    </p>
  );
}

/** What an input needs to be linked to its field: id, invalid mark and the help and error lines. */
function inputProps(k: string, q: string, errors: Errors, own?: string) {
  const help = !own && t(helpKey(q)) !== '' && t(helpKey(q)) !== helpKey(q);
  return { id: ids(k).control, 'aria-invalid': errors[k] ? true : undefined, 'aria-describedby': describedBy(k, help, !!errors[k]) };
}

interface TextProps extends Omit<FieldProps, 'children' | 'input' | 'group'> {
  value: string;
  onChange(v: string): void;
  mono?: boolean;
  /** A textarea of at least 3 rows. */
  area?: boolean;
  disabled?: boolean;
  maxLength?: number;
  /** Shown below the control (a suggestion button). */
  below?: ReactNode;
}

export function TextField({ k, q = k, errors, value, onChange, mono, area, list, disabled, maxLength, canWait, below, label }: TextProps) {
  const common = { ...inputProps(k, q, errors, label), value, disabled, className: `${area ? 'co-area' : 'input'}${mono ? ' mono' : ''}`, spellCheck: false as const, autoComplete: 'off' };
  return (
    <Field k={k} q={q} errors={errors} input list={list} canWait={canWait} label={label}>
      {area ? <textarea {...common} rows={3} onChange={(e) => onChange(e.target.value)} /> : <input {...common} type="text" maxLength={maxLength} onChange={(e) => onChange(e.target.value)} />}
      {below}
    </Field>
  );
}

export interface Option {
  value: string;
  label: string;
  meaning?: string;
  /** The muted SUGGESTED chip: a suggestion, never ticked for the CEO. */
  suggested?: boolean;
  disabled?: boolean;
}

/** The "Later" radio card of a deferrable choice (an explicit answer, never a default). */
export const laterOption = (): Option => ({ value: 'later', label: t('createOrg.later'), meaning: t('createOrg.laterMeaning') });

function CardBody({ o }: { o: Option }) {
  return (
    <span className="co-card-text">
      <span className="co-card-title">
        {o.label}
        {o.suggested && <span className="chip co-chip">{t('createOrg.suggested')}</span>}
      </span>
      {o.meaning && <span className="co-card-meaning">{o.meaning}</span>}
    </span>
  );
}

interface ChoiceProps extends Omit<FieldProps, 'children' | 'input' | 'group' | 'list'> {
  options: Option[];
  value: string | null;
  onChange(v: string): void;
  /** Two cards side by side (yes or no). */
  columns?: 2;
}

export function ChoiceField({ k, q = k, errors, options, value, onChange, columns, canWait }: ChoiceProps) {
  return (
    <Field k={k} q={q} errors={errors} group="radiogroup" canWait={canWait}>
      <div className={`co-cards${columns === 2 ? ' two' : ''}`}>
        {options.map((o) => (
          <label key={o.value} className={`co-card${value === o.value ? ' selected' : ''}${o.disabled ? ' disabled' : ''}`}>
            <input type="radio" name={fieldId(k)} value={o.value} checked={value === o.value} disabled={o.disabled} onChange={() => onChange(o.value)} />
            <CardBody o={o} />
          </label>
        ))}
      </div>
    </Field>
  );
}

interface MultiProps extends Omit<FieldProps, 'children' | 'input' | 'group' | 'list'> {
  options: Option[];
  values: string[];
  onToggle(v: string, on: boolean): void;
}

export function MultiField({ k, q = k, errors, options, values, onToggle, canWait }: MultiProps) {
  return (
    <Field k={k} q={q} errors={errors} group="group" canWait={canWait}>
      <div className="co-cards">
        {options.map((o) => (
          <label key={o.value} className={`co-card${values.includes(o.value) ? ' selected' : ''}${o.disabled ? ' disabled' : ''}`}>
            <input type="checkbox" value={o.value} checked={values.includes(o.value)} disabled={o.disabled} onChange={(e) => onToggle(o.value, e.target.checked)} />
            <CardBody o={o} />
          </label>
        ))}
      </div>
    </Field>
  );
}

interface DeferProps extends Omit<FieldProps, 'children' | 'input' | 'group' | 'list' | 'canWait'> {
  value: Deferrable;
  onChange(v: Deferrable): void;
  /** "None" is a valid answer too (a second checkbox). */
  allowNone?: boolean;
  mono?: boolean;
}

/** A text answer that may be deferred: the field plus an "Answer later" checkbox that disables it (and "None" where it is valid). */
export function DeferField({ k, q = k, errors, value, onChange, allowNone, mono }: DeferProps) {
  const off = value.mode === 'later' || value.mode === 'none';
  const toggle = (mode: 'later' | 'none', on: boolean) => onChange(on ? { ...value, mode } : { ...value, mode: value.value.trim() === '' ? null : 'value' });
  return (
    <Field k={k} q={q} errors={errors} input canWait>
      <input {...inputProps(k, q, errors)} type="text" className={`input${mono ? ' mono' : ''}`} value={value.value} disabled={off} spellCheck={false} autoComplete="off" onChange={(e) => onChange({ mode: e.target.value.trim() === '' ? null : 'value', value: e.target.value })} />
      <label className="co-check">
        <input type="checkbox" checked={value.mode === 'later'} onChange={(e) => toggle('later', e.target.checked)} />
        <span>{t('createOrg.answerLater')}</span>
      </label>
      {allowNone && (
        <label className="co-check">
          <input type="checkbox" checked={value.mode === 'none'} onChange={(e) => toggle('none', e.target.checked)} />
          <span>{t('createOrg.o.none')}</span>
        </label>
      )}
    </Field>
  );
}

interface SelectProps extends Omit<FieldProps, 'children' | 'input' | 'group' | 'list'> {
  value: string;
  onChange(v: string): void;
  /** The first, empty option ("Choose…"): the field starts with nothing picked. */
  options: { value: string; label: string }[];
}

export function SelectField({ k, q = k, errors, value, onChange, options, canWait, label }: SelectProps) {
  return (
    <Field k={k} q={q} errors={errors} input canWait={canWait} label={label}>
      <span className="select-wrap">
        <select {...inputProps(k, q, errors, label)} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t('createOrg.choose')}</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronRight size={12} className="select-chev" />
      </span>
    </Field>
  );
}

/** A notice from the wizard: surface block with an Info icon. */
export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="co-notice" role="note">
      <Info size={16} className="co-notice-icon" />
      <p>{children}</p>
    </div>
  );
}

/** A warning: the orange "!" disc and the text (red is for errors only). */
export function Warning({ children }: { children: ReactNode }) {
  return (
    <p className="co-warning">
      <span className="co-bang" aria-hidden="true">
        !
      </span>
      <span>{children}</span>
    </p>
  );
}

/** One card of a repeating entry: its fields and a quiet Remove. */
export function EntryCard({ title, onRemove, children }: { title: string; onRemove?(): void; children: ReactNode }) {
  return (
    <section className="co-entry" aria-label={title}>
      <div className="co-entry-head">
        <h3>{title}</h3>
        {onRemove && (
          <Button variant="quiet" small onClick={onRemove}>
            {t('createOrg.remove')}
          </Button>
        )}
      </div>
      {children}
    </section>
  );
}

/** A group of questions without a label of its own (the wizard's questions under one heading). */
export function Subhead({ children }: { children: ReactNode }) {
  return <h3 className="co-subhead">{children}</h3>;
}
