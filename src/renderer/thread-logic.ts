// Pure helpers of the thread view: grouping, step normalizing, clocks, the reply message, the composer hint counter.
import type { ActivityStep, CommandRun, ThreadEntry } from '../shared/types';
import { t } from '../shared/strings';
import type { ThreadRow } from './logic';

// ---------- clocks ----------

/** m:ss, for example 0:42 or 12:05. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** A step's duration; empty under a second (a "0:00" says nothing). */
export function stepDuration(ms: number | undefined): string {
  return ms === undefined || ms < 1000 ? '' : clock(ms);
}

/** The label of the "New session" divider, from the time of its entry. */
export function sessionDividerLabel(entry: Pick<ThreadEntry, 'time' | 'continued'>): string {
  return t(entry.continued ? 'thread.newSessionContinued' : 'thread.newSession', { time: clockTime(entry.time) });
}

/** Time of day of an ISO time, for the name line of a message. */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// ---------- turn activity ----------

/** Steps of an activity entry as objects; older logs hold plain strings. */
export function normalizeSteps(steps: ThreadEntry['steps']): ActivityStep[] {
  return (steps ?? []).map((s) => (typeof s === 'string' ? { text: s } : s));
}

/** "1 step · 0:42" or "6 steps · 0:42"; older entries without a duration keep the text stored with them. */
export function activitySummary(entry: ThreadEntry): string {
  const count = normalizeSteps(entry.steps).length;
  if (count === 0 || entry.durationMs === undefined) return entry.text;
  return t(count === 1 ? 'activity.summaryOne' : 'activity.summary', { count, time: clock(entry.durationMs) });
}

// ---------- rows and grouping ----------

export type GroupedRow =
  | Exclude<ThreadRow, { type: 'entry' }>
  /**
   * `first`: the first message of its group (shows the name line); `gap`: 20 px before it (`new`) or 6 px (`same`).
   * `activity`: the activity summary of the turn that wrote this message, shown between its name line and its text.
   */
  | { type: 'entry'; entry: ThreadEntry; first: boolean; gap: 'new' | 'same'; activity?: ThreadEntry };

function authorKey(entry: ThreadEntry): string | null {
  if (entry.kind === 'user') return 'user';
  if (entry.kind === 'assistant') return `assistant:${entry.author}`;
  return null;
}

/**
 * Marks consecutive messages of one author: only the first shows the name and the others sit closer. Any other row ends a group.
 * An activity summary joins the assistant message right after it (name line, activity, text, in one place per turn) and
 * always opens a group; one with no message after it (a turn that only failed) stands alone and shows the name line itself.
 */
export function groupRows(rows: ThreadRow[]): GroupedRow[] {
  let last: string | null = null;
  const out: GroupedRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.type !== 'entry') {
      last = null;
      out.push(r);
      continue;
    }
    if (r.entry.kind === 'activity') {
      const next = rows[i + 1];
      last = null;
      if (next && next.type === 'entry' && next.entry.kind === 'assistant') {
        out.push({ type: 'entry', entry: next.entry, first: true, gap: 'new', activity: r.entry });
        last = authorKey(next.entry);
        i++;
      } else {
        out.push({ type: 'entry', entry: r.entry, first: true, gap: 'new' });
      }
      continue;
    }
    const key = authorKey(r.entry);
    const same = key !== null && key === last;
    last = key;
    out.push({ type: 'entry', entry: r.entry, first: !same, gap: same ? 'same' : 'new' });
  }
  return out;
}

/**
 * A draft that starts with "!" is a command the user runs in the hq folder (like Claude Code's bash mode): the text
 * after the "!", trimmed. Null for any other draft.
 */
export function commandOf(draft: string): string | null {
  const s = draft.trimStart();
  return s.startsWith('!') ? s.slice(1).trim() : null;
}

/** The status line of a command entry. */
export function commandStatus(run: CommandRun): string {
  if (run.outcome === 'failed') return t('command.outcome.failed', { code: run.exitCode ?? '?' });
  if (run.outcome === 'error') return t('command.outcome.error', { error: run.error ?? '' });
  return t(`command.outcome.${run.outcome}`);
}

/** The text of the last message the user sent, for "Try again". */
export function lastUserText(entries: ThreadEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    // A message with images or files is not offered for "Try again": the app does not keep the bytes in the renderer, so a resend would drop them.
    if (e.kind === 'user') return e.images?.length || e.files?.length ? null : e.text;
  }
  return null;
}

/**
 * An error row with a way forward: "Ask {persona} to write it" when the entry says so (`action: 'askNote'`: a hand-over found
 * no note), "Try again" (resend) for a failed turn, "Start again" when the process stopped.
 */
export function errorAction(entry: ThreadEntry, canRetry: boolean): 'retry' | 'start' | 'askNote' | null {
  if (entry.action === 'askNote') return 'askNote';
  if (entry.text === t('thread.processExited')) return 'start';
  return canRetry ? 'retry' : null;
}

/**
 * The reason of an error plate as one full sentence: trimmed, first letter capital, a full stop at the end when it
 * has no closing mark (. ! ? or an ellipsis).
 */
export function errorReason(text: string): string {
  const s = text.trim();
  if (!s) return s;
  const cap = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?…]$/.test(cap) ? cap : `${cap}.`;
}

/** Process exited: it comes as a system line in older logs and as an error line now. */
export function isProcessExited(entry: ThreadEntry): boolean {
  return (entry.kind === 'system' || entry.kind === 'error') && entry.text === t('thread.processExited');
}

// ---------- items that leave with an animation ----------

export interface Leaving<T> {
  item: T;
  leaving: boolean;
}

/** Keeps items that left the list (marked `leaving`) so they can animate out; new items go at the end. */
export function mergeLeaving<T>(prev: Leaving<T>[], items: T[], keyOf: (item: T) => string): Leaving<T>[] {
  const live = new Map(items.map((i) => [keyOf(i), i]));
  const known = new Set(prev.map((p) => keyOf(p.item)));
  const next = prev.map((p) => (live.has(keyOf(p.item)) ? { item: live.get(keyOf(p.item))!, leaving: false } : { ...p, leaving: true }));
  for (const i of items) if (!known.has(keyOf(i))) next.push({ item: i, leaving: false });
  return next;
}

// ---------- the reply target ----------

export interface ReplyTarget {
  /** The item's code; null for a waiting line the app could not parse (the target is then the raw line). */
  code: string | null;
  text: string;
}

/** The message sent for a reply: "<code> (<item text>): <message>"; with no item text, "<code>: <message>"; with no code (an unparsed line), `About "<line>": <message>`. */
export function replyMessage(target: ReplyTarget, message: string, max = 200): string {
  const flat = target.text.replace(/\s+/g, ' ').trim();
  const cut = flat.length > max ? `${flat.slice(0, max).trimEnd()}...` : flat;
  if (target.code === null) return t('cos.msg.replyUnparsed', { text: cut, message });
  if (!flat) return t('cos.msg.answerPrefix', { code: target.code }) + message;
  return t('cos.msg.reply', { code: target.code, text: cut, message });
}

// ---------- composer hint ----------

export const HINT_KEY = 'coa.sentCount';
export const HINT_AFTER = 3;

type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** How many messages the user has sent, kept in localStorage (0 when it is unavailable). */
export function readSentCount(store: Store | null): number {
  try {
    const n = Number.parseInt(store?.getItem(HINT_KEY) ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Counts one more sent message and returns the new count. */
export function bumpSentCount(store: Store | null): number {
  const n = readSentCount(store) + 1;
  try {
    store?.setItem(HINT_KEY, String(n));
  } catch {
    // unavailable storage: the hint just keeps showing
  }
  return n;
}

/** The "Enter to send" hint shows until the user has sent three messages. */
export const showHint = (sent: number): boolean => sent < HINT_AFTER;
