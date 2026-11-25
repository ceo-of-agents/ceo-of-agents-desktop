// Claude Code's AskUserQuestion tool: parsing its input and building the answers. Pure: no Electron or React.
// Checked with Claude Code 2.1.328: input is { questions: [{ question, header, options: [{ label, description, preview? }], multiSelect }] },
// and the answer goes back as { behavior: 'allow', updatedInput: { ...input, answers: { '<question text>': '<value>' } } }.

export const ASK_USER_QUESTION = 'AskUserQuestion';

export interface QuestionOption {
  label: string;
  description: string;
  /** Plain text only; present only when the host asked for previews, so normally absent. */
  preview?: string;
}

export interface Question {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

/** What the user picked for one question: the option labels and the free text of "Other". */
export interface Selection {
  labels: string[];
  other: string;
}

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 8;

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** The validated questions of an AskUserQuestion input, or null when the shape is wrong (the app then shows the normal permission card). */
export function parseQuestions(input: unknown): Question[] | null {
  const list = obj(input)?.questions;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_QUESTIONS) return null;
  const out: Question[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const q = obj(raw);
    if (!q || typeof q.question !== 'string' || !q.question.trim()) return null;
    if (seen.has(q.question)) return null; // the answers are keyed by the question text
    seen.add(q.question);
    if (q.header !== undefined && typeof q.header !== 'string') return null;
    if (q.multiSelect !== undefined && typeof q.multiSelect !== 'boolean') return null;
    if (!Array.isArray(q.options) || q.options.length < 1 || q.options.length > MAX_OPTIONS) return null;
    const options: QuestionOption[] = [];
    const labels = new Set<string>();
    for (const rawOpt of q.options) {
      const o = obj(rawOpt);
      if (!o || typeof o.label !== 'string' || !o.label.trim()) return null;
      if (labels.has(o.label)) return null;
      labels.add(o.label);
      if (o.description !== undefined && typeof o.description !== 'string') return null;
      if (o.preview !== undefined && typeof o.preview !== 'string') return null;
      const opt: QuestionOption = { label: o.label, description: typeof o.description === 'string' ? o.description : '' };
      if (typeof o.preview === 'string' && o.preview) opt.preview = o.preview;
      options.push(opt);
    }
    out.push({ question: q.question, header: typeof q.header === 'string' ? q.header : '', multiSelect: q.multiSelect === true, options });
  }
  return out;
}

const RECOMMENDED = /\s*\(recommended\)\s*$/i;

/** True when the label ends with "(Recommended)", the marker Claude Code puts on the option it suggests. */
export function isRecommended(label: string): boolean {
  return RECOMMENDED.test(label);
}

/** The label without a trailing "(Recommended)". */
export function displayLabel(label: string): string {
  const shown = label.replace(RECOMMENDED, '').trim();
  return shown || label;
}

/**
 * The answers, keyed by question text, or null when a question has no answer yet. Single choice: the trimmed "Other" text when
 * there is one, else the chosen label. Multi-select: the chosen labels in option order, then the "Other" text, joined with ", ".
 * The value is always the label as Claude Code sent it (with "(Recommended)", if any), so the model sees its own words.
 */
export function buildAnswers(questions: Question[], selections: Selection[]): Record<string, string> | null {
  const entries: Array<[string, string]> = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const s = selections[i];
    if (!s) return null;
    const other = s.other.trim();
    const chosen = q.options.map((o) => o.label).filter((l) => s.labels.includes(l));
    let value: string;
    if (q.multiSelect) value = [...chosen, ...(other ? [other] : [])].join(', ');
    else value = other || chosen[0] || '';
    if (!value) return null;
    entries.push([q.question, value]);
  }
  return Object.fromEntries(entries); // own keys, even for a question text like "__proto__"
}

/** True for a permission request the app shows as a question card: an AskUserQuestion call whose input parses. */
export function isQuestionRequest(r: { toolName: string; input: unknown }): boolean {
  return r.toolName === ASK_USER_QUESTION && parseQuestions(r.input) !== null;
}
