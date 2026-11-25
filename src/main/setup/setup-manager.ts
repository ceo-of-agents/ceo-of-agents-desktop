// The "Create a new org" wizard: one Claude Code session in the new org's folder that runs the plugin's `init-fleet` skill with an
// answers file. It reuses `Thread` (org id `setup`, thread id = run id) for the transcript, the queue and the activity lines.
// One run at a time. The main process is the only place that spawns the process; the renderer only calls the IPC methods.
import { dialog, type BrowserWindow } from 'electron';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildClaudeArgs } from '../claude/args';
import type { PermissionBroker } from '../claude/permissions';
import { ClaudeSession } from '../claude/session';
import { ALLOWED_TOOLS, DEV } from '../config';
import { isHq } from '../hq/read';
import { Thread } from '../org/thread';
import type { RunningItem } from '../org/run-guard';
import { childEnv, type Runner, type Spawner } from '../system/exec';
import { EMPTY_FACTS, SETUP_ORG_ID, cleanAnswers, setupThreadId, toAnswersYaml, type SetupAnswers, type SetupData, type SetupFacts, type SetupFolderPick, type SetupState } from '../../shared/setup';
import { t } from '../../shared/strings';
import type { AppEvent, OrgSummary, ThreadInfo } from '../../shared/types';
import { detectFacts } from './facts';
import { checkPoliciesPath, checkSetupFolder } from './folder';
import { findPluginDir, readSetupData } from './plugin-data';

export interface SetupManagerDeps {
  /** The app's data folder: the thread log of a run lives in `<dataDir>/setup/` while it runs. */
  dataDir: string;
  broker: PermissionBroker;
  serverScript: string;
  nodePath: string;
  emit: (e: AppEvent) => void;
  /** The claude binary, or null when it is missing. */
  claudePath: () => string | null;
  /** A reason when sessions may not start (no Claude Code, unsupported version, not signed in), else null. */
  canStart: () => string | null;
  /** Registers the hq in or below the folder as an org. */
  addFromFolder: (dir: string) => OrgSummary | null;
  /** The busy state of the run may have changed (for the quit guard). */
  onRunningChange?: () => void;
  runner?: Runner;
  spawner?: Spawner;
}

interface Run {
  runId: string;
  folder: string;
  answersDir: string;
  answersFile: string;
  facts: SetupFacts;
  threadKey: string;
  thread: Thread;
  logFile: string;
  claudePath: string;
  pluginDir: string;
  sessionId: string | null;
  exited: boolean;
  error: string | null;
  lastEmitted: string;
}

/** `fs.mkdtempSync('coa-setup-')` names: the prefix and six random characters. */
const ANSWERS_DIR = /^coa-setup-[A-Za-z0-9]{6}$/;

/**
 * Deletes answers folders a crashed or killed app left in the temp folder: only folders of this exact name shape, owned by this user,
 * last changed before `before` (this app run's start), holding nothing but `answers.yaml`. Best effort, never throws.
 */
export function sweepAnswersDirs(tmp: string, before: number): number {
  let removed = 0;
  try {
    for (const name of fs.readdirSync(tmp)) {
      if (!ANSWERS_DIR.test(name)) continue;
      try {
        const dir = path.join(tmp, name);
        const st = fs.lstatSync(dir);
        if (!st.isDirectory() || (typeof process.getuid === 'function' && st.uid !== process.getuid()) || st.mtimeMs >= before) continue;
        if (fs.readdirSync(dir).some((n) => n !== 'answers.yaml')) continue;
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
      } catch {
        // best effort
      }
    }
  } catch {
    // best effort
  }
  return removed;
}

/** `Read` rules (absolute path, `//` prefix) for a folder, by its real path and by the path as given (the macOS temp folder is a link). */
export function readRules(dir: string): string[] {
  const paths = new Set<string>([dir]);
  try {
    paths.add(fs.realpathSync(dir));
  } catch {
    // keep the given path only
  }
  return [...paths].map((p) => `Read(/${p}/**)`);
}

export class SetupManager {
  private current: Run | null = null;
  private starting = false;

  constructor(private readonly d: SetupManagerDeps) {
    // A thread log of an earlier app run is of no use any more.
    try {
      fs.rmSync(path.join(d.dataDir, 'setup'), { recursive: true, force: true });
    } catch {
      // best effort
    }
    sweepAnswersDirs(os.tmpdir(), Date.now());
  }

  /** The plugin's catalog and gates, or an error text (the plugin is not installed, or its files cannot be read). */
  async data(): Promise<SetupData | { error: string }> {
    const claude = this.d.claudePath();
    if (!claude) return { error: t('claude.missing') };
    try {
      const found = await findPluginDir(claude, this.d.runner);
      if (!found) return { error: t('setup.err.noPlugin') };
      return readSetupData(found.dir);
    } catch (e) {
      return { error: t('setup.err.dataRead', { reason: String((e as Error).message || e) }) };
    }
  }

  /** The folder picker for the new org. Null when cancelled. */
  async pickFolder(win: BrowserWindow | null): Promise<SetupFolderPick | null> {
    const opts = { title: t('setup.pick.title'), buttonLabel: t('setup.pick.button'), properties: ['openDirectory' as const, 'createDirectory' as const] };
    const r = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    const picked = r.filePaths[0];
    if (r.canceled || !picked) return null;
    const c = checkSetupFolder(picked);
    return { path: picked, ok: c.ok, entries: c.entries, ...(c.symlink ? { symlink: true } : {}) };
  }

  async start(answers: SetupAnswers, folder: string): Promise<{ runId: string } | { error: string }> {
    if (this.current || this.starting) return { error: t('setup.err.running') };
    this.starting = true;
    try {
      return await this.startRun(answers, folder);
    } finally {
      this.starting = false;
    }
  }

  private async startRun(answers: SetupAnswers, folder: string): Promise<{ runId: string } | { error: string }> {
    const blocked = this.d.canStart();
    if (blocked) return { error: blocked };
    const claudePath = this.d.claudePath();
    if (!claudePath) return { error: t('claude.missing') };
    const check = checkSetupFolder(folder);
    if (check.missing) return { error: t('setup.err.folderMissing') };
    if (check.symlink) return { error: t('setup.err.folderSymlink') };
    if (!check.ok) return { error: t('setup.err.folderNotEmpty', { entries: check.entries.join(', ') }) };
    // A holding's policies repo is written by the wizard too: it must be a place of its own, not the picked folder or inside it, and empty.
    const policies = answers.policies_repo?.path?.trim();
    if (policies) {
      const problem = checkPoliciesPath(folder, policies);
      if (problem === 'inside') return { error: t('setup.err.policiesInside') };
      if (problem === 'notEmpty') return { error: t('setup.err.policiesNotEmpty') };
    }

    // The app never installs the plugin on its own: the wizard asks the CEO first and installs only after the CEO's yes.
    const plugin = await findPluginDir(claudePath, this.d.runner);
    if (!plugin) return { error: t('setup.err.noPlugin') };

    const runId = randomBytes(8).toString('hex');
    let answersDir: string;
    let answersFile: string;
    try {
      answersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-setup-'));
      answersFile = path.join(answersDir, 'answers.yaml');
      fs.writeFileSync(answersFile, toAnswersYaml(cleanAnswers(answers)), { mode: 0o600 });
    } catch (e) {
      return { error: t('setup.err.answers', { reason: String((e as Error).message || e) }) };
    }

    const key = `${SETUP_ORG_ID}|${setupThreadId(runId)}`;
    const logFile = path.join(this.d.dataDir, 'setup', `${runId}.jsonl`);
    const run: Run = {
      runId,
      folder,
      answersDir,
      answersFile,
      facts: { ...EMPTY_FACTS },
      threadKey: key,
      thread: null as unknown as Thread,
      logFile,
      claudePath,
      pluginDir: plugin.dir,
      sessionId: null,
      exited: false,
      error: null,
      lastEmitted: '',
    };
    run.thread = new Thread({
      orgId: SETUP_ORG_ID,
      threadId: setupThreadId(runId),
      title: t('setup.thread.title'),
      speaker: t('setup.speaker'),
      cwd: folder,
      logFile,
      makeSession: (resumeId) => this.makeSession(run, resumeId),
      sessions: {
        get: () => (run.sessionId ? { sessionId: run.sessionId, day: '' } : null),
        set: (id) => {
          run.sessionId = id;
        },
        clear: () => {
          run.sessionId = null;
        },
      },
      canStart: this.d.canStart,
      emit: (e) => this.d.emit(e),
      onSessionExit: () => {
        if (this.current !== run) return;
        run.exited = true;
        void this.refresh(run);
      },
      onBusyChange: () => {
        if (this.current !== run) return;
        this.emitState(run);
        this.d.onRunningChange?.();
      },
    });
    run.thread.onTurnStart(() => {
      run.exited = false;
      run.error = null;
    });
    run.thread.onTurnEnd((r) => {
      if (this.current !== run) return;
      const lastLine = (txt: string) => txt.trim().split('\n').filter(Boolean).pop() ?? '';
      run.error = r.isError ? lastLine(r.resultText) || t('thread.processExited') : null;
      void this.refresh(run);
    });
    this.current = run;
    // The first message is the skill call, typed as the user message: nothing of it is shown in the thread.
    run.thread.enqueue(`/ceo-of-agents:init-fleet ${answersFile}`, 'user', null);
    return { runId };
  }

  private makeSession(run: Run, resumeId: string | null): ClaudeSession {
    const mcpConfigJson = this.d.broker.register(run.threadKey, { serverScript: this.d.serverScript, nodePath: this.d.nodePath, cwd: run.folder, noRule: true });
    const args = buildClaudeArgs({
      permissionMode: 'acceptEdits',
      effort: 'medium',
      // The answers file is readable, and nothing more: a Read rule for its folder instead of `--add-dir` (which would allow writes there too).
      allowedTools: [...ALLOWED_TOOLS, ...readRules(run.answersDir)],
      mcpConfigJson,
      resumeSessionId: resumeId,
      model: DEV.model,
      pluginDir: run.pluginDir,
    });
    run.exited = false;
    return new ClaudeSession({ claudePath: run.claudePath, cwd: run.folder, args, env: childEnv(), spawner: this.d.spawner });
  }

  /** Detects the facts again (folder only) and emits the state. Never throws. */
  private async refresh(run: Run): Promise<void> {
    run.facts = await detectFacts(run.folder, this.d.runner);
    if (this.current === run) this.emitState(run);
  }

  private emitState(run: Run): void {
    const state = this.stateOf(run);
    const json = JSON.stringify(state);
    if (json === run.lastEmitted) return;
    run.lastEmitted = json;
    this.d.emit({ type: 'setup-state', ...state });
  }

  private stateOf(run: Run): SetupState {
    return { runId: run.runId, busy: run.thread.busy, exited: run.exited, hqReady: isHq(run.folder), facts: run.facts, answersFile: run.answersFile, error: run.error };
  }

  private get(runId: string): Run | null {
    return this.current && this.current.runId === runId ? this.current : null;
  }

  /** A message to the wizard (queued while it replies). */
  send(runId: string, text: string): void {
    const run = this.get(runId);
    if (!run || typeof text !== 'string' || !text.trim()) return;
    run.thread.enqueue(text, 'user', { kind: 'user', author: t('you'), text });
  }

  async status(runId: string): Promise<SetupState | null> {
    const run = this.get(runId);
    if (!run) return null;
    run.facts = await detectFacts(run.folder, this.d.runner);
    return this.stateOf(run);
  }

  thread(runId: string): ThreadInfo | null {
    return this.get(runId)?.thread.info() ?? null;
  }

  /** Stops the process, forgets the answers file and the transcript. The folder stays as it is. */
  async stop(runId: string): Promise<void> {
    const run = this.get(runId);
    if (!run) return;
    this.current = null;
    await run.thread.dispose(1000);
    this.d.broker.unregister(run.threadKey);
    for (const p of [run.answersDir, run.logFile]) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    this.d.emit({ type: 'setup-state', ...this.stateOf(run), busy: false, exited: true });
    this.d.onRunningChange?.();
  }

  /** Ends the run and adds the new hq to the app's orgs. */
  async finish(runId: string): Promise<OrgSummary | null> {
    const run = this.get(runId);
    if (!run) return null;
    const folder = run.folder;
    await this.stop(runId);
    return this.d.addFromFolder(folder);
  }

  /** The quit guard's view: one item while the wizard is replying. */
  runningItems(): RunningItem[] {
    const run = this.current;
    if (!run || !run.thread.busy) return [];
    return [{ orgId: SETUP_ORG_ID, orgName: t('setup.guard.org'), who: t('setup.speaker'), what: t('guard.what.replying'), startedAt: run.thread.turnStartedAt ?? new Date().toISOString(), kind: 'cos-turn' }];
  }

  /** Stops the run without asking (a confirmed Quit, macOS shutdown). */
  async shutdown(): Promise<void> {
    if (this.current) await this.stop(this.current.runId);
  }
}
