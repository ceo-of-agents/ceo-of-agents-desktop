// Pure logic of the running, done and error screens of "Create a new org". The wizard prints no structured progress and
// its questions cannot be parsed, so everything here reads only the folder facts (SetupState) and the wizard's own words.
import type { SetupFacts, SetupState } from '../shared/setup';
import type { ThreadInfo } from '../shared/types';
import { QUESTION_KEYS, type StepId } from './create-org-logic';

export type RunPhase = 'working' | 'asking' | 'done' | 'failed';

/** The text of the latest assistant message of the run, or null. */
export function lastAssistantText(thread: ThreadInfo | undefined): string | null {
  if (!thread) return null;
  for (let i = thread.entries.length - 1; i >= 0; i--) if (thread.entries[i].kind === 'assistant') return thread.entries[i].text;
  return null;
}

/** True when the wizard's message ends by asking something: its last line ends with a question mark (markdown marks and brackets after it ignored) or a (y/n) hint. */
export function looksLikeQuestion(text: string | null): boolean {
  if (!text) return false;
  const line = text.trim().split(/\r?\n/).filter((l) => l.trim() !== '').pop() ?? '';
  const trimmed = line.trim().replace(/[*_`\s]+$/u, '');
  if (/[([](y\/n|yes\/no)[)\]]$/i.test(trimmed)) return true;
  return trimmed.replace(/[")'\]\s]+$/u, '').endsWith('?');
}

/**
 * True when the folder shows the wizard finished writing: the three files it writes last (state.md, the setup decision record and
 * .claude/settings.json) are there, or the first commit exists. A wizard turn that ended without a question is no proof of that.
 */
export function setupComplete(f: SetupFacts): boolean {
  return (f.state && f.decisionRecord && f.settings) || f.commit !== null;
}

/**
 * Which screen of the run to show. The org counts as created only when the folder facts show completion (`setupComplete`) and the
 * wizard's turn ended without an error and without a question. Otherwise, when the wizard is idle and said something, its message is
 * shown with a reply box: a question the app cannot read must never be lost.
 */
export function runPhase(s: SetupState | null, last: string | null): RunPhase {
  if (!s) return 'working';
  if (s.error) return 'failed';
  if (s.busy) return 'working';
  if (s.hqReady && setupComplete(s.facts) && !looksLikeQuestion(last)) return 'done';
  if (!s.hqReady && s.exited) return 'failed';
  return last ? 'asking' : 'working';
}

/** True when the wizard's message is about a folder that is not empty (its Step 0). A "Yes" must never be one click away there. */
export function mentionsNonEmptyFolder(text: string | null): boolean {
  if (!text) return false;
  return /\b(non-?empty|not empty|isn['\u2019]?t empty|not an empty|already (?:has|have|contains?|holds?)|anything other than|overwrit\w*)\b|non (?:\u00e8 )?vuot|n['\u2019]?est pas vide|pas vide|nicht leer|no est\u00e1 vac|n\u00e3o est\u00e1 vazi/i.test(text);
}

/** The command that runs the wizard by hand on the answers file (the terminal fallback of the Failed screen). */
export const initFleetCommand = (answersFile: string): string => `/ceo-of-agents:init-fleet ${answersFile}`;

/**
 * The step a problem the wizard reports belongs to: the first schema key it names (`departments[0].id`, `org.id`) that one of the
 * listed steps asks. A key with no question of its own matches its longest known prefix (`departments.id` is `departments`).
 */
export function problemStep(text: string, steps: readonly StepId[]): StepId | null {
  for (const token of text.match(/[A-Za-z_][A-Za-z0-9_]*(?:\[\d+\])?(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\[\d+\])?)+/g) ?? []) {
    const parts = token.replace(/\[\d+\]/g, '').split('.');
    for (let n = parts.length; n >= 1; n--) {
      const key = parts.slice(0, n).join('.');
      const step = steps.find((st) => st !== 'folder' && QUESTION_KEYS[st].includes(key));
      if (step) return step;
    }
  }
  return null;
}

export interface Milestone {
  id: 'orgYaml' | 'decisionRecord' | 'state' | 'settings';
  done: boolean;
}

/** The files whose appearance in the folder ticks a line of the check list. Nothing else ticks. */
export function milestones(f: SetupFacts): Milestone[] {
  return [
    { id: 'orgYaml', done: f.orgYaml },
    { id: 'decisionRecord', done: f.decisionRecord },
    { id: 'state', done: f.state },
    { id: 'settings', done: f.settings },
  ];
}

/** True while the folder still holds none of what the wizard writes: "Try again" is allowed only then. */
export function folderUntouched(f: SetupFacts): boolean {
  return !f.orgYaml && !f.decisionRecord && !f.state && !f.settings && f.commit === null;
}

/** m:ss, or h:mm:ss from an hour. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** The line shown in the live region, at most one update per `ms`: a new line waits until the interval since the last shown one has passed. */
export interface Throttled {
  shown: string;
  /** When `shown` was set. */
  at: number;
}

export function throttleStep(prev: Throttled, incoming: string, now: number, ms: number): { next: Throttled; waitMs: number } {
  if (incoming === prev.shown) return { next: prev, waitMs: 0 };
  const wait = prev.at + ms - now;
  if (prev.shown === '' || wait <= 0) return { next: { shown: incoming, at: now }, waitMs: 0 };
  return { next: prev, waitMs: wait };
}

/** The steps of the wizard's run for "Show details": its short tool lines and the steps of its finished turns, in order. */
export function runSteps(thread: ThreadInfo | undefined): string[] {
  if (!thread) return [];
  const out: string[] = [];
  for (const e of thread.entries) {
    if (e.kind === 'tool' && e.text) out.push(e.text);
    else if (e.kind === 'activity') for (const s of e.steps ?? []) out.push(typeof s === 'string' ? s : s.text);
  }
  return out;
}

/** The command that installs the plugin for the new folder (shown when the run left it not installed). */
export const INSTALL_COMMAND = 'claude plugin install ceo-of-agents@ceo-of-agents --scope project';
