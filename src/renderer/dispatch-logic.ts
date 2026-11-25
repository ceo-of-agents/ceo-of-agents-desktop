// Pure logic of the department liveness feature: what a dispatch says in a line, in a node, in a tooltip, and when an
// ended dispatch counts as seen. No DOM, no clock of its own (the caller passes `nowMs`).
import type { Dispatch, DispatchState } from '../shared/types';
import { formatDuration } from '../shared/duration';
import { t, tn } from '../shared/strings';

/** A stable empty list (props and effects compare by reference). */
export const NO_DISPATCHES: Dispatch[] = [];

/** An ended dispatch is shown at least this long before it counts as seen. */
export const ACK_AFTER_MS = 5000;

export const isRunning = (d: Dispatch): boolean => d.state === 'running';
export const isEnded = (d: Dispatch): boolean => d.state === 'done' || d.state === 'failed' || d.state === 'stopped';

const ms = (iso: string | null | undefined): number | null => {
  const n = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** The thread a dispatch was made in: a department chat (`tab:<tabId>`), else the chief of staff's. */
export const threadOfDispatch = (d: Dispatch): string => d.by?.threadId ?? 'cos';

/**
 * The dispatches of one department (never the helpers: their `departmentId` is null): the chief of staff's to it, and
 * the ones made in its own chat (`by`), whatever agent they ran.
 */
export const dispatchesOfDepartment = (list: Dispatch[], departmentId: string): Dispatch[] => list.filter((d) => (d.by ? d.by.departmentId === departmentId : d.departmentId === departmentId));

/** The running helpers of the chief of staff (a dispatch without a department, not made in a department chat). Ended helpers are never shown. */
export const runningHelpers = (list: Dispatch[]): Dispatch[] => list.filter((d) => d.departmentId === null && !d.by && isRunning(d));

/** A department chat has sub-agents running: closing it asks first, like a chat with a turn in flight. */
export const tabHasRunningDispatches = (list: Dispatch[], tabId: string): boolean => list.some((d) => d.by?.threadId === `tab:${tabId}` && isRunning(d));

/** What a dispatch shows as its description: a sub-agent of a department chat says which agent runs ("→ worker Fix the CI"). */
const shownDescription = (d: Dispatch): string => {
  const description = d.description.trim();
  return d.by ? [t('dispatch.subAgent', { agent: d.agent }), description].filter(Boolean).join(' ') : description;
};

/** Elapsed time of a dispatch in ms: running ones until now, ended ones until they ended; null for `unknown`. */
export function dispatchElapsedMs(d: Dispatch, nowMs: number): number | null {
  if (d.state === 'unknown') return null;
  const start = ms(d.startedAt) ?? nowMs;
  const end = d.state === 'running' ? nowMs : ms(d.endedAt) ?? ms(d.lastActivityAt) ?? nowMs;
  return Math.max(0, end - start);
}

const durationOf = (d: Dispatch, nowMs: number): string => formatDuration(dispatchElapsedMs(d, nowMs) ?? 0);

const MARK = '\u0001';

/** A dispatch's line in three parts, so a long description can be cut while the state and the time stay whole. */
export interface LineParts {
  before: string;
  description: string;
  after: string;
}

/** "Working: Fix the CI · 2 min 5 s" as parts (description empty: the whole line is `before`). `unknown` has no time. */
export function dispatchLineParts(d: Dispatch, nowMs: number, compact = false): LineParts {
  const state = t(`dispatch.state.${d.state}`);
  const description = shownDescription(d);
  if (d.state === 'unknown') {
    if (!description) return { before: t('dispatch.lineUnknownBare', { state }), description: '', after: '' };
    return split(t('dispatch.lineUnknown', { state, description: MARK }), description);
  }
  const time = durationOf(d, nowMs);
  // The org chart node has room for about 20 characters: a running task drops the word "Working" (the pulsing dot and the ticking time say it; the accessible name keeps the word).
  if (compact && d.state === 'running' && description) return split(t('dispatch.node.running', { description: MARK, time }), description);
  if (!description) return { before: t('dispatch.lineBare', { state, time }), description: '', after: '' };
  return split(t('dispatch.line', { state, description: MARK, time }), description);
}

function split(line: string, description: string): LineParts {
  const i = line.indexOf(MARK);
  return { before: line.slice(0, i), description, after: line.slice(i + 1) };
}

/** One dispatch as one plain line. */
export function dispatchText(d: Dispatch, nowMs: number): string {
  const p = dispatchLineParts(d, nowMs);
  return p.before + p.description + p.after;
}

/** One dispatch without its time ("Working: Fix the CI"), for accessible names (they must not change every second). */
export function dispatchWords(d: Dispatch): string {
  const state = t(`dispatch.state.${d.state}`);
  const description = shownDescription(d);
  return description ? t('dispatch.lineUnknown', { state, description }) : t('dispatch.lineUnknownBare', { state });
}

/** What a node shows in its one status line. `state` picks the mark. */
export interface NodeDispatch {
  state: DispatchState;
  parts: LineParts;
  /** The same without times, for the accessible name. */
  words: string;
}

const lastSign = (d: Dispatch): number => ms(d.endedAt) ?? ms(d.lastActivityAt) ?? ms(d.startedAt) ?? 0;

/** "2 tasks working · 1 min" as parts: the count words are the part that is cut, the time stays whole. */
function countParts(words: string, line: string): LineParts {
  return line.startsWith(words) ? { before: '', description: words, after: line.slice(words.length) } : { before: line, description: '', after: '' };
}

const oldestStart = (list: Dispatch[], nowMs: number): number => Math.min(...list.map((d) => ms(d.startedAt) ?? nowMs));

/**
 * The line of a department node. Two or more running: "2 tasks working · 1 min" (oldest start). One running: its line.
 * None running: the newest ended (or unknown) one; the tooltip lists them all. Empty list: null.
 */
export function departmentNodeDispatch(list: Dispatch[], nowMs: number): NodeDispatch | null {
  if (list.length === 0) return null;
  const running = list.filter(isRunning);
  if (running.length >= 2) {
    const time = formatDuration(nowMs - oldestStart(running, nowMs));
    const words = tn('dispatch.manyName', running.length);
    return { state: 'running', parts: countParts(words, tn('dispatch.many', running.length, { time })), words };
  }
  const one = running[0] ?? [...list].sort((a, b) => lastSign(b) - lastSign(a))[0];
  return { state: one.state, parts: dispatchLineParts(one, nowMs, true), words: dispatchWords(one) };
}

/** The line of the CoS node for helpers (only running ones count): "1 helper working · 20 s". Null when none. */
export function helpersNodeDispatch(list: Dispatch[], nowMs: number): NodeDispatch | null {
  const running = runningHelpers(list);
  if (running.length === 0) return null;
  const time = formatDuration(nowMs - oldestStart(running, nowMs));
  const words = tn('dispatch.helpersName', running.length);
  return { state: 'running', parts: countParts(words, tn('dispatch.helpers', running.length, { time })), words };
}

/** Every dispatch as a tooltip line, oldest first; helpers are named (a department's tooltip is already its own). */
export function dispatchTipLines(list: Dispatch[], nowMs: number, named: boolean): string[] {
  return [...list]
    .sort((a, b) => (ms(a.startedAt) ?? 0) - (ms(b.startedAt) ?? 0))
    .map((d) => (named ? `${d.name}: ${dispatchText(d, nowMs)}` : dispatchText(d, nowMs)));
}

/** The tooltip of one dispatch's line: `unknown` explains itself, a running one says when it last showed a sign of work. */
export function dispatchTip(d: Dispatch, nowMs: number, cosName: string): string {
  if (d.state === 'unknown') return t('dispatch.state.unknown.tip', { cosName });
  if (d.state !== 'running') return '';
  const last = ms(d.lastActivityAt);
  return last === null ? '' : t('dispatch.lastActivity', { time: formatDuration(nowMs - last) });
}

// ---------- the "seen" rule ----------

export interface AckContext {
  /** The thread the main area shows (`cos` or `tab:<tabId>`); null when it shows none (the chart, a blocked org). Only that thread's dispatches count as seen. */
  visibleThread: string | null;
  /** The window has focus and is not hidden. */
  windowFocused: boolean;
  /** The visible thread's turn is running (its report is not finished). */
  threadBusy: boolean;
  /** A background agent's report has not arrived yet in the visible thread: ended dispatches wait for it, at most REPORT_WAIT_MS after their end. */
  reportPending?: boolean;
  nowMs: number;
  /** When the renderer first saw each dispatch id (ms). Used for `unknown`, which has no end time. */
  firstSeen?: ReadonlyMap<string, number>;
}

/**
 * When an ended dispatch counts as seen (ms): 5 s after it ended; an `unknown` one 5 s after it first appeared in the
 * renderer (so the user can read it, and its tooltip, before it goes). Running ones never.
 */
/** The longest an ended dispatch waits for a report that is still pending (the main process gives one up after 2 min of silence too). */
export const REPORT_WAIT_MS = 120_000;

function ackAt(d: Dispatch, ctx: AckContext): number | null {
  if (isRunning(d)) return null;
  const from = d.state === 'unknown' ? (ctx.firstSeen?.get(d.id) ?? ctx.nowMs) : (ms(d.endedAt) ?? ms(d.lastActivityAt) ?? ctx.nowMs);
  return from + (ctx.reportPending ? REPORT_WAIT_MS : ACK_AFTER_MS);
}

const conditionsHold = (c: AckContext): boolean => c.visibleThread !== null && c.windowFocused && !c.threadBusy;

/**
 * The ids to ack now: every ended or `unknown` dispatch made in the visible thread (the chief of staff's, or the
 * department chat that is shown), when the window has focus, the thread is not busy and the dispatch is old enough
 * (see `ackAt`). Running ones are never acked.
 */
export function dispatchesToAck(list: Dispatch[], ctx: AckContext): string[] {
  if (!conditionsHold(ctx)) return [];
  return list.filter((d) => {
    if (threadOfDispatch(d) !== ctx.visibleThread) return false;
    const at = ackAt(d, ctx);
    return at !== null && at <= ctx.nowMs;
  }).map((d) => d.id);
}

/** Ms until the next dispatch becomes old enough, when the other conditions hold; null when nothing is waiting for time. */
export function nextAckDelayMs(list: Dispatch[], ctx: AckContext): number | null {
  if (!conditionsHold(ctx)) return null;
  let min: number | null = null;
  for (const d of list) {
    if (threadOfDispatch(d) !== ctx.visibleThread) continue;
    const at = ackAt(d, ctx);
    if (at !== null && at > ctx.nowMs && (min === null || at - ctx.nowMs < min)) min = at - ctx.nowMs;
  }
  return min;
}

/**
 * Updates what the renderer remembers per dispatch id (`firstSeen`, `acked`) to the current list: ids that left the list
 * are forgotten, and so is a dispatch that is running (it may have ended before and was revived by a SendMessage: its next
 * end is acked on the normal timing, not by a stale entry). Every other new id gets its first-seen time.
 */
export function syncAckMemory(list: Dispatch[], firstSeen: Map<string, number>, acked: Set<string>, nowMs: number): void {
  const ids = new Set(list.map((d) => d.id));
  for (const id of [...acked]) if (!ids.has(id)) acked.delete(id);
  for (const id of [...firstSeen.keys()]) if (!ids.has(id)) firstSeen.delete(id);
  for (const d of list) {
    if (isRunning(d)) {
      acked.delete(d.id);
      firstSeen.delete(d.id);
    } else if (!firstSeen.has(d.id)) firstSeen.set(d.id, nowMs);
  }
}
