// One chat thread (the CoS thread, or a department tab): an app-owned log, the list of messages sent and not answered
// yet, and at most one live Claude Code process. Every message is written to the process at once (no app-side queue):
// Claude Code absorbs it into the running turn or gives it a turn of its own, and each turn end names the messages it answers.
import type { Aside, ClaudeSession, LimitStop, TurnEnd } from '../claude/session';
import type { ClaudeEvent, McpServerInfo } from '../claude/stream';
import { ThreadLog, newEntryId } from '../claude/thread-log';
import { localDay } from '../claude/session-store';
import type { ActivityStep, AppEvent, DocumentAttachment, ImageAttachment, ThreadFileRef, ThreadImageRef, OrgId, RunningCommand, ThreadEntry, ThreadEntryKind, ThreadId, ThreadActivity, ThreadInfo, ThreadState } from '../../shared/types';
import { commandContext, type RunningUserCommand } from '../system/user-command';
import { t } from '../../shared/strings';
import { HANDOFF_TAG } from '../../shared/org-chart-live';
import { formatDuration } from '../../shared/duration';
import { limitReachedText, type RateLimitInfo } from '../../shared/usage';
import { continuationText, recentMessages, type RecentMessage } from './continuation';
import { describeDetail, describeTool, isAppTool } from '../claude/activity';

export type QueueKind = 'user' | 'handoff';

interface QueueItem {
  text: string;
  kind: QueueKind;
  tag?: string;
  images?: ImageAttachment[];
  /** PDFs sent inline as document blocks (kept with the item like the images, so a replay in a fresh session sends them again). */
  documents?: DocumentAttachment[];
  wire?: string;
  /** First message of a continued new session: the last messages of the chat, put before it in `wire` (see `continuation.ts`). */
  recent?: RecentMessage[];
}

export interface ToolUse {
  /** The tool_use id of the call (matches its tool_result). */
  id?: string;
  name: string;
  input: unknown;
  /** True only when a tool_result for this call arrived and was not an error (a denied permission comes back as an error). */
  ok: boolean;
}

export interface TurnResult {
  text: string;
  isError: boolean;
  resultText: string;
  /** The turn stopped on a usage limit (see ClaudeSession `TurnEnd.limit`). */
  limit?: LimitStop;
  tools: ToolUse[];
  /** The tool calls of the chat's sub-agents seen in its stream during the turn (name and input only: no result is tracked). */
  subTools: Array<{ name: string; input: unknown }>;
  /** The messages this turn answered, in write order: one, or several when Claude Code absorbed them into one turn (`wire`: the text Claude Code got, with the output of "!" commands before it). */
  sent: Array<{ text: string; kind: QueueKind; tag?: string; images?: ImageAttachment[]; wire?: string }>;
  /** True when the turn never started (sessions may not start, or the process could not be made): a failed result with no tools. */
  notStarted?: boolean;
}

/** A step of the turn in flight. `endedAt` is when its tool result arrived, or else when the first text after it started. */
export interface TurnStep {
  id?: string;
  text: string;
  detail: string;
  time: string;
  endedAt?: string;
}

/**
 * The steps of a finished turn with their durations. A step lasts until the next one starts. The last one lasts until
 * its tool result arrived or, if the app never saw one, until the first text after it (`endedAt`), not until the turn
 * ends, so the time spent writing the answer is not counted as that step. Without either signal it ends with the turn.
 * On a failed turn the last step failed.
 */
export function finishSteps(steps: TurnStep[], endMs: number, failed: boolean): ActivityStep[] {
  return steps.map((x, i) => {
    const from = new Date(x.time).getTime();
    const last = i + 1 >= steps.length;
    const to = last ? (x.endedAt ? new Date(x.endedAt).getTime() : endMs) : new Date(steps[i + 1].time).getTime();
    return { text: x.text, detail: x.detail, durationMs: Math.max(0, to - from), ...(failed && last ? { failed: true } : {}) };
  });
}

export interface ThreadOptions {
  orgId: OrgId;
  threadId: ThreadId;
  title: string;
  speaker: string;
  /** Folder the session runs in (the hq); tool paths are shown relative to it. */
  cwd?: string;
  logFile: string;
  /** Builds a new process; `resumeId` is null for a fresh session. */
  makeSession: (resumeId: string | null) => ClaudeSession;
  /** Where the session id is kept (a thread without `fresh` resumes what is stored). */
  sessions?: {
    get: () => { sessionId: string; day: string } | null;
    set: (sessionId: string, day: string) => void;
    clear: () => void;
  };
  /**
   * The chief of staff only: the thread stays one thread for the user, but the Claude Code session behind it is never
   * resumed across app runs, after inactivity (`idleMs()` of 0: no inactivity trigger), on a new local day or after
   * `requestNewSession`. Decided in `enqueue`, only for a message sent from idle (nothing unanswered). That is a normal new session.
   * A continued new session (the chat goes on, see `continuation.ts`) starts when the context size reported after a
   * result (`sizeTokens()`, 0: never) reached the limit on the second result of a session or later.
   */
  fresh?: { idleMs: () => number; sizeTokens: () => number };
  /** Returns a reason when sessions may not start (for example an unsupported Claude Code). */
  canStart?: () => string | null;
  emit: (e: AppEvent) => void;
  now?: () => Date;
  /** Model, effort and choice of the thread, shown in the header (the fields of ThreadState). */
  runInfo?: () => Pick<ThreadState, 'model' | 'effort' | 'runChoice' | 'runPending' | 'runDefaults' | 'modelTiers' | 'permissionMode' | 'seenModels' | 'inbox'>;
  /** Called with the resolved model id of every init message (the app remembers the ids it has seen). */
  onModelSeen?: (model: string) => void;
  /** Every dispatch-related stream event of the live session (see ClaudeSession 'stream'). */
  onStream?: (ev: ClaudeEvent) => void;
  /** The process of this thread's live session exited, or one the thread was stopping did: what ran in it is gone. */
  onSessionExit?: () => void;
  /** Called when a reply of Claude Code's own arrives while the chat is idle (nobody is waiting on it: for a notice). */
  onIdleAside?: () => void;
  /** Plan usage reported by the live session (each `rate_limit_event`). */
  onRateLimit?: (info: RateLimitInfo) => void;
  /**
   * Checked before a live process is reused, only when the thread is idle: true when it was started with a model or effort that
   * is not the wanted one any more. The process is then stopped and started again with --resume.
   */
  needsRestart?: () => boolean;
  /**
   * While this returns true (background work lives in the process), a new session (`fresh`) and the `needsRestart`
   * restart wait until it returns false. No dialog: the user just sent a message.
   */
  holdRestart?: () => boolean;
  /** The MCP servers this thread's process reports changed (a new init with another list). Read them with `connectors`. */
  onConnectors?: () => void;
  /** The busy state may have changed (state emits, and the session's own pending list moving). */
  onBusyChange?: () => void;
}

export class Thread {
  readonly orgId: OrgId;
  readonly threadId: ThreadId;
  title: string;
  speaker: string;
  private readonly log: ThreadLog;
  /** The messages sent (or about to be) and not answered yet, in order; `uuid` is null until the session has them. */
  private readonly unanswered: Array<{ item: QueueItem; uuid: string | null }> = [];
  /** `flush` is running (it writes the messages with no uuid yet, one after the other). */
  private flushing = false;
  /** A message is being written to the session: a turn end it causes at once is handled after its uuid is known. */
  private writing = false;
  private session: ClaudeSession | null = null;
  private resumedWith: string | null = null;
  private turnsInSession = 0;
  /** Commands the user runs with "!" (not ended yet). */
  private readonly commands = new Map<string, RunningCommand & { cancel: () => void }>();
  /** Output of ended "!" commands, in the order they ended, waiting for the next turn. */
  private context: string[] = [];
  private tools: ToolUse[] = [];
  private subTools: Array<{ name: string; input: unknown }> = [];
  private streaming = '';
  /** The resolved model id of the latest init message; kept across process restarts until a new init arrives. */
  private resolvedModel: string | null = null;
  /** The MCP servers of the latest init of this thread's process (the app's own `coa` left out). Memory only: never in the log or on disk. */
  private mcpList: McpServerInfo[] = [];
  private mcpJson = '[]';
  private sawInit = false;
  /** The turn in flight: when it started and the plain-language steps so far. */
  private turn: { startedAt: Date; steps: TurnStep[]; current: string | null } | null = null;
  private disposed = false;
  /** A restart was held back for background work and the thread has said so (reset when nothing holds it). */
  private restartHeldNoted = false;
  /** The process `stopSession` is ending (its exit still counts as this thread's). */
  private stopping: ClaudeSession | null = null;
  /** Fresh threads: the id of the live session (from its init), kept across technical restarts of this app run; null until the first one. */
  private currentSessionId: string | null = null;
  /** Fresh threads: when the live session last did anything (not set by enqueue or "!" commands). */
  private lastActive: Date | null = null;
  /** Fresh threads: the user asked for a new session (`requestNewSession`) and it has not started yet. */
  private newSessionRequested = false;
  /** Fresh threads: the next `ensureSession` starts a new session. */
  private freshNext = false;
  /** Fresh threads: the context of the live session reached the size limit; the next new session is a continued one (unless a normal one is due). */
  private renewForSize = false;
  /** Fresh threads: results seen in the current session (reset when a new session starts, not on a technical restart). */
  private sessionTurns = 0;
  /** A new session was held back for background work and the thread has said so (reset when it starts). */
  private newSessionHeldNoted = false;
  private readonly turnListeners: ((r: TurnResult) => void)[] = [];
  private readonly startListeners: (() => void)[] = [];
  private readonly toolListeners: (() => void)[] = [];

  constructor(private readonly o: ThreadOptions) {
    this.orgId = o.orgId;
    this.threadId = o.threadId;
    this.title = o.title;
    this.speaker = o.speaker;
    this.log = new ThreadLog(o.logFile);
  }

  onTurnEnd(fn: (r: TurnResult) => void): void {
    this.turnListeners.push(fn);
  }

  /** Called when a turn starts from idle (its first message is about to be written, before the process gets it). Once per busy period: a message written while others are unanswered (a handover too) does not fire it. */
  onTurnStart(fn: () => void): void {
    this.startListeners.push(fn);
  }

  /**
   * Called on every tool call of the message in flight, the chat's own or a sub-agent's, except in a hand-over turn.
   * It lets the owner know about work before the turn ends.
   */
  onToolUse(fn: () => void): void {
    this.toolListeners.push(fn);
  }

  /** Stops calling a listener added with `onTurnEnd`. */
  offTurnEnd(fn: (r: TurnResult) => void): void {
    const i = this.turnListeners.indexOf(fn);
    if (i >= 0) this.turnListeners.splice(i, 1);
  }

  private notifyToolUse(): void {
    const first = this.unanswered[0];
    if (!first || first.item.tag === 'handover') return;
    for (const fn of [...this.toolListeners]) {
      try {
        fn();
      } catch (e) {
        console.error('tool listener failed', e);
      }
    }
  }

  /** True while a message with this tag is sent and not answered yet. */
  hasTag(tag: string): boolean {
    return this.unanswered.some((u) => u.item.tag === tag);
  }

  /** True while a "!" command of this chat runs. */
  get commandRunning(): boolean {
    return this.commands.size > 0;
  }

  /**
   * Follows a "!" command the user started: listed in the state while it runs, then one `command` entry in the thread,
   * and its output goes before the text of the next message Claude Code gets (it never starts a turn by itself).
   */
  trackCommand(command: string, run: RunningUserCommand): string {
    const id = newEntryId();
    const startedAt = this.now().toISOString();
    this.commands.set(id, { id, command, startedAt, cancel: run.cancel });
    this.emitState();
    void run.done.then((r) => {
      this.commands.delete(id);
      if (!this.disposed) {
        const entry: ThreadEntry = { id: newEntryId(), kind: 'command', author: t('you'), text: command, time: startedAt, command: r };
        this.log.append(entry);
        this.o.emit({ type: 'thread-entry', orgId: this.orgId, threadId: this.threadId, entry });
        this.context.push(commandContext(command, r));
      }
      this.emitState();
    });
    return id;
  }

  cancelCommand(id: string): void {
    this.commands.get(id)?.cancel();
  }

  get busy(): boolean {
    return this.unanswered.length > 0;
  }

  /** True once a process of this thread has sent an init message. */
  get hadInit(): boolean {
    return this.sawInit;
  }

  /** The connectors the latest init reported (never the app's own server). */
  get connectors(): readonly McpServerInfo[] {
    return this.mcpList;
  }

  /** A background agent ended and the chief of staff's report on it has not ended yet (`ClaudeSession.reportPending`). */
  get awaitingReport(): boolean {
    return !!this.session?.reportPending;
  }

  /** When the turn in flight started (ISO), or null. */
  get turnStartedAt(): string | null {
    return this.turn ? this.turn.startedAt.toISOString() : null;
  }

  /** Handoffs sent behind another unanswered message that Claude Code has not started yet. */
  private waitingHandoffs(): QueueItem[] {
    return this.unanswered
      .filter((u, i) => {
        if (i === 0 || u.item.kind !== 'handoff') return false;
        const st = u.uuid ? this.session?.stateOf(u.uuid) : null;
        return st !== 'started' && st !== 'completed';
      })
      .map((u) => u.item);
  }

  get handoffsWaiting(): number {
    return this.waitingHandoffs().length;
  }

  /** Tab ids of the handoffs waiting (tagged `handoff:<tabId>`): which departments have one waiting for the chief of staff. */
  get handoffTabs(): string[] {
    return this.waitingHandoffs().filter((q) => q.tag?.startsWith(HANDOFF_TAG)).map((q) => q.tag!.slice(HANDOFF_TAG.length));
  }

  get sessionId(): string | null {
    return this.session?.sessionId ?? null;
  }

  state(): ThreadState {
    return { orgId: this.orgId, threadId: this.threadId, busy: this.busy, handoffsWaiting: this.handoffsWaiting, handoffTabs: this.handoffTabs, activity: this.activity(), resolvedModel: this.resolvedModel, reportPending: !!this.session?.reportPending, commands: [...this.commands.values()].map(({ id, command, startedAt }) => ({ id, command, startedAt })), ...this.o.runInfo?.() };
  }

  private activity(): ThreadActivity | null {
    if (!this.turn) return null;
    return { startedAt: this.turn.startedAt.toISOString(), current: this.turn.current, steps: this.turn.steps.length };
  }

  info(): ThreadInfo {
    return { ...this.state(), title: this.title, speaker: this.speaker, entries: this.log.readAll(), streaming: this.streaming };
  }

  /** Adds an entry to the log and tells the renderer. */
  append(kind: ThreadEntryKind, author: string, text: string, extra?: Pick<ThreadEntry, 'steps' | 'durationMs' | 'images' | 'files' | 'action' | 'earlierNote'>): ThreadEntry {
    const entry: ThreadEntry = { id: newEntryId(), kind, author, text, time: this.now().toISOString(), ...extra };
    if ((kind === 'assistant' || kind === 'activity') && this.resolvedModel) entry.model = this.resolvedModel;
    if (this.session?.sessionId) entry.sessionId = this.session.sessionId;
    this.log.append(entry);
    this.o.emit({ type: 'thread-entry', orgId: this.orgId, threadId: this.threadId, entry });
    return entry;
  }

  /**
   * Sends a message at once (written to Claude Code as soon as the process is there). `display` is the entry shown in the thread (null to show nothing); `images` are the attachments
   * sent to Claude Code and `refs` the same images as stored (the log holds only the refs).
   */
  enqueue(text: string, kind: QueueKind, display: { kind: ThreadEntryKind; author: string; text: string; earlierNote?: boolean } | null, tag?: string, images?: { send: ImageAttachment[]; refs: ThreadImageRef[] }, files?: { refs: ThreadFileRef[]; wire: string; documents?: DocumentAttachment[] }): void {
    if (this.disposed) return;
    const recent = this.decideFresh();
    if (display) this.append(display.kind, display.author, display.text, { ...(images?.refs.length ? { images: images.refs } : {}), ...(files?.refs.length ? { files: files.refs } : {}), ...(display.earlierNote ? { earlierNote: true } : {}) });
    this.unanswered.push({ item: { text, kind, tag, images: images?.send.length ? images.send : undefined, ...(files?.refs.length ? { wire: files.wire } : {}), ...(files?.documents?.length ? { documents: files.documents } : {}), ...(recent ? { recent } : {}) }, uuid: null });
    this.emitState();
    void this.flush();
  }

  /** Fresh threads: a new session is due (app open, requested, idle too long, or the last activity was on an earlier day). */
  private freshDue(): boolean {
    if (this.currentSessionId === null || this.newSessionRequested) return true;
    if (!this.lastActive) return false;
    const now = this.now();
    const idleMs = this.o.fresh?.idleMs() ?? 0;
    if (idleMs > 0 && now.getTime() - this.lastActive.getTime() >= idleMs) return true;
    return localDay(this.lastActive) !== localDay(now);
  }

  /**
   * Decides, for a message about to be sent from idle (nothing unanswered, sessions may start), whether it starts
   * a new session. A message sent while others are unanswered continues the session they run in. Background work in the live
   * process holds the new session back: it starts with the first message from idle after that work has ended.
   * The reasons of `freshDue` give a normal new session; only when none is due, a context that reached the size limit
   * gives a continued one. Returns the recent messages to put before the message (continued session), else undefined.
   */
  private decideFresh(): RecentMessage[] | undefined {
    if (!this.o.fresh || this.unanswered.length > 0 || (this.o.canStart?.() ?? null) !== null) return undefined;
    const normal = this.freshDue();
    if (!normal && !this.renewForSize) return undefined;
    if (this.session && this.o.holdRestart?.()) {
      if (normal) this.newSessionRequested = true;
      if (!this.newSessionHeldNoted) {
        this.newSessionHeldNoted = true;
        this.append('system', '', t('thread.newSessionHeld'));
      }
      return undefined;
    }
    const recent = normal ? undefined : recentMessages(this.log.readAll());
    this.freshNext = true;
    this.newSessionRequested = false;
    this.renewForSize = false;
    this.newSessionHeldNoted = false;
    this.appendDivider(!normal);
    return recent;
  }

  /** The divider "New session" (or "New session (continued)"): its label is built by the renderer from the entry's time. It belongs to no session. */
  private appendDivider(continued = false): void {
    const entry: ThreadEntry = { id: newEntryId(), kind: 'session', author: '', text: '', time: this.now().toISOString(), ...(continued ? { continued: true as const } : {}) };
    this.log.append(entry);
    this.o.emit({ type: 'thread-entry', orgId: this.orgId, threadId: this.threadId, entry });
  }

  /**
   * The user asked for a new session (fresh threads only). Nothing stops or is sent: the new session starts with the
   * first message that is sent from idle. Returns false for another thread or when one is already requested.
   */
  requestNewSession(): boolean {
    if (!this.o.fresh || this.disposed || this.newSessionRequested) return false;
    this.newSessionRequested = true;
    const idle = !this.busy && !(this.session && this.o.holdRestart?.());
    this.append('system', '', idle ? t('thread.newSessionNext', { cosName: this.speaker }) : t('thread.newSessionNextBusy'));
    return true;
  }

  /** Stops the process after every message is answered (used after a plugin update). */
  async restart(): Promise<void> {
    await this.idle();
    await this.stopSession();
  }

  async stop(graceMs?: number): Promise<void> {
    this.unanswered.length = 0;
    await this.stopSession(graceMs);
    this.turn = null;
    this.streaming = '';
    this.emitState();
  }

  /**
   * Stops the live process at once (like `stop(0)`); the messages not answered yet end with it, and the thread counts as idle.
   */
  async interrupt(): Promise<void> {
    await this.stop(0);
  }

  /** Permanent stop (tab closed): drops the unanswered messages, ends the process, and the thread never spawns again. */
  async dispose(graceMs?: number): Promise<void> {
    this.disposed = true;
    this.stopCommands();
    await this.stop(graceMs);
  }

  /** Stops every running "!" command (the chat closes or the app stops). */
  stopCommands(): void {
    for (const c of this.commands.values()) c.cancel();
  }

  idle(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (!this.busy) resolve();
        else setTimeout(check, 200);
      };
      check();
    });
  }

  private now(): Date {
    return this.o.now ? this.o.now() : new Date();
  }

  /** Tells the renderer the thread's state again (something it shows from `runInfo` changed). */
  refreshState(): void {
    this.emitState();
  }

  private emitState(): void {
    this.o.emit({ type: 'thread-state', state: this.state() });
    this.o.onBusyChange?.();
  }

  private async stopSession(graceMs?: number): Promise<void> {
    const s = this.session;
    this.session = null;
    if (!s) return;
    this.stopping = s;
    try {
      await s.stop(graceMs);
    } finally {
      if (this.stopping === s) this.stopping = null;
    }
  }

  /** Writes every message that has no uuid yet to the session, in order, one after the other (the process starts first when there is none). */
  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (;;) {
        const entry = this.unanswered.find((u) => u.uuid === null);
        if (this.disposed || !entry) return;
        if (!(await this.writeOne(entry))) return;
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Takes a message that could not be sent out of the list. */
  private dropUnsent(entry: { item: QueueItem }): void {
    const i = this.unanswered.findIndex((u) => u === entry);
    if (i >= 0) this.unanswered.splice(i, 1);
    if (this.unanswered.length === 0) this.turn = null;
  }

  /** Sends one message. Returns false when the loop must stop (disposed, or the thread was stopped meanwhile). */
  private async writeOne(entry: { item: QueueItem; uuid: string | null }): Promise<boolean> {
    const next = entry.item;
    const reason = this.o.canStart?.() ?? null;
    if (reason) {
      const dropped = this.unanswered.filter((u) => u.uuid === null);
      for (const d of dropped) this.dropUnsent(d);
      this.append('error', '', reason);
      if (dropped.length) this.emitState();
      for (const d of dropped) if (d.item.tag) this.notifyNotStarted(d.item, reason);
      return true;
    }
    // Output of "!" commands that ended since the last message goes first, as Claude Code does for its own bash mode.
    const context = this.context.splice(0);
    if (context.length) next.wire = `${context.join('\n\n')}\n\n${next.wire ?? next.text}`;
    // The first message of a continued session: the marker and the last messages of the chat go before it (and before the "!" output).
    if (next.recent) next.wire = continuationText(next.recent, next.wire ?? next.text);
    if (!this.turn) {
      this.tools = [];
      this.subTools = [];
      this.turn = { startedAt: this.now(), steps: [], current: null };
      this.emitState();
      for (const fn of [...this.startListeners]) {
        try {
          fn();
        } catch (e) {
          console.error('turn start listener failed', e);
        }
      }
    }
    try {
      await this.ensureSession();
      // The process exited while we waited (its exit is reported right after its last turn-end): start a new one.
      if (!this.disposed && !this.session) await this.ensureSession();
    } catch (e) {
      if (this.disposed) return false;
      this.context.unshift(...context);
      this.dropUnsent(entry);
      const msg = String((e as Error).message || e);
      this.append('error', '', msg);
      this.emitState();
      if (next.tag) this.notifyNotStarted(next, msg);
      return true;
    }
    if (this.disposed) {
      await this.stopSession();
      return false;
    }
    // Stopped while the process started: the message went with it.
    if (!this.unanswered.includes(entry)) return true;
    const live = this.session as ClaudeSession | null;
    if (!live) {
      this.context.unshift(...context);
      this.dropUnsent(entry);
      this.append('error', '', t('thread.processExited'));
      this.emitState();
      return true;
    }
    this.writing = true;
    try {
      entry.uuid = live.send(next.wire ?? next.text, next.images, next.documents);
    } finally {
      this.writing = false;
    }
    return true;
  }

  /** A message that could not be sent ends its turn as a failed one with no tools, so whoever waits for its tag is told. */
  private notifyNotStarted(sent: { text: string; kind: QueueKind; tag?: string }, reason: string): void {
    const result: TurnResult = { text: '', isError: true, resultText: reason, tools: [], subTools: [], sent: [sent], notStarted: true };
    for (const fn of [...this.turnListeners]) {
      try {
        fn(result);
      } catch (e) {
        console.error('turn listener failed', e);
      }
    }
  }

  private async ensureSession(): Promise<void> {
    const hold = !!this.o.holdRestart?.();
    // Say once per hold that a restart waits, so a new model, effort or rule does not seem ignored.
    if (!hold) this.restartHeldNoted = false;
    else if (this.session && !this.restartHeldNoted && this.o.needsRestart?.()) {
      this.restartHeldNoted = true;
      this.append('system', '', t('thread.restartHeld'));
    }
    // The thread is idle (no message written and unanswered): a settings change or a new session may replace the process.
    const idle = !this.unanswered.some((u) => u.uuid !== null);
    // A new session of a fresh thread (decided in enqueue, so nothing was unanswered): the idle process is replaced.
    if (this.freshNext) {
      this.freshNext = false;
      this.currentSessionId = null;
      this.renewForSize = false;
      this.sessionTurns = 0;
      if (this.session) await this.stopSession();
      if (this.disposed) return;
    }
    // The chat's model or effort changed: the idle process is replaced, the conversation continues with --resume.
    let liveId: string | null = null;
    if (!this.disposed && this.session && idle && !hold && this.o.needsRestart?.()) {
      liveId = this.session.sessionId;
      await this.stopSession();
    }
    if (this.disposed || this.session) return;
    let resumeId: string | null;
    if (this.o.fresh) resumeId = this.currentSessionId ?? liveId;
    else resumeId = this.o.sessions?.get()?.sessionId ?? liveId;
    this.startSession(resumeId, localDay(this.now()));
  }

  private startSession(resumeId: string | null, day: string): void {
    if (this.disposed) return;
    const s = this.o.makeSession(resumeId);
    this.session = s;
    this.resumedWith = resumeId;
    this.turnsInSession = 0;
    s.on('state', () => {
      if (this.session === s) this.o.onBusyChange?.();
    });
    const mcpReported = new Set<string>();
    s.on('init', (id: string, model?: string | null, mcpFailed?: string[], mcpServers?: McpServerInfo[]) => {
      if (this.session !== s) return;
      this.lastActive = this.now();
      const list = (mcpServers ?? []).filter((m) => m.name !== 'coa');
      const json = JSON.stringify(list);
      // The first init of the thread counts as a change too: the Settings view then knows connectors are real.
      const changed = json !== this.mcpJson || !this.sawInit;
      this.sawInit = true;
      this.mcpList = list;
      this.mcpJson = json;
      if (changed) this.o.onConnectors?.();
      this.currentSessionId = id;
      this.o.sessions?.set(id, day);
      // A connector that could not start: one line per server and process (every turn of a long process sends an init). The app's own server is not the user's connector.
      for (const name of mcpFailed ?? []) {
        if (name === 'coa' || mcpReported.has(name)) continue;
        mcpReported.add(name);
        this.append('error', '', t('thread.connectorFailed', { name }));
      }
      if (model) {
        this.resolvedModel = model;
        this.o.onModelSeen?.(model);
        this.emitState();
      }
    });
    s.on('delta', (text: string) => {
      if (this.session !== s) return;
      this.lastActive = this.now();
      this.streaming += text;
      this.endLastStep();
      this.o.emit({ type: 'thread-delta', orgId: this.orgId, threadId: this.threadId, text });
    });
    s.on('tool', (name: string, input: unknown, id?: string) => {
      if (this.session !== s) return;
      this.lastActive = this.now();
      this.tools.push({ id, name, input, ok: false });
      this.notifyToolUse();
      if (this.turn && !isAppTool(name)) {
        const text = describeTool(name, input, this.o.cwd ?? '');
        this.turn.steps.push({ id, text, detail: describeDetail(name, input, this.o.cwd), time: this.now().toISOString() });
        this.turn.current = text;
        this.emitState();
      }
    });
    s.on('sub-tool', (name: string, input: unknown) => {
      if (this.session !== s) return;
      this.subTools.push({ name, input });
      this.notifyToolUse();
    });
    s.on('tool-result', (id: string, isError?: boolean) => {
      if (this.session !== s) return;
      this.lastActive = this.now();
      const tool = this.tools.find((x) => x.id === id);
      if (tool) tool.ok = isError !== true;
      const step = this.turn?.steps.find((x) => x.id === id);
      if (step && !step.endedAt) step.endedAt = this.now().toISOString();
    });
    // A reply in a turn Claude Code started on its own (a background task or agent finished): its own message,
    // never the end of the turn in flight.
    // A turn of Claude Code's own ended while a message was in flight (with or without text): its tool calls were that
    // turn's, not the message's, so a handover turn counts only the note it wrote itself.
    s.on('own-turn-end', () => {
      if (this.session !== s) return;
      this.lastActive = this.now();
      this.tools = [];
      this.subTools = [];
    });
    s.on('aside', (a: Aside) => {
      if (this.session !== s || this.disposed) return;
      this.lastActive = this.now();
      this.streaming = '';
      this.append('assistant', this.speaker, a.text);
      if (!this.busy) this.o.onIdleAside?.();
    });
    // The context size after a result (a turn's end or an aside). The first result of a session never counts as a trigger.
    s.on('context', (tokens: number) => {
      if (this.session !== s || !this.o.fresh) return;
      this.sessionTurns++;
      const limit = this.o.fresh.sizeTokens();
      if (limit > 0 && tokens >= limit && this.sessionTurns >= 2) this.renewForSize = true;
    });
    s.on('rate-limit', (info: RateLimitInfo) => {
      if (this.session !== s) return;
      this.lastActive = this.now();
      this.o.onRateLimit?.(info);
    });
    s.on('turn-end', (r: TurnEnd) => {
      if (this.session !== s) return;
      this.lastActive = this.now();
      // A turn end caused by the write itself (the process could not start) comes before the uuid is known.
      if (this.writing) queueMicrotask(() => void this.onTurnEndInternal(s, r));
      else void this.onTurnEndInternal(s, r);
    });
    s.on('stream', (ev: ClaudeEvent) => {
      if (this.session !== s) return;
      this.lastActive = this.now();
      this.o.onStream?.(ev);
    });
    s.on('report-pending', () => {
      // The renderer reads it from the thread state.
      if (this.session === s) this.emitState();
    });
    s.on('exit', () => {
      // Only this thread's live process, or one it is stopping: an older process never touches the current dispatches.
      if (this.session === s || this.stopping === s) this.o.onSessionExit?.();
      if (this.session === s) this.session = null;
    });
  }

  /** The first text after the last step ends it, when no tool result said so before. */
  private endLastStep(): void {
    const last = this.turn?.steps[this.turn.steps.length - 1];
    if (last && !last.endedAt) last.endedAt = this.now().toISOString();
  }

  private async onTurnEndInternal(s: ClaudeSession, r: TurnEnd): Promise<void> {
    const answered = this.unanswered.filter((u) => u.uuid !== null && r.uuids.includes(u.uuid));
    if (answered.length === 0) return; // the thread was stopped meanwhile
    this.turnsInSession++;
    this.streaming = '';
    // A stale --resume id (session gone): start fresh and send the same messages again, once.
    if (r.isError && this.resumedWith && this.turnsInSession === 1 && /no conversation found|session.*not found/i.test(r.resultText)) {
      this.o.sessions?.clear();
      // No flush may start a process while this one is being replaced (it would be an orphan).
      const hadFlush = this.flushing;
      this.flushing = true;
      try {
        await this.stopSession();
        if (!this.disposed) {
          if (this.o.fresh) {
            // The session really is a new one now.
            this.currentSessionId = null;
            this.renewForSize = false;
            this.sessionTurns = 0;
            this.appendDivider();
          }
          this.startSession(null, localDay(this.now()));
          const fresh = this.session as ClaudeSession | null;
          if (fresh) {
            for (const u of this.unanswered) {
              if (u.uuid === null) continue;
              // Guarded like writeOne: a turn end sent by the write itself waits until the uuid is stored.
              this.writing = true;
              try {
                u.uuid = fresh.send(u.item.wire ?? u.item.text, u.item.images, u.item.documents);
              } finally {
                this.writing = false;
              }
            }
          } else {
            this.unanswered.length = 0;
            this.turn = null;
            this.emitState();
          }
        }
      } finally {
        this.flushing = hadFlush;
      }
      if (!hadFlush) void this.flush();
      return;
    }
    const turn = this.turn;
    if (turn && turn.steps.length > 0) {
      const durationMs = Math.max(0, this.now().getTime() - turn.startedAt.getTime());
      const count = turn.steps.length;
      const steps = finishSteps(turn.steps, this.now().getTime(), r.isError);
      this.append('activity', '', t(count === 1 ? 'activity.summaryOne' : 'activity.summary', { count, time: formatDuration(durationMs) }), { steps, durationMs });
    }
    if (r.text) this.append('assistant', this.speaker, r.text);
    if (r.isError && r.limit) {
      // A usage limit, not a crash: say which limit and when it resets.
      this.append('error', '', limitReachedText(r.limit.limitType, r.limit.resetsAt, this.now()));
    } else if (r.isError) {
      const lastLine = (txt: string) => txt.trim().split('\n').filter(Boolean).pop() ?? '';
      const msg = lastLine(r.resultText) || lastLine(s.lastStderr) || t('thread.processExited');
      this.append('error', '', msg);
    } else if (!r.text) {
      this.append('system', '', t('thread.noReply'));
    }
    const { uuids: _uuids, ...rest } = r;
    const result: TurnResult = { ...rest, tools: this.tools, subTools: this.subTools, sent: answered.map((u) => u.item) };
    for (const u of answered) this.unanswered.splice(this.unanswered.indexOf(u), 1);
    this.tools = [];
    this.subTools = [];
    // Messages still unanswered run in a turn of their own (or are being written): it starts now.
    this.turn = this.unanswered.length > 0 ? { startedAt: this.now(), steps: [], current: null } : null;
    this.emitState();
    // A copy: a listener may remove itself (offTurnEnd) while the others still have to run.
    for (const fn of [...this.turnListeners]) {
      try {
        fn(result);
      } catch (e) {
        console.error('turn listener failed', e);
      }
    }
    void this.flush();
  }
}
