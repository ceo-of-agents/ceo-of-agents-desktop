// Pure logic of the "Create a new org" frame: what each step of the list looks like, where Next and Back go,
// when answers exist (the discard confirm) and which step the full check finds wrong first. No question wording here.
import type { SetupData } from '../shared/setup';
import { emptyDraft, stepsFor, validateStep, type Draft, type StepId } from './create-org-logic';

export type StepState = 'current' | 'done' | 'attention' | 'todo';

/** The look of a row in the step list: the current step first, then needs attention, then done (a step that passed Next), else not visited. */
export function stepState(step: StepId, current: StepId, done: readonly StepId[], attention: readonly StepId[]): StepState {
  if (step === current) return 'current';
  if (attention.includes(step)) return 'attention';
  return done.includes(step) ? 'done' : 'todo';
}

/** A row can be opened when it is current, done, needs attention or was visited (left with Back); a step not visited yet cannot. */
export const stepClickable = (state: StepState, visited: boolean): boolean => state !== 'todo' || visited;

export function nextStep(steps: readonly StepId[], current: StepId): StepId | null {
  const i = steps.indexOf(current);
  return i >= 0 && i < steps.length - 1 ? steps[i + 1] : null;
}

export function prevStep(steps: readonly StepId[], current: StepId): StepId | null {
  const i = steps.indexOf(current);
  return i > 0 ? steps[i - 1] : null;
}

/** 1-based position of a step in the listed steps; 0 when it is not listed. */
export const stepNumber = (steps: readonly StepId[], step: StepId): number => steps.indexOf(step) + 1;

/** True once at least one answer exists (any change from the blank draft): Close then asks before discarding. */
export function hasAnswers(d: Draft): boolean {
  return JSON.stringify(d) !== JSON.stringify(emptyDraft());
}

/** The first listed step (before Summary and Folder) whose answers do not validate, with its errors; null when all pass. */
export function firstInvalid(d: Draft, data: SetupData): { step: StepId; errors: Record<string, string> } | null {
  for (const step of stepsFor(d)) {
    if (step === 'summary' || step === 'folder') continue;
    const errors = validateStep(step, d, data);
    if (Object.keys(errors).length > 0) return { step, errors };
  }
  return null;
}

/** Steps that are still listed (a purpose change can remove one, for example Policy). */
export const keepListed = (list: readonly StepId[], steps: readonly StepId[]): StepId[] => list.filter((s) => steps.includes(s));

/** The footer's primary label: "Back to summary" while an Edit from the summary is open, else Next (Choose a folder on the summary, Create org on the folder). */
export function nextLabelKey(step: StepId, fromSummary: boolean): string {
  if (fromSummary && step !== 'summary' && step !== 'folder') return 'createOrg.backToSummary';
  if (step === 'summary') return 'createOrg.chooseFolder';
  if (step === 'folder') return 'createOrg.create';
  return 'createOrg.next';
}

/** The i18n key of a step's navigation label and title. */
export const stepLabelKey = (step: StepId): string => `createOrg.step.${step}`;

/** Up to `max` entries of a folder that is not empty, and how many more there are. */
export function shortList(entries: readonly string[], max = 5): { shown: string[]; more: number } {
  return { shown: entries.slice(0, max), more: Math.max(0, entries.length - max) };
}

/** A field key as a DOM id. */
export const fieldId = (key: string): string => `co-${key.replace(/[^A-Za-z0-9_-]/g, '-')}`;
