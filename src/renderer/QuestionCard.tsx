import { useId, useMemo, useState } from 'react';
import type { PermissionRequest } from '../shared/types';
import { buildAnswers, displayLabel, isRecommended, parseQuestions, type Question, type Selection } from '../shared/questions';
import { t } from '../shared/strings';
import { api } from './api';
import { Check } from './icons';
import { Button } from './ui/Button';

/** One question: header chip, text, the options as radios or checkboxes, "Other", and the preview of the option hovered or focused. */
function QuestionBlock({ q, index, value, onChange }: { q: Question; index: number; value: Selection; onChange(next: Selection): void }) {
  const id = useId();
  const [previewLabel, setPreviewLabel] = useState<string | null>(null);
  const preview = q.options.find((o) => o.label === previewLabel)?.preview;
  const role = q.multiSelect ? 'checkbox' : 'radio';
  const pick = (label: string) => {
    if (q.multiSelect) onChange({ ...value, labels: value.labels.includes(label) ? value.labels.filter((l) => l !== label) : [...value.labels, label] });
    else onChange({ labels: [label], other: '' });
  };
  return (
    <div className="question-block">
      {q.header && <span className="question-chip">{q.header}</span>}
      <div className="question-text" id={`${id}-q${index}`}>
        {q.question}
      </div>
      <div className="question-hint">{q.multiSelect ? t('question.pickMany') : t('question.pickOne')}</div>
      <div className="question-options" role={q.multiSelect ? 'group' : 'radiogroup'} aria-labelledby={`${id}-q${index}`}>
        {q.options.map((o) => {
          const checked = value.labels.includes(o.label);
          return (
            <button
              key={o.label}
              type="button"
              role={role}
              aria-checked={checked}
              className={`question-option${checked ? ' selected' : ''}`}
              onClick={() => pick(o.label)}
              onMouseEnter={() => o.preview && setPreviewLabel(o.label)}
              onMouseLeave={() => setPreviewLabel(null)}
              onFocus={() => setPreviewLabel(o.preview ? o.label : null)}
              onBlur={() => setPreviewLabel(null)}
            >
              <span className={`question-mark ${q.multiSelect ? 'box' : 'dot'}`} aria-hidden="true">
                {q.multiSelect && checked && <Check size={12} />}
              </span>
              <span className="question-option-body">
                <span className="question-option-label">
                  {displayLabel(o.label)}
                  {isRecommended(o.label) && <span className="question-recommended">{t('question.recommended')}</span>}
                </span>
                {o.description && <span className="question-option-desc">{o.description}</span>}
              </span>
            </button>
          );
        })}
      </div>
      {preview && (
        <pre className="question-preview" aria-label={t('question.preview')}>
          {preview}
        </pre>
      )}
      <input
        className="question-other"
        type="text"
        value={value.other}
        placeholder={t('question.otherPlaceholder')}
        aria-label={`${t('question.other')}: ${q.question}`}
        spellCheck={false}
        // For a single choice, typing replaces the picked option; for several, the text is added to them.
        onChange={(e) => onChange({ labels: q.multiSelect || !e.target.value.trim() ? value.labels : [], other: e.target.value })}
      />
    </div>
  );
}

/** The card for an AskUserQuestion call: the user answers here, the model gets the answers instead of "did not answer". */
export function QuestionCard({ request }: { request: PermissionRequest }) {
  const questions = useMemo(() => parseQuestions(request.input) ?? [], [request.input]);
  const [selections, setSelections] = useState<Selection[]>(() => questions.map(() => ({ labels: [], other: '' })));
  const [sending, setSending] = useState(false);
  const answers = buildAnswers(questions, selections);
  const send = () => {
    if (!answers || sending) return;
    setSending(true);
    // The card goes away when the app resolves the request; if the answers were refused, let the user try again.
    api()
      .answerQuestion(request.requestId, answers)
      .then((ok) => {
        if (!ok) setSending(false);
      })
      .catch(() => setSending(false));
  };
  return (
    <div className="card question">
      <div className="card-title question-title">{t('question.title')}</div>
      {questions.map((q, i) => (
        <QuestionBlock key={q.question} q={q} index={i} value={selections[i]} onChange={(next) => setSelections((all) => all.map((s, j) => (j === i ? next : s)))} />
      ))}
      <div className="row question-footer">
        <Button variant="you" small disabled={!answers || sending} onClick={send}>
          {t('question.send')}
        </Button>
        <Button small onClick={() => void api().respondPermission(request.requestId, 'deny')}>
          {t('question.skip')}
        </Button>
      </div>
    </div>
  );
}
