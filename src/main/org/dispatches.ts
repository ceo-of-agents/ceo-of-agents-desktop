// Tracks the Agent calls the chief of staff and the department chats make (foreground and background), from their
// sessions' streams. State and times only: never a prompt, a summary or any tool output. One tracker per org; every
// item belongs to a thread (the chief of staff's, or `tab:<tabId>`), and an event only touches the items of its own thread.
import fs from 'node:fs';
import path from 'node:path';
import type { ClaudeEvent } from '../claude/stream';
import type { Dispatch, DispatchBy, DispatchState } from '../../shared/types';
import { t } from '../../shared/strings';

export interface DispatchTrackerDeps {
  /** JSON file the list is kept in (`<org dataDir>/dispatches.json`). */
  file: string;
  /** The org's departments, read when a dispatch starts. */
  departments: () => Array<{ id: string; agent: string; persona: string }>;
  now?: () => Date;
  /** The whole list, after any state change (activity alone at most once a second). */
  onChange: (list: Dispatch[]) => void;
  /** The chief of staff's dispatch to a department moved to done, failed or stopped (once per run; never for a dispatch made in a department chat). */
  onEnded: (d: Dispatch) => void;
}

const MAX_ENTRIES = 50;
const MAX_DESCRIPTION = 120;
const ACTIVITY_EVERY_MS = 1000;
const STATES: readonly string[] = ['running', 'done', 'failed', 'stopped', 'unknown'];
/** The thread id of the chief of staff (a dispatch without `by`). */
const COS = 'cos';
/** SendMessage calls remembered per thread (the oldest go first). */
const MAX_SENDS = 200;

/** A background dispatch silent for this long no longer holds back a chief of staff restart (ms). */
export const HOLD_STALE_MS = 15 * 60_000;

/**
 * The macOS notification for an ended dispatch: who and how it ended, never the task description (a notification can
 * show on a locked screen). The in-app toast keeps the description.
 */
export function endedNotificationText(d: Pick<Dispatch, 'name' | 'state'>): string {
  return t(`dispatch.ended.${d.state}Bare`, { persona: d.name });
}

export class DispatchTracker {
  private items: Dispatch[];
  /** `<thread>\u0000<Claude Code's task id>` -> the dispatch id, from `task_started`. */
  private readonly byTask = new Map<string, string>();
  /** Per thread: the SendMessage tool call ids seen (a `task_started` that carries one is a resume of an agent). */
  private readonly sends = new Map<string, Set<string>>();
  private lastEmitAt = 0;

  constructor(private readonly d: DispatchTrackerDeps) {
    this.items = this.load();
  }

  list(): Dispatch[] {
    return this.items.map((x) => ({ ...x }));
  }

  /**
   * One event of a thread's stream. `owner` says who runs the thread when it is a department chat; without it the
   * thread is the chief of staff's.
   */
  handle(ev: ClaudeEvent, owner?: DispatchBy): void {
    const thread = owner ? owner.threadId : COS;
    switch (ev.kind) {
      case 'tool-use':
        if (ev.name === 'SendMessage') this.noteSend(thread, ev.id);
        else this.start(thread, owner, ev.id, ev.name, ev.input);
        break;
      case 'task-started':
        this.taskStarted(thread, owner, ev);
        break;
      case 'sub-activity':
        this.activity(this.find(ev.parentToolUseId, thread) ?? this.findByAgent(ev.agentId, thread));
        break;
      case 'task-progress':
        this.activity(this.find(ev.toolUseId, thread));
        break;
      case 'tool-result': {
        // The answer to a SendMessage says nothing about the agent's run: that has its own task events.
        if (this.sends.get(thread)?.has(ev.id)) break;
        const x = this.find(ev.id, thread);
        if (!x || x.state !== 'running') break;
        if (ev.isError) this.end(x, 'failed');
        else if (ev.async) {
          x.background = true;
          this.commit();
        } else if (!x.background) this.end(x, 'done');
        break;
      }
      case 'task-ended': {
        // A resumed agent's notification carries the SendMessage id: the task id finds the dispatch.
        const x = (ev.toolUseId ? this.find(ev.toolUseId, thread) : undefined) ?? this.find(this.byTask.get(taskKey(thread, ev.taskId)) ?? '', thread);
        if (x && x.state === 'running') this.end(x, mapStatus(ev.status));
        break;
      }
      case 'result': {
        // A model turn is over: an agent the turn waited for cannot be followed any more. Background ones go on.
        // An empty result or a leftover one (no model call, `num_turns` 0, for example a notice on --resume) says nothing.
        if (ev.numTurns === 0 || (!ev.text && !ev.isError)) break;
        let changed = false;
        for (const x of this.items) {
          if (threadOf(x) === thread && x.state === 'running' && !x.background) {
            x.state = 'unknown';
            changed = true;
          }
        }
        if (changed) this.commit();
        break;
      }
      default:
        break;
    }
  }

  /** A thread's process ended: nothing it ran can be followed. */
  sessionExited(threadId: string = COS): void {
    let changed = false;
    for (const x of this.items) {
      if (threadOf(x) === threadId && x.state === 'running') {
        x.state = 'unknown';
        changed = true;
      }
    }
    if (changed) this.commit();
  }

  /**
   * A background dispatch is running (of one thread when `threadId` is given, else of any) and showed a sign of work in
   * the last `staleMs` (default HOLD_STALE_MS): its process must not be replaced by a restart. One silent for longer does
   * not count: its notification may have been lost, and a held restart must not wait for ever.
   */
  hasRunningBackground(threadId?: string, staleMs: number = HOLD_STALE_MS): boolean {
    const now = this.now().getTime();
    return this.items.some((x) => (threadId === undefined || threadOf(x) === threadId) && x.state === 'running' && x.background && now - new Date(x.lastActivityAt).getTime() < staleMs);
  }

  /** The running dispatches (copies). */
  running(): Dispatch[] {
    return this.items.filter((x) => x.state === 'running').map((x) => ({ ...x }));
  }

  /**
   * The app stops everything that runs (a confirmed restart or quit): every running dispatch becomes `stopped`
   * now. Returns copies of them. No `onEnded` (the caller says what stopped and why).
   */
  stopRunning(): Dispatch[] {
    const stopped: Dispatch[] = [];
    const at = this.now().toISOString();
    for (const x of this.items) {
      if (x.state !== 'running') continue;
      x.state = 'stopped';
      x.endedAt = at;
      stopped.push({ ...x });
    }
    if (stopped.length) this.commit();
    return stopped;
  }

  /**
   * A department chat is gone (closed or handed over, its process killed): what still ran in it becomes `stopped`, then
   * all its dispatches leave the list (nothing shows them any more). Returns copies of the ones it stopped. No `onEnded`.
   */
  dropThread(threadId: string): Dispatch[] {
    const stopped: Dispatch[] = [];
    const at = this.now().toISOString();
    for (const x of this.items) {
      if (threadOf(x) !== threadId || x.state !== 'running') continue;
      x.state = 'stopped';
      x.endedAt = at;
      stopped.push({ ...x });
    }
    const before = this.items.length;
    this.items = this.items.filter((x) => threadOf(x) !== threadId);
    this.sends.delete(threadId);
    this.pruneTasks();
    if (this.items.length !== before) this.commit();
    return stopped;
  }

  /** The user has seen these: ended and unknown ones leave the list, running ones stay. */
  ack(ids: string[]): void {
    const drop = new Set(ids);
    const before = this.items.length;
    this.items = this.items.filter((x) => x.state === 'running' || !drop.has(x.id));
    if (this.items.length === before) return;
    this.pruneTasks();
    this.commit();
  }

  // ---------- internals ----------

  private now(): Date {
    return this.d.now ? this.d.now() : new Date();
  }

  /** The dispatch with this id in this thread. */
  private find(id: string, thread: string): Dispatch | undefined {
    return id ? this.items.find((x) => x.id === id && threadOf(x) === thread) : undefined;
  }

  /** The newest dispatch of this thread that ran the agent with this agent id. */
  private findByAgent(agentId: string | undefined, thread: string): Dispatch | undefined {
    if (!agentId) return undefined;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const x = this.items[i];
      if (x.agentId === agentId && threadOf(x) === thread) return x;
    }
    return undefined;
  }

  private noteSend(thread: string, id: string): void {
    let set = this.sends.get(thread);
    if (!set) this.sends.set(thread, (set = new Set()));
    set.add(id);
    while (set.size > MAX_SENDS) set.delete(set.values().next().value as string);
  }

  private newDispatch(owner: DispatchBy | undefined, id: string, agent: string, description: unknown, background: boolean, agentId?: string): void {
    const dep = this.d.departments().find((x) => x.agent === agent);
    const at = this.now().toISOString();
    this.items.push({
      id,
      agent,
      departmentId: dep ? dep.id : null,
      // A sub-agent of a department chat reads "Max → worker"; the chief of staff's shows the department's persona, or the agent name.
      name: owner ? t('dispatch.byName', { by: owner.name, agent }) : dep ? dep.persona : agent,
      description: typeof description === 'string' ? cleanDescription(description) : '',
      background,
      state: 'running',
      startedAt: at,
      lastActivityAt: at,
      endedAt: null,
      ...(agentId ? { agentId } : {}),
      ...(owner ? { by: { ...owner } } : {}),
    });
    this.trim();
    this.commit();
  }

  private start(thread: string, owner: DispatchBy | undefined, id: string, name: string, input: unknown): void {
    if (name !== 'Agent' && name !== 'Task') return;
    if (typeof input !== 'object' || input === null) return;
    const inp = input as Record<string, unknown>;
    const agent = typeof inp.subagent_type === 'string' ? inp.subagent_type.trim() : '';
    if (!agent || this.find(id, thread)) return;
    this.newDispatch(owner, id, agent, inp.description, inp.run_in_background === true);
  }

  private taskStarted(thread: string, owner: DispatchBy | undefined, ev: Extract<ClaudeEvent, { kind: 'task-started' }>): void {
    const x = this.find(ev.toolUseId, thread);
    if (x) {
      this.byTask.set(taskKey(thread, ev.taskId), x.id);
      let changed = false;
      if (ev.taskId && !x.agentId) {
        x.agentId = ev.taskId;
        changed = true;
      }
      if (x.state === 'running' && ev.background && !x.background) {
        x.background = true;
        changed = true;
      }
      if (changed) this.commit();
      return;
    }
    // A task_started with an id that is no dispatch of ours: only a SendMessage resume of an agent counts.
    if (!ev.taskId) return;
    const old = this.findByAgent(ev.taskId, thread);
    if (old) {
      // The agent runs again: the same dispatch is running again.
      old.state = 'running';
      old.background = ev.background;
      old.endedAt = null;
      old.startedAt = old.lastActivityAt = this.now().toISOString();
      if (!old.description) old.description = cleanDescription(ev.description);
      this.byTask.set(taskKey(thread, ev.taskId), old.id);
      this.commit();
      return;
    }
    // An agent the app has no record of (acked, or lost with an older list): the SendMessage call is its dispatch.
    const agent = ev.agent.trim();
    if (!agent || !this.sends.get(thread)?.has(ev.toolUseId)) return;
    this.newDispatch(owner, ev.toolUseId, agent, ev.description, ev.background, ev.taskId);
    this.byTask.set(taskKey(thread, ev.taskId), ev.toolUseId);
  }

  private activity(x: Dispatch | undefined): void {
    if (!x || x.state !== 'running') return;
    x.lastActivityAt = this.now().toISOString();
    this.commit(true);
  }

  private end(x: Dispatch, state: Exclude<DispatchState, 'running' | 'unknown'>): void {
    x.state = state;
    x.endedAt = this.now().toISOString();
    this.commit();
    if (x.departmentId !== null && !x.by) this.d.onEnded({ ...x });
  }

  /** At most MAX_ENTRIES: the oldest ended ones go first. */
  private trim(): void {
    while (this.items.length > MAX_ENTRIES) {
      const i = this.items.findIndex((x) => x.state !== 'running');
      this.items.splice(i >= 0 ? i : 0, 1);
    }
    this.pruneTasks();
  }

  private pruneTasks(): void {
    for (const [key, id] of this.byTask) {
      const thread = key.slice(0, key.indexOf('\u0000'));
      if (!this.find(id, thread)) this.byTask.delete(key);
    }
  }

  private commit(activityOnly = false): void {
    const t = this.now().getTime();
    if (activityOnly && t - this.lastEmitAt < ACTIVITY_EVERY_MS) return;
    this.lastEmitAt = t;
    this.save();
    this.d.onChange(this.list());
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.d.file), { recursive: true });
      const tmp = `${this.d.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.items, null, 2) + '\n');
      fs.renameSync(tmp, this.d.file);
    } catch (e) {
      console.error('could not save dispatches', e);
    }
  }

  /** What a previous run left: whatever was running cannot be followed any more. */
  private load(): Dispatch[] {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.d.file, 'utf8'));
    } catch {
      return [];
    }
    if (!Array.isArray(raw)) return [];
    const out: Dispatch[] = [];
    for (const v of raw) {
      if (typeof v !== 'object' || v === null) continue;
      const r = v as Record<string, unknown>;
      if (typeof r.id !== 'string' || typeof r.agent !== 'string' || typeof r.state !== 'string' || !STATES.includes(r.state)) continue;
      const by = readBy(r.by);
      out.push({
        id: r.id,
        agent: r.agent,
        departmentId: typeof r.departmentId === 'string' ? r.departmentId : null,
        name: typeof r.name === 'string' ? r.name : r.agent,
        description: typeof r.description === 'string' ? r.description : '',
        background: r.background === true,
        state: r.state === 'running' ? 'unknown' : (r.state as DispatchState),
        startedAt: typeof r.startedAt === 'string' ? r.startedAt : new Date(0).toISOString(),
        lastActivityAt: typeof r.lastActivityAt === 'string' ? r.lastActivityAt : typeof r.startedAt === 'string' ? r.startedAt : new Date(0).toISOString(),
        endedAt: r.state !== 'running' && typeof r.endedAt === 'string' ? r.endedAt : null,
        ...(typeof r.agentId === 'string' && r.agentId ? { agentId: r.agentId } : {}),
        ...(by ? { by } : {}),
      });
    }
    out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    while (out.length > MAX_ENTRIES) {
      const i = out.findIndex((x) => x.state !== 'running');
      out.splice(i >= 0 ? i : 0, 1);
    }
    return out;
  }
}

const cleanDescription = (v: string): string => v.replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION);
const taskKey = (thread: string, taskId: string): string => `${thread}\u0000${taskId}`;
const threadOf = (x: Pick<Dispatch, 'by'>): string => (x.by ? x.by.threadId : COS);

/** The `by` of a saved dispatch; undefined when absent or malformed. */
function readBy(v: unknown): DispatchBy | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r.threadId !== 'string' || !r.threadId || typeof r.name !== 'string') return undefined;
  if (r.departmentId !== null && typeof r.departmentId !== 'string') return undefined;
  return { threadId: r.threadId, departmentId: r.departmentId, name: r.name };
}

/** completed -> done; killed, stopped, cancelled -> stopped; failed, error -> failed (the parser passes only final statuses). */
function mapStatus(status: string): 'done' | 'failed' | 'stopped' {
  const s = status.trim().toLowerCase();
  if (s === 'completed') return 'done';
  if (s === 'killed' || s === 'stopped' || s === 'cancelled' || s === 'canceled') return 'stopped';
  return 'failed';
}
