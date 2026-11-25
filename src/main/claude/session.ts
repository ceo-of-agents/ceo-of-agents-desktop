import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { spawnProcess, type Spawner } from '../system/exec';
import { StreamParser, type ClaudeEvent } from './stream';
import type { DocumentAttachment, ImageAttachment } from '../../shared/types';
import type { RateLimitInfo } from '../../shared/usage';

export interface ClaudeSessionOptions {
  claudePath: string;
  cwd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  spawner?: Spawner;
  /** How long a held result waits, with the stream silent, before it counts as the message's own (ms, default `HOLD_MS`). */
  holdMs?: number;
  /** How long a pending report waits with no stream event before it is given up (ms, default `REPORT_IDLE_MS`). */
  reportIdleMs?: number;
  /** How long a message with no lifecycle state waits, with the stream silent, after a turn end that did not name it before it counts as answered (ms, default `ABSORBED_MS`). */
  absorbedMs?: number;
}

export interface TurnEnd {
  text: string;
  isError: boolean;
  resultText: string;
  /** The messages (their uuids, in write order) this turn end answers: one, or several when Claude Code absorbed them into one turn. */
  uuids: string[];
  /** The turn failed on a usage limit (HTTP 429, or the last `rate_limit_event` said `rejected`). Absent otherwise. */
  limit?: LimitStop;
}

/** Which limit stopped a turn and when it resets (each null when Claude Code did not say). */
export interface LimitStop {
  limitType: string | null;
  resetsAt: string | null;
}

/** The limit a failed result ran into, or null when it is another error. */
export function limitStop(apiErrorStatus: number | null, info: RateLimitInfo | null): LimitStop | null {
  const rejected = info?.status === 'rejected';
  if (apiErrorStatus !== 429 && !rejected) return null;
  if (!info) return { limitType: null, resetsAt: null };
  const w = info.windows.find((x) => x.status === 'rejected') ?? info.windows.find((x) => x.key === info.limitType);
  return { limitType: info.limitType ?? w?.key ?? null, resetsAt: info.resetsAt ?? w?.resetsAt ?? null };
}

/**
 * A reply in a turn Claude Code started on its own, not for a message the app wrote: a background task or agent
 * finished (`task_notification`), or a notice left over from the previous process on `--resume`. Its `result` does
 * not end the app's turn.
 */
export interface Aside {
  text: string;
}

/**
 * A result that may not be the message's own (it arrived while the message was still `queued`, or it is an empty
 * result of no model call, `num_turns` 0) is held until the stream decides: `started` (it was a turn of Claude Code's
 * own: an aside), `completed` (it was the message's), a later result, or, for an empty one, any sign of the model
 * working (then it is dropped). Only when the stream stays silent this long after it, and the message is not
 * `started`, does it count as the message's, so a message never stays busy for ever.
 */
export const HOLD_MS = 5000;

/**
 * Older Claude Code may absorb a message into a running turn without any `command_lifecycle` event. After a result that
 * (by the no-lifecycle fallback) ends only the oldest message, the others with no state stay pending; if the stream is
 * silent for this long (and no turn is open) they are answered with an empty turn end (no text, not an error: the
 * thread shows its "no reply" line), so nothing stays busy for ever.
 */
export const ABSORBED_MS = 15_000;

/** A pending report with no stream event at all for this long is given up (ms). */
export const REPORT_IDLE_MS = 120_000;

/** Final statuses of a background agent after which Claude Code reports on it. */
const REPORTED_STATUSES = new Set(['completed', 'failed', 'error']);

/**
 * The content of a user message: the plain text when there are no images and no documents, else the document blocks
 * (PDFs), the image blocks, then the text block (left out when the text is empty).
 */
export function userContent(text: string, images?: ImageAttachment[], documents?: DocumentAttachment[]): string | Array<Record<string, unknown>> {
  if ((!images || images.length === 0) && (!documents || documents.length === 0)) return text;
  const blocks: Array<Record<string, unknown>> = (documents ?? []).map((doc) => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: doc.data }, title: doc.title }));
  for (const img of images ?? []) blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
  if (text) blocks.push({ type: 'text', text });
  return blocks;
}

/** One line of Claude Code's stream-json input (the uuid comes back in `command_lifecycle` events). */
export function userLine(text: string, images?: ImageAttachment[], uuid?: string, documents?: DocumentAttachment[]): string {
  return JSON.stringify({ type: 'user', ...(uuid ? { uuid } : {}), message: { role: 'user', content: userContent(text, images, documents) } }) + '\n';
}

/** How long after SIGTERM a process that is still alive gets SIGKILL. */
const KILL_AFTER_MS = 4000;

/** Signals the child's whole process group (the child is spawned detached, so its pid is the group id); falls back to the child alone. */
function killGroup(child: ChildProcess, sig: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid && pid > 1) {
    try {
      process.kill(-pid, sig);
      return;
    } catch {
      // no such group (already gone) or not allowed: signal the child itself
    }
  }
  try {
    child.kill(sig);
  } catch {
    // already gone
  }
}

/** One long-lived claude process. Every message is written at once; Claude Code absorbs it into the running turn or gives it a turn of its own. */
export class ClaudeSession extends EventEmitter {
  private child: ChildProcess | null = null;
  private parser = new StreamParser();
  private _sessionId: string | null = null;
  private _model: string | null = null;
  /** The last `rate_limit_event` of this process. */
  private lastLimit: RateLimitInfo | null = null;
  private _lastStderr = '';
  private args: string[];
  private deltas: string[] = [];
  /** A tool ran since the last text: the next text starts a new paragraph. */
  private needSep = false;
  private blocks: string[] = [];
  /**
   * The messages written and not answered yet, in write order: each one's uuid (sent with it) and the last
   * `command_lifecycle` state seen for it (`queued`, `started`, `completed`; null before any).
   */
  private pending: Array<{ uuid: string; state: string | null }> = [];
  /** A result not yet known to be the message's own or an aside (see `HOLD_MS`). */
  private held: { text: string; isError: boolean; resultText: string; limit?: LimitStop; empty: boolean; seq: number; timer: ReturnType<typeof setTimeout> } | null = null;
  /** Counts stream events, so the hold can tell whether anything happened since it began. */
  private seq = 0;
  /** A turn is running on the stream: an init arrived after the last result. */
  private turnOpen = false;
  /**
   * Background agents whose report has not ended yet, by task id, oldest first. `folded`: the notification came while
   * our own message's turn ran (or that turn started after it), so that turn's end carries the report. `ends`: turns
   * that ended since the notification without carrying it. A report never outlives the second such turn end, and at
   * an init only the oldest waiting one survives once a turn has ended without it (see `turnEndedFor`, `initFor`).
   */
  private readonly reports = new Map<string, { folded: boolean; ends: number }>();
  /** Clears `reports` after REPORT_IDLE_MS without any stream event: a report that never comes must not count for ever. */
  private reportTimer: ReturnType<typeof setTimeout> | null = null;
  /** Answers the messages that never got a lifecycle state after a fallback turn end (see `ABSORBED_MS`). */
  private absorbedTimer: ReturnType<typeof setTimeout> | null = null;
  private exitWaiters: Array<() => void> = [];
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly o: ClaudeSessionOptions) {
    super();
    this.args = o.args;
  }

  get busy(): boolean {
    return this.pending.length > 0;
  }
  /** The last lifecycle state of a pending message (null: none seen yet); undefined when the message is not pending. */
  stateOf(uuid: string): string | null | undefined {
    return this.pending.find((p) => p.uuid === uuid)?.state;
  }
  get sessionId(): string | null {
    return this._sessionId;
  }
  /** The resolved model id of the latest init message (null before one arrived). */
  get model(): string | null {
    return this._model;
  }
  /**
   * A background agent's notification arrived and the turn that reports on it has not ended yet (an aside, or folded
   * into the turn in flight). Read by the renderer so a finished dispatch is not "seen" before its report.
   */
  get reportPending(): boolean {
    return this.reports.size > 0;
  }
  get running(): boolean {
    return this.child !== null;
  }
  get lastStderr(): string {
    return this._lastStderr;
  }

  setArgs(args: string[]): void {
    this.args = args;
  }

  /** Writes the message to Claude Code at once (the process starts first if there is none) and returns its uuid. */
  send(text: string, images?: ImageAttachment[], documents?: DocumentAttachment[]): string {
    const uuid = randomUUID();
    if (!this.child && !this.spawnChild()) {
      this.emit('turn-end', { text: '', isError: true, resultText: this._lastStderr, uuids: [uuid] } satisfies TurnEnd);
      this.emit('exit', { code: null, duringTurn: false });
      this.emitState();
      return uuid;
    }
    // Text already collected belongs to a turn Claude Code started on its own and is still running: it is kept, and
    // ends as an aside (that turn's result) or in this reply (the message is absorbed into that turn).
    // The uuid comes back in `command_lifecycle` events, which tell this message's turn from one Claude Code starts on its own.
    this.pending.push({ uuid, state: null });
    this.child?.stdin?.write(userLine(text, images, uuid, documents));
    this.emitState();
    return uuid;
  }

  /** Respawn the process if it is not running. */
  restart(): void {
    if (!this.child) this.spawnChild();
    this.emitState();
  }

  idle(): Promise<void> {
    if (this.pending.length === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  /**
   * Ends stdin, then SIGTERM after `graceMs`, then SIGKILL `KILL_AFTER_MS` later if the process is still there.
   * Resolves once the child has exited.
   */
  stop(graceMs = 3000): Promise<void> {
    const child = this.child;
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
      this.exitWaiters.push(resolve);
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => {
        if (this.child !== child) return;
        killGroup(child, 'SIGTERM');
        killTimer = setTimeout(() => {
          if (this.child === child) killGroup(child, 'SIGKILL');
        }, KILL_AFTER_MS);
      }, graceMs);
      this.exitWaiters.push(() => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
      });
      try {
        child.stdin?.end();
      } catch {
        // already closed
      }
    });
  }

  private emitState(): void {
    this.emit('state', { busy: this.busy, pending: this.pending.length });
    if (this.pending.length === 0) {
      const w = this.idleWaiters;
      this.idleWaiters = [];
      w.forEach((r) => r());
    }
  }

  private spawnChild(): boolean {
    const spawner = this.o.spawner ?? spawnProcess;
    let child: ChildProcess;
    try {
      child = spawner(this.o.claudePath, this.args, {
        cwd: this.o.cwd,
        env: this.o.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Its own process group, so stop() can end the tools it started too.
        detached: true,
      });
    } catch (e) {
      this._lastStderr = String(e instanceof Error ? e.message : e).slice(-2048);
      return false;
    }
    this.child = child;
    this.parser = new StreamParser();
    this.resetText();
    this.turnOpen = false;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => this.handleEvents(this.parser.feed(c)));
    child.stdout?.on('end', () => this.handleEvents(this.parser.flush()));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (c: string) => {
      this._lastStderr = (this._lastStderr + c).slice(-2048);
    });
    child.stdin?.on('error', () => {
      // process gone; the exit handler reports it
    });
    let done = false;
    const onGone = (code: number | null) => {
      if (done) return;
      done = true;
      this.handleExit(child, code);
    };
    child.on('error', (e) => {
      this._lastStderr = (this._lastStderr + String(e.message)).slice(-2048);
      onGone(null);
    });
    child.on('close', (code) => onGone(code));
    return true;
  }

  private resetText(): void {
    this.deltas = [];
    this.blocks = [];
    this.needSep = false;
  }

  private collected(): string {
    return this.deltas.length > 0 ? this.deltas.join('') : this.blocks.join('\n\n');
  }

  /** Ends the turn for these messages with this result: they leave `pending` (the others stay). */
  private endTurn(r: Omit<TurnEnd, 'uuids'>, msgs: Array<{ uuid: string }>): void {
    this.dropHeld();
    this.clearAbsorbed();
    // Our turn carried the reports folded into it.
    this.updateReports(() => {
      for (const [id, x] of this.reports) if (x.folded) this.reports.delete(id);
      this.turnEndedFor();
    });
    const uuids = msgs.map((m) => m.uuid);
    this.pending = this.pending.filter((p) => !uuids.includes(p.uuid));
    this.emit('turn-end', { ...r, uuids } satisfies TurnEnd);
    this.emitState();
  }

  /** The messages a result answers: the ones Claude Code started or finished (only the finished ones for an empty result of no model call). */
  private takenBy(noModelCall: boolean): Array<{ uuid: string; state: string | null }> {
    return this.pending.filter((p) => p.state === 'completed' || (!noModelCall && p.state === 'started'));
  }

  /**
   * Every message is still waiting in Claude Code's queue. A message just written has no state until its `queued`
   * arrives, so once lifecycle events are known to flow (some message has a state) null counts as queued; with no
   * state at all (older Claude Code) it does not, and the fallback applies.
   */
  private allQueued(): boolean {
    if (this.pending.length === 0) return false;
    const flowing = this.pending.some((p) => p.state !== null);
    return this.pending.every((p) => p.state === 'queued' || (flowing && p.state === null));
  }

  private clearAbsorbed(): void {
    if (this.absorbedTimer) clearTimeout(this.absorbedTimer);
    this.absorbedTimer = null;
  }

  /** Arms the guard for messages with no lifecycle state that a fallback turn end left pending. */
  private armAbsorbed(): void {
    this.clearAbsorbed();
    if (!this.pending.some((p) => p.state === null)) return;
    const seq = this.seq;
    this.absorbedTimer = setTimeout(() => this.onAbsorbedTimeout(seq), this.o.absorbedMs ?? ABSORBED_MS);
    this.absorbedTimer.unref?.();
  }

  private onAbsorbedTimeout(seq: number): void {
    this.absorbedTimer = null;
    if (this.turnOpen || this.seq !== seq) return this.armAbsorbed(); // activity: wait again
    const msgs = this.pending.filter((p) => p.state === null);
    if (msgs.length === 0) return;
    // Empty text, not an error: the messages were most likely absorbed into the turn that just ended.
    this.endTurn({ text: '', isError: false, resultText: '' }, msgs);
  }

  private dropHeld(): void {
    if (this.held) clearTimeout(this.held.timer);
    this.held = null;
  }

  /** The held result was a turn of Claude Code's own: shown as an aside (when it has text); the message's turn goes on. */
  private releaseHeldAsAside(): void {
    const h = this.held;
    if (!h) return;
    this.dropHeld();
    // Tells the thread that the tool calls seen since the message was written were that turn's, text or not.
    this.emit('own-turn-end');
    this.ownTurnEnded();
    if (h.text) this.emit('aside', { text: h.text } satisfies Aside);
  }

  /** The held result was the messages' own: the turn ends with it, for the started or finished ones, or the oldest when none is (`onlyOldest`: the oldest only, after the hold). */
  private endWithHeld(onlyOldest = false): void {
    const h = this.held;
    if (!h) return;
    const taken = onlyOldest ? [] : this.pending.filter((p) => p.state === 'started' || p.state === 'completed');
    const msgs = taken.length > 0 ? taken : this.pending.slice(0, 1);
    this.endTurn({ text: h.text, isError: h.isError, resultText: h.resultText, ...(h.limit ? { limit: h.limit } : {}) }, msgs);
  }

  /** `empty`: a result of no model call, which any later sign of work cancels. */
  private hold(r: Omit<TurnEnd, 'uuids'>, empty: boolean): void {
    this.releaseHeldAsAside(); // a second unclear result: the first one was not the message's
    const timer = setTimeout(() => this.onHoldTimeout(), this.o.holdMs ?? HOLD_MS);
    timer.unref?.();
    this.held = { ...r, empty, seq: this.seq, timer };
  }

  /**
   * The fallback, so a message never stays busy for ever. The wait goes on (another `holdMs`) while the session is
   * visibly active: a turn is open (an init since the last result: a longer turn of Claude Code's own while the message
   * is still queued), Claude Code said the message started, or anything arrived since the last check. Only after a
   * silent window does the held result become the message's own.
   */
  private onHoldTimeout(): void {
    const h = this.held;
    if (!h) return;
    if (this.turnOpen || this.pending.some((p) => p.state === 'started') || this.seq !== h.seq) {
      h.seq = this.seq;
      h.timer = setTimeout(() => this.onHoldTimeout(), this.o.holdMs ?? HOLD_MS);
      h.timer.unref?.();
      return;
    }
    this.endWithHeld(true);
  }

  /** The model is working on the message: a held empty result (no model call) was not its answer. */
  private cancelEmptyHeld(): void {
    if (this.held?.empty && !this.allQueued()) this.releaseHeldAsAside();
  }

  /** Every message is still waiting in Claude Code's queue (or a result is held): text now belongs to a turn of its own, not streamed. */
  private get waitingInQueue(): boolean {
    return this.held !== null || this.allQueued();
  }

  /** Changes `reports` and tells the thread when `reportPending` flips; (re)arms the idle timer while one is pending. */
  private updateReports(change: () => void): void {
    const before = this.reports.size > 0;
    change();
    const after = this.reports.size > 0;
    if (this.reportTimer) clearTimeout(this.reportTimer);
    this.reportTimer = null;
    if (after) {
      this.reportTimer = setTimeout(() => this.updateReports(() => this.reports.clear()), this.o.reportIdleMs ?? REPORT_IDLE_MS);
      this.reportTimer.unref?.();
    }
    if (before !== after) this.emit('report-pending', after);
  }

  /** A turn Claude Code started on its own ended (with text or not): it was the report on the oldest notification not folded into ours. */
  private ownTurnEnded(): void {
    const first = [...this.reports].find(([, x]) => !x.folded);
    this.updateReports(() => {
      if (first) this.reports.delete(first[0]);
      this.turnEndedFor();
    });
  }

  /** A turn ended (of any kind): the reports it did not carry count it; one that saw two such ends is given up. */
  private turnEndedFor(): void {
    for (const [id, x] of this.reports) if (++x.ends >= 2) this.reports.delete(id);
  }

  /** A turn starts: it can report on the oldest waiting notification only; others that already saw a turn end are given up. */
  private initFor(): void {
    const oldest = [...this.reports].find(([, x]) => !x.folded)?.[0];
    for (const [id, x] of this.reports) if (id !== oldest && !x.folded && x.ends >= 1) this.reports.delete(id);
  }

  private handleEvents(events: ClaudeEvent[]): void {
    for (const ev of events) {
      this.seq++;
      if (this.reports.size > 0) this.updateReports(() => undefined);
      switch (ev.kind) {
        case 'activity':
          this.cancelEmptyHeld();
          break;
        case 'init':
          if (this.reports.size > 0) this.updateReports(() => this.initFor());
          this.turnOpen = true;
          this._sessionId = ev.sessionId;
          if (ev.model) this._model = ev.model;
          this.emit('init', ev.sessionId, ev.model, ev.mcpFailed, ev.mcpServers);
          break;
        case 'text-delta':
          this.cancelEmptyHeld();
          // Between turns the text is kept too (not streamed): a turn Claude Code starts on its own ends as an aside.
          // While the message waits in Claude Code's queue the text is another turn's: kept, not streamed as this reply.
          if (this.needSep && this.deltas.length > 0) {
            this.deltas.push('\n\n');
            if (this.busy && !this.waitingInQueue) this.emit('delta', '\n\n');
          }
          this.needSep = false;
          this.deltas.push(ev.text);
          if (this.busy && !this.waitingInQueue) this.emit('delta', ev.text);
          break;
        case 'assistant-text':
          this.cancelEmptyHeld();
          this.blocks.push(ev.text);
          break;
        case 'sub-activity':
        case 'task-started':
        case 'task-progress':
          this.emit('stream', ev);
          break;
        case 'sub-tool-use':
          if (this.busy) this.emit('sub-tool', ev.name, ev.input);
          break;
        case 'task-ended':
          // Only a background top-level agent that finished (not one stopped) gets a report turn of its own.
          if (ev.notification && ev.topLevel && ev.background && REPORTED_STATUSES.has(ev.status) && this.child && !this.reports.has(ev.taskId)) {
            // Folded only when Claude Code has said our message started: right after a write its state is not known yet.
            const folded = this.busy && this.pending.some((p) => p.state === 'started') && !this.held;
            this.updateReports(() => this.reports.set(ev.taskId, { folded, ends: 0 }));
          }
          this.emit('stream', ev);
          break;
        case 'tool-use':
          this.cancelEmptyHeld();
          this.emit('stream', ev);
          this.needSep = true;
          if (!this.busy) break;
          this.emit('tool', ev.name, ev.input, ev.id);
          break;
        case 'tool-result':
          this.cancelEmptyHeld();
          this.emit('stream', ev);
          if (this.busy) this.emit('tool-result', ev.id, ev.isError);
          break;
        case 'command': {
          const msg = this.pending.find((p) => p.uuid === ev.uuid);
          if (!msg) break;
          const changed = msg.state !== ev.state;
          msg.state = ev.state;
          // Claude Code started the message: a held result was a turn of its own. It finished it: the held result was its.
          if (ev.state === 'started') {
            this.releaseHeldAsAside();
            // Notifications that got no turn of their own before our message started are folded into its turn.
            if ([...this.reports.values()].some((x) => !x.folded)) this.updateReports(() => this.reports.forEach((x) => (x.folded = true)));
          }
          // A completed message with no result held yet only records the state: a later result ends the turn (an absorbed message).
          else if (ev.state === 'completed' && this.held) {
            this.endWithHeld();
            break;
          }
          if (changed) this.emitState();
          break;
        }
        case 'rate-limit':
          this.lastLimit = ev.info;
          this.emit('rate-limit', ev.info);
          break;
        case 'result': {
          this.turnOpen = false;
          this.emit('stream', ev);
          // The context size after the last model call of this result (a turn's end or an aside), no turn accounting.
          if (ev.contextTokens !== null) this.emit('context', ev.contextTokens);
          if (ev.sessionId) this._sessionId = ev.sessionId;
          const text = this.collected();
          this.resetText();
          const r: Omit<TurnEnd, 'uuids'> = { text, isError: ev.isError, resultText: ev.text };
          const limit = ev.isError ? limitStop(ev.apiErrorStatus ?? null, this.lastLimit) : null;
          if (limit) r.limit = limit;
          if (!this.busy) {
            // A turn Claude Code started on its own while the app waits for nothing: its reply is shown.
            this.ownTurnEnded();
            if (text) this.emit('aside', { text } satisfies Aside);
            break;
          }
          // An empty result of no model call (a leftover notice on --resume) answers nothing that was only started.
          const noModelCall = !ev.isError && !text && !ev.text && ev.numTurns === 0;
          // The messages Claude Code started or finished (an absorbed message completes before the result) are answered.
          const taken = this.takenBy(noModelCall);
          if (taken.length > 0) {
            this.releaseHeldAsAside();
            this.endTurn(r, taken);
            break;
          }
          // Every message still queued, or an empty result of no model call: wait for the lifecycle.
          const allQueued = this.allQueued();
          if (allQueued || noModelCall) {
            this.hold(r, noModelCall && !allQueued);
            break;
          }
          // No lifecycle seen for the oldest message: it is the one this result answers.
          this.releaseHeldAsAside();
          this.endTurn(r, this.pending.slice(0, 1));
          this.armAbsorbed();
          break;
        }
      }
    }
  }

  private handleExit(child: ChildProcess, code: number | null): void {
    if (this.child !== child) return;
    this.handleEvents(this.parser.flush());
    this.child = null;
    if (this.reports.size > 0 || this.reportTimer) this.updateReports(() => this.reports.clear());
    const duringTurn = this.busy;
    if (duringTurn) {
      // A held result is still shown (as an aside), then the turn ends as one error for every message written.
      this.releaseHeldAsAside();
      const text = this.collected();
      const uuids = this.pending.map((p) => p.uuid);
      this.pending = [];
      this.emit('turn-end', { text, isError: true, resultText: this._lastStderr, uuids } satisfies TurnEnd);
    }
    // No timer outlives the process.
    this.dropHeld();
    this.clearAbsorbed();
    this.turnOpen = false;
    this.resetText();
    this.emit('exit', { code, duringTurn });
    this.emitState();
    const w = this.exitWaiters;
    this.exitWaiters = [];
    w.forEach((r) => r());
  }
}
