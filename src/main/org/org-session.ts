// Supervisor for one org: the CoS thread, department tabs, the handoff queue. Each org has its own processes
// and files; nothing is shared between orgs except the app's permission broker (which keys every request by thread).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ClaudeSession } from '../claude/session';
import { buildClaudeArgs } from '../claude/args';
import { artifactEnv } from '../claude/artifacts';
import { SessionStore } from '../claude/session-store';
import { FileStore } from '../claude/file-store';
import { referencedFileIds, sweepFiles } from '../claude/file-cleanup';
import { ImageStore } from '../claude/image-store';
import { inlinePdfIndexes, messageWithFiles } from '../../shared/attachments';
import { IMAGE_GRACE_MS, referencedImageIds, sweepImages, visibleLogFiles } from '../claude/image-cleanup';
import type { PermissionBroker } from '../claude/permissions';
import { loadHq } from '../hq/read';
import { departmentModel, parseOrgYaml } from '../hq/parse';
import { coversPermissionPrompt, mcpLaunch, serverBlock } from '../hq/forbidden-connectors';
import { agentToolsLine } from '../hq/connectors';
import { agentEffort } from '../hq/agent-effort';
import { sessionDeny } from '../claude/session-deny';
import { ALLOWED_TOOLS, DEV } from '../config';
import { anchorPathRule, filterHqAllowRules, isDenied, readHqPermissionRules } from '../claude/rules';
import { commandProblem, startUserCommand, type CommandProblem, type RunningUserCommand } from '../system/user-command';
import { childEnv, type Spawner } from '../system/exec';
import { Thread, type TurnResult } from './thread';
import { DispatchTracker } from './dispatches';
import type { RunningItem } from './run-guard';
import { ThreadRunStore, resolveRun } from './thread-run';
import { EFFORTS, isModel } from '../settings';
import { changedSince, findInboxNote, inboxSnapshot, noteTitle, ownInboxNote, ownsNote, turnWrittenNotes, writtenSince, type NoteOwner } from './handoff';
import { readInboxNotes, type InboxNote } from '../hq/inbox';
import { t } from '../../shared/strings';
import { buildOrgChartLive, HANDOFF_TAG } from '../../shared/org-chart-live';
import { isSpecificModel } from '../../shared/model-label';
import type { RateLimitInfo } from '../../shared/usage';
import type { AppEvent, Department, Dispatch, DispatchBy, DocumentAttachment, FileAttachment, ImageAttachment, InboxPendingNote, LoadedConnector, McpLockReason, OrgChartLive, EffortLevel, OrgId, PermissionMode, Settings, TabInfo, ThreadId, ThreadInfo, ThreadState } from '../../shared/types';

export interface OrgSessionDeps {
  claudePath: () => string | null;
  /** How the chats' processes are started (default: `spawnProcess`; the app passes one that records them in the process ledger). */
  spawner?: Spawner;
  /** This org's settings (permission mode, effort, CoS model). */
  settings: () => Settings;
  /** Deny rules from the user's own Claude Code settings, already anchored (default: none). */
  userDeny?: () => string[];
  /** The user's own artifact switches (`SettingsStore.userArtifactSettings()`), read at each process start (default: none). */
  userArtifactSettings?: () => unknown;
  broker: PermissionBroker;
  /** Grace period of the image clean-up in ms (default 10 minutes; tests). */
  imageGraceMs?: number;
  /** Bundled MCP permission server and the Node runtime that runs it (Electron as Node). */
  serverScript: string;
  nodePath: string;
  /** Reason sessions may not start, or null. */
  canStart: () => string | null;
  emit: (e: AppEvent) => void;
  /** Called when a department hands over (for a desktop notification). */
  onHandoff?: (orgId: OrgId, persona: string) => void;
  /** Called when a chat gets a reply of Claude Code's own while idle (a background task finished; for a notice). */
  onIdleAside?: (orgId: OrgId, speaker: string) => void;
  /** Remembers the model ids seen in init messages (default: none). */
  seenModels?: { list(): string[]; add(id: string): void };
  /** How long restartSessions waits for a turn to finish before it stops the chat anyway (default 120 s). */
  restartWaitMs?: number;
  /** The chief of staff's dispatches changed (the whole list). */
  onDispatches?: (list: Dispatch[]) => void;
  /** A department's dispatch ended (done, failed or stopped). */
  onDispatchEnded?: (d: Dispatch) => void;
  /** Running work may have changed: a dispatch, or the chief of staff thread's busy state (the run guard looks again). */
  onRunningChange?: () => void;
  /** Starts a "!" command in `cwd` (default: `startUserCommand`; tests). */
  startCommand?: (command: string, cwd: string) => RunningUserCommand;
  /** Plan usage reported by any chat of the org. */
  onRateLimit?: (info: RateLimitInfo) => void;
  /** Inactivity in ms after which the chief of staff starts a new session (0: never; default 30 minutes). */
  newSessionAfterMs?: () => number;
  /** Context size (tokens) at which the chief of staff continues in a new session (0: never; default 100000). */
  renewSessionAtTokens?: () => number;
  /** How long a hand-over waits for a department's background work to write its note before it gives up, in ms (default 5 minutes; tests). */
  handoverWaitMs?: number;
  /** How often a hand-over that waits for background work looks for the note again, in ms (default 1 s; tests). */
  handoverPollMs?: number;
}

/** What the confirmation of a "!" command shows: the exact command, the folder and the deny rule that covers it, if any. */
export interface CommandConfirm {
  command: string;
  folder: string;
  speaker: string;
  deniedBy: string | null;
}

interface RunInfo {
  model: string | null;
  effort: EffortLevel;
}

/** The rules passed to a process on the command line. */
interface RuleLists {
  allow: string[];
  deny: string[];
}

/** The MCP side of a process start: the "MCP lock" (`--strict-mcp-config`, claude.ai off) and the server names kept from starting. */
interface McpState {
  locked: boolean;
  keptOut: string[];
}

const RESTART_WAIT_MS = 120_000;

export const threadKey = (orgId: OrgId, threadId: ThreadId) => `${orgId}|${threadId}`;

export class OrgSession {
  readonly cos: Thread;
  private readonly tabs = new Map<string, Thread>();
  private records: TabInfo[];
  private readonly sessions: SessionStore;
  private readonly tabsFile: string;
  /** Model, effort, permission mode and rule lists each thread's latest process was started with, by thread id. */
  private readonly runs = new Map<string, RunInfo & McpState & { rules: RuleLists; permissionMode: PermissionMode }>();
  /** The user's model and effort choice per chat. */
  private readonly choices: ThreadRunStore;
  /** The Agent calls of the chief of staff and of the department chats (each item belongs to its thread). */
  private readonly tracker: DispatchTracker;
  /** The images sent with messages, kept once each under <dataDir>/images (the thread log holds only their ids). */
  private readonly images: ImageStore;
  /** The other files sent with messages, kept once each under <dataDir>/files (the agent opens the copies by path; the thread log holds only their ids). */
  private readonly files: FileStore;
  /** The inbox/ snapshot (name to mtime) taken when each department chat's latest turn started, by tab id. */
  private readonly turnInbox = new Map<string, Map<string, number>>();
  /** The poll timer of each hand-over that waits for background work, by tab id. */
  private readonly handoverTimers = new Map<string, NodeJS.Timeout>();
  /** Chats being ended: stopAll waits for their processes to exit. */
  private readonly ending = new Set<Promise<void>>();
  /** The image clean-up in progress or last done (they run one after the other). */
  private sweeping: Promise<void> = Promise.resolve();

  constructor(
    readonly orgId: OrgId,
    readonly hqPath: string,
    private readonly dataDir: string,
    private readonly deps: OrgSessionDeps,
  ) {
    fs.mkdirSync(path.join(dataDir, 'tabs'), { recursive: true });
    this.sessions = new SessionStore(path.join(dataDir, 'sessions.json'));
    this.tabsFile = path.join(dataDir, 'tabs.json');
    this.choices = new ThreadRunStore(dataDir);
    this.images = new ImageStore(path.join(dataDir, 'images'));
    this.files = new FileStore(path.join(dataDir, 'files'));
    this.records = readTabs(this.tabsFile);
    this.tracker = new DispatchTracker({
      file: path.join(dataDir, 'dispatches.json'),
      departments: () => this.departments().map((d) => ({ id: d.id, agent: d.agent, persona: d.persona })),
      onChange: (list) => {
        deps.onDispatches?.(list);
        deps.onRunningChange?.();
      },
      onEnded: (d) => deps.onDispatchEnded?.(d),
    });
    // A chat the user closed under the old "hide" behaviour is over: closed for good. Open chats a crash left stay open: they continue on the next message.
    if (this.migrateHidden()) this.trySaveTabs();
    const cosName = this.cosName();
    this.cos = new Thread({
      orgId,
      threadId: 'cos',
      title: `${cosName} (${t('cos.role')})`,
      speaker: cosName,
      cwd: this.hqPath,
      logFile: path.join(dataDir, 'cos.jsonl'),
      makeSession: (resumeId) => this.makeSession('cos', resumeId, null),
      sessions: {
        get: () => this.sessions.get('cos'),
        set: (id, day) => this.sessions.set('cos', id, day),
        clear: () => this.sessions.set('cos', '', ''),
      },
      // The thread stays one thread, the Claude Code session behind it is not resumed across runs.
      fresh: { idleMs: () => this.deps.newSessionAfterMs?.() ?? 30 * 60_000, sizeTokens: () => this.deps.renewSessionAtTokens?.() ?? 100_000 },
      canStart: deps.canStart,
      runInfo: () => ({ ...this.runInfo('cos', null), inbox: this.inboxPending() }),
      onModelSeen: (m) => this.deps.seenModels?.add(m),
      onIdleAside: () => this.deps.onIdleAside?.(orgId, cosName),
      onRateLimit: (info) => this.deps.onRateLimit?.(info),
      needsRestart: () => this.runPending('cos', null),
      onStream: (ev) => this.tracker.handle(ev),
      onSessionExit: () => this.tracker.sessionExited('cos'),
      // A background agent lives in the process (or its report is still to come): a quiet restart (a new session, changed model or rules) waits until it ends.
      holdRestart: () => this.tracker.hasRunningBackground('cos') || this.cos.awaitingReport,
      onBusyChange: () => deps.onRunningChange?.(),
      onConnectors: () => deps.emit({ type: 'connectors', orgId }),
      emit: deps.emit,
    });
    void this.cleanImages();
  }

  /**
   * Deletes the stored images and files that no visible thread (the chief of staff's, or an open department chat) references and
   * that are older than the grace period. Runs in the background, one at a time, and never throws: a failure is logged.
   * Resolves when this run is done (tests wait for it).
   */
  cleanImages(): Promise<void> {
    const run = this.sweeping.then(async () => {
      try {
        const graceMs = this.deps.imageGraceMs ?? IMAGE_GRACE_MS;
        const logs = async () => visibleLogFiles(this.dataDir, new Set(this.records.filter((r) => r.status === 'closed').map((r) => r.tabId)));
        await sweepImages(path.join(this.dataDir, 'images'), async () => referencedImageIds(await logs()), { graceMs, isInUse: (id) => this.images.usedWithin(id, graceMs) });
        await sweepFiles(this.files.dir, async () => referencedFileIds(await logs()), { graceMs, isInUse: (id) => this.files.usedWithin(id, graceMs) });
      } catch (e) {
        console.error('could not clean up the stored images', e);
      }
    });
    this.sweeping = run;
    return run;
  }

  /** The chief of staff's dispatches: running ones and ended ones the user has not seen yet. */
  dispatches(): Dispatch[] {
    return this.tracker.list();
  }

  ackDispatches(ids: string[]): void {
    this.tracker.ack(ids);
  }

  // ---------- running work (for the run guard) ----------

  /** What runs now: each running dispatch (the chief of staff's and the department chats'), and one item while the chief of staff is replying (or about to report). */
  runningItems(orgName: string): RunningItem[] {
    const items: RunningItem[] = this.tracker.running().map((d) => ({ orgId: this.orgId, orgName, who: d.name, what: d.description, startedAt: d.startedAt, kind: 'dispatch' }));
    if (this.cos.busy || this.cos.awaitingReport) {
      items.push({ orgId: this.orgId, orgName, who: this.cos.speaker, what: t('guard.what.replying'), startedAt: this.cos.turnStartedAt ?? new Date().toISOString(), kind: 'cos-turn' });
    }
    return items;
  }

  /**
   * Stops what runs, for an action the user confirmed (`actionLabel`: "Update", "Quit", ...): running dispatches become
   * `stopped`, a "was stopped by" line per item goes into the chief of staff thread (a file: it shows at the next start
   * after a quit too), then the chief of staff process ends now, with the messages it had not answered.
   */
  async forceStop(actionLabel: string): Promise<void> {
    const cosBusy = this.cos.busy || this.cos.awaitingReport;
    const stopped = this.tracker.stopRunning();
    // A dispatch of a department chat gets its line in that chat's thread, and the chat's process ends once.
    const tabs = new Set<Thread>();
    for (const d of stopped) {
      const th = d.by ? this.tabs.get(d.by.threadId.slice('tab:'.length)) : this.cos;
      if (!th) continue; // its chat is gone
      if (th !== this.cos) tabs.add(th);
      th.append('system', '', t(d.description ? 'guard.stopped.dispatch' : 'guard.stopped.dispatchBare', { persona: d.name, description: d.description, action: actionLabel }));
    }
    if (cosBusy) this.cos.append('system', '', t('guard.stopped.cos', { cosName: this.cos.speaker, action: actionLabel }));
    await Promise.all([this.cos.interrupt(), ...[...tabs].map((th) => th.interrupt())]);
  }

  /** Writes a system line in the chief of staff thread (an action waits for the work to end). */
  noteInCos(text: string): void {
    this.cos.append('system', '', text);
  }

  cosName(): string {
    return loadHq(this.hqPath).org.cosName;
  }

  departments(): Department[] {
    return loadHq(this.hqPath).departments;
  }

  /** Live status for the org chart: the CoS thread and the open chats, from what this session already holds. */
  chartLive(departments: Array<{ id: string; agent: string }>): OrgChartLive {
    return buildOrgChartLive(departments, this.records, (id) => (id === 'cos' ? this.cos : this.tabs.get(id.slice(4))));
  }

  /**
   * The connectors the live chats of this org report in their init messages (memory only), per server name: the status
   * (when chats disagree: failed, then needs-auth, then pending, then connected), the scope, the chats that loaded it and how
   * `deny` (the deny rules a process gets now) cuts its tools. `started`: some chat has had an init, so the list is real.
   */
  loadedConnectors(deny: readonly string[]): { started: boolean; loaded: LoadedConnector[] } {
    const threads: Array<[string, Thread]> = [[this.cos.speaker, this.cos]];
    for (const rec of this.records) {
      const th = this.tabs.get(rec.tabId);
      if (th && rec.status !== 'closed') threads.push([rec.persona, th]);
    }
    const byName = new Map<string, LoadedConnector>();
    for (const [label, th] of threads) {
      for (const m of th.connectors) {
        const old = byName.get(m.name);
        if (!old) {
          byName.set(m.name, { name: m.name, status: m.status, source: m.source, chats: [label], block: serverBlock(m.name, deny) });
          continue;
        }
        if (!old.chats.includes(label)) old.chats.push(label);
        if (statusRank(m.status) < statusRank(old.status)) old.status = m.status;
        if (old.source === null) old.source = m.source;
      }
    }
    return { started: threads.some(([, th]) => th.hadInit), loaded: [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) };
  }

  /** Refreshes the CoS name after org.yaml changes. */
  refreshNames(): void {
    const n = this.cosName();
    this.cos.speaker = n;
    this.cos.title = `${n} (${t('cos.role')})`;
    this.inboxDepartments = null;
  }

  // ---------- threads ----------

  thread(threadId: ThreadId): Thread | null {
    if (threadId === 'cos') return this.cos;
    const tabId = threadId.slice(4);
    return this.tabThread(tabId);
  }

  getThread(threadId: ThreadId): ThreadInfo | null {
    return this.thread(threadId)?.info() ?? null;
  }

  /**
   * `tag` comes back in `TurnResult.sent` when the turn that handles this message ends. `images` must already be
   * validated (`checkImages`); each is stored once and the thread entry keeps only its id. `files` (validated with
   * `checkFiles`) are stored once each too; Claude Code gets the text with a note that gives the path of each copy
   * (`messageWithFiles`), the thread entry shows the text as typed plus the file chips.
   */
  send(threadId: ThreadId, text: string, tag?: string, images: ImageAttachment[] = [], files: FileAttachment[] = []): void {
    const th = this.thread(threadId);
    if (!th) throw new Error('Unknown conversation.');
    const refs = images.map((img) => this.images.put(img));
    const placed = files.map((f) => this.files.put(f));
    // Eligible PDFs also go inline as document blocks; the stored copy and its path stay in the note either way.
    const inline = inlinePdfIndexes(files);
    const documents: DocumentAttachment[] = files.flatMap((f, i) => (inline.has(i) ? [{ title: placed[i].ref.name, data: Buffer.from(f.data.buffer, f.data.byteOffset, f.data.byteLength).toString('base64') }] : []));
    th.enqueue(text, 'user', { kind: 'user', author: t('you'), text }, tag, images.length ? { send: images, refs } : undefined, placed.length ? { refs: placed.map((p) => p.ref), wire: messageWithFiles(text, placed.map((p, i) => ({ ref: p.ref, path: p.path, inline: inline.has(i) }))), documents } : undefined);
  }

  /**
   * Runs a command the user typed after "!" in this chat, as the user, in the hq folder: never anywhere else, whatever
   * the renderer sends. Refused (thrown) when empty, too long, holding characters the confirmation would not show, or
   * while another command of this chat runs; then `confirm` must say yes (a native dialog that shows the exact command).
   * Returns false when the user declined.
   */
  async runCommand(threadId: ThreadId, command: string, confirm: (c: CommandConfirm) => Promise<boolean>): Promise<boolean> {
    const th = this.thread(threadId);
    if (!th) throw new Error('Unknown conversation.');
    const problem: CommandProblem | 'busy' | null = commandProblem(command) ?? (th.commandRunning ? 'busy' : null);
    if (problem) throw new Error(t(`command.problem.${problem}`));
    const deny = [...readHqPermissionRules(this.hqPath).deny, ...(this.deps.userDeny?.() ?? [])];
    const deniedBy = isDenied(deny, 'Bash', { command }, this.hqPath);
    if (!(await confirm({ command, folder: this.hqPath, speaker: th.speaker, deniedBy }))) return false;
    // The chat may have closed, or another command started, while the dialog was open.
    if (this.thread(threadId) !== th || th.commandRunning) return false;
    const run = (this.deps.startCommand ?? ((c, cwd) => startUserCommand(c, { cwd })))(command, this.hqPath);
    th.trackCommand(command, run);
    return true;
  }

  /** Chat > New Session: the chief of staff's next message sent from idle starts a new Claude Code session. False when one is already requested. */
  newCosSession(): boolean {
    return this.cos.requestNewSession();
  }

  /** Stops a running "!" command of this chat. */
  cancelCommand(threadId: ThreadId, id: string): void {
    this.thread(threadId)?.cancelCommand(id);
  }

  /** An image of a thread entry as a data: URL, or null (see ImageStore.get). */
  getImage(id: string): string | null {
    return this.images.get(id);
  }

  // ---------- department tabs ----------

  listTabs(): TabInfo[] {
    return this.records.map((r) => ({ ...r }));
  }

  /** True while a turn of the department chat runs (false for a chat with no live thread). */
  isTabBusy(tabId: string): boolean {
    return this.tabs.get(tabId)?.busy ?? false;
  }

  /** Starts a chat with a department, or returns the one already open (or handing over): one open chat per department. */
  startTab(agent: string): TabInfo {
    const dep = this.departments().find((d) => d.agent === agent);
    if (!dep) throw new Error(`No department with agent "${agent}" in this org.`);
    const existing = this.records.find((r) => r.agent === dep.agent && (r.status === 'open' || r.status === 'handing-over'));
    if (existing) {
      this.tabThread(existing.tabId);
      return { ...existing };
    }
    const rec: TabInfo = {
      tabId: crypto.randomBytes(6).toString('hex'),
      orgId: this.orgId,
      agent: dep.agent,
      persona: dep.persona,
      role: dep.role,
      status: 'open',
      openedAt: new Date().toISOString(),
      closedAt: null,
      notePath: null,
      pendingWork: false,
    };
    this.records.push(rec);
    this.saveTabs();
    this.tabThread(rec.tabId);
    return { ...rec };
  }

  async handOver(tabId: string): Promise<void> {
    const rec = this.records.find((r) => r.tabId === tabId);
    const th = this.tabThread(tabId);
    if (!rec || !th || rec.status !== 'open') throw new Error('This chat is not open.');
    // The move to handing-over must be saved: a tabs.json write error here must not leave the tab stuck (no x, close busy),
    // so the status goes back to open and the error is thrown (the hand-over does not start).
    rec.status = 'handing-over';
    try {
      this.saveTabs();
    } catch (e) {
      rec.status = 'open';
      throw e;
    }
    this.deps.emit({ type: 'tabs', orgId: this.orgId, tabs: this.listTabs() });
    this.cos.refreshState();
    const text = t('dept.msg.handOver', { cosName: this.cosName() });
    // The note counts when this chat wrote it itself in the handover turn (ownInboxNote), or else when a note in inbox/ is
    // from this department (its `from`), was written since the chat opened and is not another chat's (detectNote): the
    // department often has a worker write it, in the foreground, in the background (the turn ends first) or with Bash,
    // or wrote it earlier in the chat. With background work still running the hand-over waits for it, bounded.
    const listener = (r: TurnResult) => {
      if (!r.sent.some((m) => m.tag === 'handover')) return;
      th.offTurnEnd(listener);
      if (rec.status !== 'handing-over') return;
      const note = r.notStarted ? null : this.detectNote(rec, r, 'chat');
      if (note) {
        rec.notePath = note.path;
        this.markEarlier(rec, note.earlier);
        rec.pendingWork = false;
        void this.endTab(rec, th, true);
      } else if (r.notStarted || !this.workRunning(tabId, th)) {
        this.failHandOver(rec, th);
      } else {
        this.waitForNote(rec, th);
      }
    };
    // The listener goes first: a turn that cannot start ends (failed) inside enqueue.
    th.onTurnEnd(listener);
    th.enqueue(text, 'user', { kind: 'user', author: t('you'), text }, 'handover');
  }

  /** A hand-over found no note: the chat goes back to open, with an error line that offers to ask the department for it. */
  private failHandOver(rec: TabInfo, th: Thread): void {
    this.setStatus(rec, 'open');
    th.append('error', '', t('dept.noNote', { persona: rec.persona }), { action: 'askNote' });
  }

  /**
   * The handover turn ended with no note, but background work of the chat still runs (or its report is pending): says so
   * once, then looks for the note every `handoverPollMs` until it is there (hand over), nothing runs any more (one last
   * look on the next tick, then fail) or `handoverWaitMs` is over (fail). Stops when the chat is no longer handing over.
   */
  private waitForNote(rec: TabInfo, th: Thread): void {
    th.append('system', '', t('dept.waitingForWorkers', { persona: rec.persona }));
    const pollMs = this.deps.handoverPollMs ?? 1000;
    const waitMs = this.deps.handoverWaitMs ?? 300_000;
    const started = Date.now();
    let lastLook = false;
    const schedule = () => {
      const h = setTimeout(tick, pollMs);
      h.unref?.();
      this.handoverTimers.set(rec.tabId, h);
    };
    const tick = () => {
      this.handoverTimers.delete(rec.tabId);
      if (rec.status !== 'handing-over') return;
      const note = this.detectNote(rec, null, 'chat');
      if (note) {
        rec.notePath = note.path;
        this.markEarlier(rec, note.earlier);
        rec.pendingWork = false;
        void this.endTab(rec, th, true);
        return;
      }
      if (Date.now() - started >= waitMs) return this.failHandOver(rec, th);
      if (this.workRunning(rec.tabId, th) || th.busy) lastLook = false;
      else if (lastLook) return this.failHandOver(rec, th);
      else lastLook = true;
      schedule();
    };
    schedule();
  }

  /** True while a background agent of the chat runs in its process, or its report is still to come. */
  private workRunning(tabId: string, th: Thread): boolean {
    return this.tracker.hasRunningBackground(`tab:${tabId}`) || th.awaitingReport;
  }

  /**
   * Ends an open department chat for good: its process is killed, its session forgotten, and nothing can reopen or read it.
   * When the chat wrote a note on its own, the chief of staff gets it now, so "handed over" always means the CoS has it.
   * `passNote: false` ends it without starting a CoS turn (the quit's clean-up: the note stays in inbox/ for the next session).
   * Rejects a chat that is handing over (the hand-over ends it).
   */
  async closeTab(tabId: string, opts: { passNote?: boolean } = {}): Promise<void> {
    const rec = this.records.find((r) => r.tabId === tabId);
    if (!rec) throw new Error('Unknown chat.');
    if (rec.status === 'handing-over') throw new Error(t('tab.closeBusyHandover'));
    if (rec.status !== 'open') throw new Error('This chat is not open.');
    // The note counts only while it is still there: a note someone deleted is not passed on.
    const passNote = opts.passNote !== false && !!rec.notePath && fs.existsSync(path.join(this.hqPath, rec.notePath));
    await this.endTab(rec, this.tabs.get(tabId) ?? null, passNote);
  }

  /** The one way a department chat ends (close and hand-over alike). Returns when its process has exited. */
  private endTab(rec: TabInfo, th: Thread | null, passNote: boolean): Promise<void> {
    const key: ThreadId = `tab:${rec.tabId}`;
    // The process goes first: a failing write below must never leave it running. A turn in flight is cut off at once
    // (SIGTERM, then SIGKILL); an idle process just gets its stdin closed.
    const stopped = th ? th.dispose(th.busy ? 0 : undefined) : Promise.resolve();
    const done = stopped.then(() => this.forgetSession(key));
    this.ending.add(done);
    void done.finally(() => this.ending.delete(done));
    rec.status = 'closed';
    rec.closedAt = new Date().toISOString();
    this.tabs.delete(rec.tabId);
    this.tracker.dropThread(key); // what still ran in it is stopped, and nothing shows it now the chat is gone
    this.turnInbox.delete(rec.tabId);
    const timer = this.handoverTimers.get(rec.tabId);
    if (timer) clearTimeout(timer);
    this.handoverTimers.delete(rec.tabId);
    this.deps.broker.unregister(threadKey(this.orgId, key));
    this.forgetSession(key);
    this.trySaveTabs();
    this.deps.emit({ type: 'tabs', orgId: this.orgId, tabs: this.listTabs() });
    this.deps.emit({ type: 'connectors', orgId: this.orgId }); // its connectors are gone from the list
    if (passNote && rec.notePath) this.passToCos(rec, rec.notePath);
    this.cos.refreshState(); // its note is no longer an open chat's: it is queued, or waits in inbox/
    void this.cleanImages(); // the closed chat's log no longer counts
    return done;
  }

  private forgetSession(key: ThreadId): void {
    try {
      this.sessions.remove(key);
    } catch (e) {
      console.error('could not clear the session id', e);
    }
  }

  /** Gives the chief of staff the note of a department chat, with the handoff card (and the desktop notification). */
  private passToCos(rec: TabInfo, notePath: string): void {
    let note = '';
    try {
      note = fs.readFileSync(path.join(this.hqPath, notePath), 'utf8');
    } catch {
      note = '';
    }
    const title = noteTitle(note, notePath);
    this.cos.enqueue(
      t('cos.msg.handoff', { persona: rec.persona, role: rec.role, notePath, note: note.trim() }),
      'handoff',
      { kind: 'handoff', author: rec.persona, text: t('thread.handoffCard', { persona: rec.persona, title }), earlierNote: this.earlierNotes.has(rec.tabId) },
      `${HANDOFF_TAG}${rec.tabId}`,
    );
    this.deps.onHandoff?.(this.orgId, rec.persona);
  }

  /** Sets a status that is not the start of a hand-over. A failing write is logged: memory and the UI stay right, so the tab is never stuck. */
  private setStatus(rec: TabInfo, status: TabInfo['status']): void {
    rec.status = status;
    this.trySaveTabs();
    this.deps.emit({ type: 'tabs', orgId: this.orgId, tabs: this.listTabs() });
    this.cos.refreshState();
  }

  /** Sets or clears the note that makes a chat count as handed over (saved, tabs event) when it changes. */
  private setNote(rec: TabInfo, notePath: string | null): void {
    if (rec.notePath === notePath) return;
    rec.notePath = notePath;
    this.earlierNotes.delete(rec.tabId);
    this.trySaveTabs();
    this.deps.emit({ type: 'tabs', orgId: this.orgId, tabs: this.listTabs() });
    this.cos.refreshState();
  }

  /** Sets whether the chat did work since it opened or since its last handoff note (saved, tabs event) when it changes. */
  private setPendingWork(rec: TabInfo, pendingWork: boolean): void {
    if (rec.pendingWork === pendingWork) return;
    rec.pendingWork = pendingWork;
    this.trySaveTabs();
    this.deps.emit({ type: 'tabs', orgId: this.orgId, tabs: this.listTabs() });
  }

  /** The inbox/ notes read from disk and the departments of org.yaml (both cached until `refreshInbox` or `refreshNames`); null before the first read. */
  private inboxCache: InboxNote[] | null = null;
  private inboxDepartments: Department[] | null = null;

  /** The inbox/ changed: read it again and tell the renderer the CoS chat's state. */
  refreshInbox(): void {
    this.inboxCache = null;
    this.inboxDepartments = null;
    this.cos.refreshState();
  }

  /**
   * The notes that wait for the chief of staff: those in inbox/ except the notes that an open or handing-over chat owns
   * (it may still be writing one, or hand over) and of handoffs queued in the CoS thread. A chat owns the notes of its
   * department (ownsNote), not only the one it has already found. The name is the persona of the department that owns the note.
   */
  private inboxPending(): InboxPendingNote[] {
    this.inboxCache ??= readInboxNotes(this.hqPath, ['cos', this.cosName()]);
    this.inboxDepartments ??= this.departments();
    const deps = this.inboxDepartments;
    const live = this.records.filter((r) => r.status === 'open' || r.status === 'handing-over');
    const owners = live.map((r) => this.noteOwnerIn(r, deps));
    const skip = new Set<string>();
    for (const r of live) if (r.notePath) skip.add(r.notePath);
    const queued = new Set(this.cos.handoffTabs);
    for (const r of this.records) if (r.notePath && queued.has(r.tabId)) skip.add(r.notePath);
    const out: InboxPendingNote[] = [];
    for (const n of this.inboxCache) {
      if (skip.has(n.path)) continue;
      const fileName = path.basename(n.path);
      if (owners.some((o) => ownsNote(o, n.from, fileName))) continue;
      const dep = deps.find((d) => ownsNote({ id: d.id, agent: d.agent, persona: d.persona }, n.from, fileName));
      out.push({ path: n.path, name: dep?.persona ?? n.from });
    }
    return out;
  }

  /** Who a chat's notes are from: its department id (null when org.yaml no longer lists it), agent and persona. */
  private noteOwner(rec: TabInfo): NoteOwner {
    return this.noteOwnerIn(rec, this.departments());
  }

  private noteOwnerIn(rec: TabInfo, deps: Department[]): NoteOwner {
    const dep = deps.find((d) => d.agent === rec.agent);
    return { id: dep?.id ?? null, agent: rec.agent, persona: rec.persona };
  }

  /** Tabs whose note was found in chat scope and was written before the handover turn: the card says "taken from an earlier note". */
  private readonly earlierNotes = new Set<string>();

  private markEarlier(rec: TabInfo, earlier: boolean): void {
    if (earlier) this.earlierNotes.add(rec.tabId);
    else this.earlierNotes.delete(rec.tabId);
  }

  /** The notes of the other chats of the org, any status: one chat never takes another's note. */
  private claimedNotes(rec: TabInfo): Set<string> {
    return new Set(this.records.filter((r) => r.tabId !== rec.tabId && r.notePath).map((r) => r.notePath!));
  }

  /**
   * The note of a department chat (`path`, relative to the hq; `earlier`: written before the turn started), or null. Only
   * notes addressed to the chief of staff count (`to`). First the note the chat wrote itself in the turn (`r`: a
   * successful Write, Edit or MultiEdit of `inbox/<name>.md`, ownInboxNote: certain). Else the newest note in inbox/ that
   * is from this department (`from`, or the file name when there is none), not another chat's, and either (`turn`, after
   * every turn) one that a tool call of this chat or of its sub-agents wrote in the turn (turnWrittenNotes: a note
   * another run wrote meanwhile never counts) or (`chat`, a hand-over) one written since the chat opened, whoever wrote
   * it, also earlier in the chat. Never the reply text.
   */
  private detectNote(rec: TabInfo, r: TurnResult | null, scope: 'turn' | 'chat'): { path: string; earlier: boolean } | null {
    const snap = this.turnInbox.get(rec.tabId) ?? new Map<string, number>();
    const cos = ['cos', this.cosName()];
    if (r) {
      const own = ownInboxNote(this.hqPath, r.tools, snap, cos);
      if (own) return { path: own, earlier: false };
    }
    const opened = Date.parse(rec.openedAt);
    let candidate: (name: string, mtimeMs: number) => boolean;
    if (scope === 'chat') candidate = !Number.isNaN(opened) ? writtenSince(opened) : changedSince(snap);
    else {
      const mine = r ? turnWrittenNotes(this.hqPath, r.tools, r.subTools ?? []) : new Set<string>();
      const changed = changedSince(snap);
      candidate = (name, mtime) => mine.has(path.join('inbox', name)) && changed(name, mtime);
    }
    const found = findInboxNote(this.hqPath, this.noteOwner(rec), candidate, this.claimedNotes(rec), cos);
    if (!found) return null;
    let earlier = false;
    if (scope === 'chat') {
      try {
        earlier = !changedSince(snap)(path.basename(found), fs.statSync(path.join(this.hqPath, found)).mtimeMs);
      } catch {
        earlier = false;
      }
    }
    return { path: found, earlier };
  }

  /**
   * A turn start takes the inbox snapshot and clears the note: a chat that works again is not handed over any more, so
   * closing asks again. A turn end sets the note to the one found for that turn (detectNote, scope `turn`), or leaves
   * it cleared. A turn that never started, or the hand-over turn, changes nothing. A turn that found a note clears
   * `pendingWork` (and says so in the chat); else a turn that used a tool sets it; a text-only turn leaves it. See closeTab, which passes the note on.
   */
  private noteOwnInbox(rec: TabInfo, r: TurnResult): void {
    if (rec.status === 'closed' || r.notStarted || r.sent.some((m) => m.tag === 'handover')) return;
    const note = this.detectNote(rec, r, 'turn')?.path ?? null;
    this.setNote(rec, note);
    if (note) {
      this.setPendingWork(rec, false);
      this.tabs.get(rec.tabId)?.append('system', '', t('dept.handoffAlreadyDone', { name: path.basename(note) }));
    } else if (r.tools.length > 0 || (r.subTools?.length ?? 0) > 0) {
      this.setPendingWork(rec, true);
    }
  }

  /** The live thread of a department chat; null for an unknown or closed one (a closed chat leaves no trace). */
  private tabThread(tabId: string): Thread | null {
    const live = this.tabs.get(tabId);
    if (live) return live;
    const rec = this.records.find((r) => r.tabId === tabId);
    if (!rec || rec.status === 'closed') return null;
    const key: ThreadId = `tab:${tabId}`;
    // Who its dispatches belong to, read at the first event (the chat's agent as a department of the org).
    let owner: DispatchBy | undefined;
    const ownerOf = (): DispatchBy => (owner ??= { threadId: key, departmentId: this.departments().find((d) => d.agent === rec.agent)?.id ?? null, name: rec.persona });
    const th: Thread = new Thread({
      orgId: this.orgId,
      threadId: key,
      title: `${rec.persona} (${rec.role})`,
      speaker: rec.persona,
      cwd: this.hqPath,
      logFile: path.join(this.dataDir, 'tabs', `${tabId}.jsonl`),
      makeSession: (resumeId) => this.makeSession(key, resumeId, rec.agent),
      sessions: {
        get: () => this.sessions.get(key),
        set: (id, day) => this.sessions.set(key, id, day),
        clear: () => this.sessions.remove(key),
      },
      canStart: this.deps.canStart,
      runInfo: () => this.runInfo(key, rec.agent),
      onModelSeen: (m) => this.deps.seenModels?.add(m),
      onIdleAside: () => this.deps.onIdleAside?.(this.orgId, rec.persona),
      onRateLimit: (info) => this.deps.onRateLimit?.(info),
      needsRestart: () => this.runPending(key, rec.agent),
      // The chat's own sub-agents are tracked like the chief of staff's (a gone chat tracks nothing).
      onStream: (ev) => {
        if (rec.status !== 'closed') this.tracker.handle(ev, ownerOf());
      },
      onSessionExit: () => this.tracker.sessionExited(key),
      // Background sub-agents live in the process: a quiet restart (a changed model or rules) waits until they end.
      holdRestart: () => this.tracker.hasRunningBackground(key) || th.awaitingReport,
      onConnectors: () => this.deps.emit({ type: 'connectors', orgId: this.orgId }),
      emit: this.deps.emit,
    });
    th.onTurnStart(() => {
      this.turnInbox.set(tabId, inboxSnapshot(this.hqPath));
      if (rec.status !== 'closed') this.setNote(rec, null);
    });
    th.onTurnEnd((r) => this.noteOwnInbox(rec, r));
    // The first tool call of a turn already counts as work: a chat closed in its first tool turn still offers a handoff.
    th.onToolUse(() => {
      if (rec.status === 'open') this.setPendingWork(rec, true);
    });
    // A tab interrupted mid hand-over (app quit) goes back to open.
    if (rec.status === 'handing-over') {
      rec.status = 'open';
      this.trySaveTabs();
    }
    this.tabs.set(tabId, th);
    return th;
  }

  /** Records the old behaviour left hidden (closed by the user, session kept) become closed. Returns true when any changed. */
  private migrateHidden(): boolean {
    let changed = false;
    for (const rec of this.records as Array<TabInfo & { hidden?: boolean }>) {
      if (rec.hidden === undefined) continue;
      if (rec.hidden && rec.status === 'open') {
        rec.status = 'closed';
        rec.closedAt = new Date().toISOString();
      }
      delete rec.hidden;
      changed = true;
    }
    return changed;
  }

  /** saveTabs for the places where the in-memory state is what counts: a write error is logged, not thrown. */
  private trySaveTabs(): void {
    try {
      this.saveTabs();
    } catch (e) {
      console.error('could not save tabs.json', e);
    }
  }

  private saveTabs(): void {
    const tmp = `${this.tabsFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.records, null, 2) + '\n');
    fs.renameSync(tmp, this.tabsFile);
  }

  // ---------- processes ----------

  private makeSession(threadId: ThreadId, resumeId: string | null, agent: string | null): ClaudeSession {
    const claudePath = this.deps.claudePath();
    if (!claudePath) throw new Error(t('claude.missing'));
    const mcpConfigJson = this.deps.broker.register(threadKey(this.orgId, threadId), {
      serverScript: this.deps.serverScript,
      nodePath: this.deps.nodePath,
      cwd: this.hqPath,
    });
    const run = this.runFor(agent, threadId);
    const { forbidden, problems, locked, keptOut, toolsLock, ...rules } = this.ruleDetail(agent);
    // The MCP lock: a forbidden list that cannot be applied in full, or a department with no `tools:` line or one with a `*` entry, fails closed.
    if (locked) console.warn(`MCP locked in ${threadId}: ${problems.length > 0 ? problems.join('; ') : toolsLock === 'all-tools' ? 'the agent file gives every tool (a * entry in tools)' : 'the agent file has no tools line'}`);
    // A pattern such as mcp__* also denies the app's own permission tool: forbidden wins, and a denied prompt tool fails closed.
    if (coversPermissionPrompt(forbidden)) console.warn('a forbidden connector pattern also covers mcp__coa__permission_prompt: permission prompts are denied in this org');
    const permissionMode = this.deps.settings().permissionMode;
    this.runs.set(threadId, { ...run, rules, permissionMode, locked, keptOut });
    // No server definition of the user's goes on the command line: only deny rules, server names to keep out and the app's own server.
    // Locked: also `--strict-mcp-config` (only the app's own server loads, so the permission prompt tool still works) and claude.ai off.
    const launch = mcpLaunch(rules.deny, keptOut, locked);
    const args = buildClaudeArgs({
      permissionMode,
      mcpConfigJson,
      settingsJson: launch.settingsJson,
      strictMcp: locked,
      resumeSessionId: resumeId || null,
      agent,
      model: run.model,
      effort: run.effort,
      pluginDir: DEV.pluginDir,
      allowedTools: rules.allow,
      disallowedTools: rules.deny,
    });
    return new ClaudeSession({ claudePath, cwd: this.hqPath, args, spawner: this.deps.spawner, env: childEnv({ ...artifactEnv(this.deps.userArtifactSettings?.(), process.env), ...launch.env }) });
  }

  /**
   * The one read rule for the folder of the attached files: it lies in the app's data folder, outside the hq the chats
   * run in, so Claude Code would ask a card for every Read of it. Read only, that folder only (`//` = an absolute path, see `anchorPathRule`).
   * Writes and any other folder still go through the usual cards.
   */
  private attachmentsReadRule(): string {
    return `Read(/${this.files.dir.split(path.sep).join('/')}/**)`;
  }

  /**
   * The rules the next process would get: the plugin skill rule plus the hq's own allow rules that pass the strict filter (filterAllowRules), and the deny rules:
   * the hq's, the user's and the forbidden connectors' (`sessionDeny`). Path rules are anchored to the hq folder (see anchorPathRule). The app adds no baseline of its own.
   * Also the MCP state: `locked` when a forbidden list has a problem, or when a department (`agent`) has no `tools:` line in its agent file
   * (no line, an empty one, no agent file found or readable) or gives every tool with a `*` entry: without the lock Claude Code offers such an agent every tool of every loaded server.
   * The chief of staff has no agent file and is only locked by the forbidden lists.
   */
  private ruleDetail(agent: string | null): RuleLists & McpState & { forbidden: string[]; problems: string[]; toolsLock: McpLockReason | null } {
    const hq = readHqPermissionRules(this.hqPath);
    const allow = filterHqAllowRules(hq, this.hqPath).kept;
    const d = sessionDeny(this.hqPath, this.deps.userDeny?.() ?? []);
    const toolsLock = agent === null ? null : agentToolsLine(this.hqPath, agent).lock;
    return {
      allow: [...new Set([...ALLOWED_TOOLS, this.attachmentsReadRule(), ...allow.map((r) => anchorPathRule(r, this.hqPath))])],
      deny: d.deny,
      forbidden: d.forbidden,
      problems: d.problems,
      keptOut: d.keptOut,
      locked: d.problems.length > 0 || toolsLock !== null,
      toolsLock,
    };
  }

  /**
   * What "org default" means for a chat now: the CoS model and the org effort (settings), or for a department its model (org.yaml) and
   * the `effort:` of its agent file when it has a valid one, else the org effort; COA_MODEL wins. `effortFromAgent` tells the header which.
   */
  private orgDefaults(agent: string | null): RunInfo & { effortFromAgent: boolean } {
    const s = this.deps.settings();
    let model = s.cosModel;
    let effort = s.effort;
    let effortFromAgent = false;
    if (agent) {
      try {
        model = departmentModel(parseOrgYaml(fs.readFileSync(path.join(this.hqPath, 'org.yaml'), 'utf8')), agent);
      } catch {
        model = null;
      }
      const own = agentEffort(this.hqPath, agent);
      if (own) {
        effort = own;
        effortFromAgent = true;
      }
    }
    return { model: DEV.model || model, effort, effortFromAgent };
  }

  /** The model and effort the next process of this thread would use: its own choice, else the org default. */
  private runFor(agent: string | null, threadId: ThreadId): RunInfo {
    const d = this.orgDefaults(agent);
    return resolveRun({ choice: this.choices.get(threadId), orgModel: d.model, orgEffort: d.effort, devModel: DEV.model });
  }

  /**
   * True when the latest process of this thread was started with other values than the next one would get: model,
   * effort, the allow/deny lists, the MCP lock or the servers kept out (a rule written by "Always allow" or a change in the hq's files applies only to a new process).
   */
  private runPending(threadId: ThreadId, agent: string | null): boolean {
    const started = this.runs.get(threadId);
    if (!started) return false;
    const now = this.runFor(agent, threadId);
    if (started.model !== now.model || started.effort !== now.effort) return true;
    if (started.permissionMode !== this.deps.settings().permissionMode) return true;
    const { allow, deny, locked, keptOut } = this.ruleDetail(agent);
    if (started.locked !== locked || JSON.stringify(started.keptOut) !== JSON.stringify(keptOut)) return true;
    return JSON.stringify(started.rules) !== JSON.stringify({ allow, deny });
  }

  /** What the header shows: the values for the next turn, the chat's choice, what "org default" is, and whether a change is waiting. */
  private runInfo(threadId: ThreadId, agent: string | null): Pick<ThreadState, 'model' | 'effort' | 'runChoice' | 'runPending' | 'runDefaults' | 'modelTiers' | 'permissionMode' | 'seenModels'> {
    const next = this.runFor(agent, threadId);
    return {
      model: next.model,
      effort: next.effort,
      runChoice: this.choices.get(threadId),
      runPending: this.runPending(threadId, agent),
      runDefaults: { ...this.orgDefaults(agent), pinned: !agent && !DEV.model && isSpecificModel(this.deps.settings().model) },
      modelTiers: this.deps.settings().modelTiers,
      permissionMode: this.deps.settings().permissionMode,
      seenModels: this.deps.seenModels?.list() ?? [],
    };
  }

  /**
   * Sets a chat's own model and/or effort (a missing key stays, null is the org default). Nothing restarts now:
   * the idle process is replaced when the next message is sent.
   */
  setRun(threadId: ThreadId, patch: { model?: string | null; effort?: EffortLevel | null }): ThreadInfo {
    const th = this.thread(threadId);
    if (!th) throw new Error('Unknown conversation.');
    const clean: { model?: string | null; effort?: EffortLevel | null } = {};
    if (patch.model === null || isModel(patch.model)) clean.model = patch.model;
    if (patch.effort === null || EFFORTS.includes(patch.effort as EffortLevel)) clean.effort = patch.effort;
    this.choices.set(threadId, clean);
    this.deps.emit({ type: 'thread-state', state: th.state() });
    return th.info();
  }

  /**
   * After a plugin update or a settings change: finish the turn in flight and the queue, then stop; the next message respawns.
   * A turn waiting on a permission card would never finish, so those requests are denied first (with a line in the thread),
   * and the wait is capped: after `restartWaitMs` the chat is stopped anyway.
   */
  async restartSessions(): Promise<void> {
    const threads: Array<[ThreadId, Thread]> = [['cos', this.cos], ...[...this.tabs].map(([id, th]): [ThreadId, Thread] => [`tab:${id}`, th])];
    for (const [id, th] of threads) {
      if (this.deps.broker.denyPending(threadKey(this.orgId, id)) > 0) th.append('system', '', t('thread.permissionCancelled'));
    }
    const cap = this.deps.restartWaitMs ?? RESTART_WAIT_MS;
    await Promise.all(
      threads.map(async ([, th]) => {
        let timer: NodeJS.Timeout | undefined;
        const timedOut = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), cap);
        });
        const r = await Promise.race([th.restart().then(() => 'done' as const), timedOut]);
        clearTimeout(timer);
        if (r === 'timeout') await th.stop(0);
      }),
    );
    this.runs.clear();
  }

  /** Tells the renderer the state of every chat of the org (after the org's permission mode changed, so the "next message" note shows at once). */
  emitThreadStates(): void {
    for (const th of [this.cos, ...this.tabs.values()]) this.deps.emit({ type: 'thread-state', state: th.state() });
  }

  async stopAll(): Promise<void> {
    for (const h of this.handoverTimers.values()) clearTimeout(h);
    this.handoverTimers.clear();
    for (const th of [this.cos, ...this.tabs.values()]) th.stopCommands();
    await Promise.all([this.cos.stop(), ...[...this.tabs.values()].map((th) => th.stop()), ...this.ending, this.sweeping]);
  }
}

/** Which status wins when chats disagree: failed, needs-auth, pending, connected, anything else last. */
const statusRank = (status: string): number => {
  const i = ['failed', 'needs-auth', 'pending', 'connected'].indexOf(status);
  return i < 0 ? 4 : i;
};

function readTabs(file: string): TabInfo[] {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    // A record from before pendingWork: a chat with no note has work that was not handed over.
    return Array.isArray(v) ? (v as TabInfo[]).map((r) => ({ ...r, pendingWork: typeof r.pendingWork === 'boolean' ? r.pendingWork : (r.notePath ?? null) === null })) : [];
  } catch {
    return [];
  }
}
