// A ledger of the `claude -p` processes this app started. Each chat's process runs in its own process group
// (`detached`), so a crash, a force quit or a signal to the main process leaves it running, reparented to launchd. The ledger
// is how the app (1) stops everything it started when it ends, and (2) finds what an earlier run left behind and offers to stop
// it, never touching a process it did not start. Pure of Electron: the runner, the clock, `kill` and the file are injected.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { run, type Runner, type Spawner } from '../system/exec';
import { t } from '../../shared/strings';

/** What one process of an earlier run looks like on the command line: only these substrings are tested, the rest is never kept. */
const SIGNATURE = '--permission-prompt-tool mcp__coa__permission_prompt';
/** The start time `ps` reports may differ this much from the time the app recorded (guards against a reused pid). */
const START_TOLERANCE_MS = 10_000;
const MAX_ENTRIES = 200;

/** One line of the ledger file. No arguments, no environment, no tokens: only who, where and when. */
export interface LedgerEntry {
  pid: number;
  orgId: string;
  hqPath: string;
  appPid: number;
  /** Epoch ms. */
  spawnedAt: number;
}

/** A process of an earlier app run that is still alive and is one of ours. */
export interface Leftover {
  pid: number;
  /** Epoch ms, from `ps`. */
  startedAt: number;
}

export interface OrgRef {
  id: string;
  path: string;
}

export interface LedgerOptions {
  /** `<dataDir>/claude-processes.json`. */
  file: string;
  /** This app's pid (default: this process). */
  appPid?: number;
  /** Runs `ps` (default: the one-shot runner). */
  runner?: Runner;
  now?: () => number;
  /** `process.kill` (tests). */
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** Whether an app pid is a running process (default: `process.kill(pid, 0)`; EPERM counts as running). Tests inject it. */
  appAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  /** Wait between SIGTERM and SIGKILL when stopping a leftover (default 4 s). */
  termGraceMs?: number;
}

/** `ps` elapsed time `[[dd-]hh:]mm:ss` in ms, or null when it does not parse. */
export function parseEtime(s: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  if (!m) return null;
  const [, d, h, mi, se] = m;
  return (((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(mi)) * 60 + Number(se)) * 1000;
}

interface PsRow {
  pid: number;
  elapsedMs: number;
  /** True when the command line is a `claude -p` of this app (the line itself is dropped). */
  ours: boolean;
}

/** Reads the lines of `ps -o pid=,etime=,command=`. The command line (it holds an mcp-config with a token) is only tested, never kept. */
export function parsePs(stdout: string): Map<number, PsRow> {
  const rows = new Map<number, PsRow>();
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const elapsedMs = parseEtime(m[2]);
    if (elapsedMs === null) continue;
    const command = m[3];
    const words = command.split(/\s+/);
    rows.set(Number(m[1]), { pid: Number(m[1]), elapsedMs, ours: command.includes('claude') && words.includes('-p') && command.includes(SIGNATURE) });
  }
  return rows;
}

const validPid = (pid: unknown): pid is number => typeof pid === 'number' && Number.isInteger(pid) && pid > 1;

function defaultAppAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function signalGroup(kill: NonNullable<LedgerOptions['kill']>, pid: number, signal: NodeJS.Signals): boolean {
  if (!validPid(pid)) return false;
  try {
    kill(-pid, signal); // the process group the child leads (it was spawned detached)
    return true;
  } catch {
    try {
      kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

export class ProcessLedger {
  private readonly file: string;
  private readonly appPid: number;
  private readonly runner: Runner;
  private readonly now: () => number;
  private readonly kill: NonNullable<LedgerOptions['kill']>;
  private readonly appAlive: (pid: number) => boolean;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly termGraceMs: number;
  /** The children of THIS run that are still alive. */
  private readonly live = new Map<number, ChildProcess>();
  private _closed = false;

  constructor(o: LedgerOptions) {
    this.file = o.file;
    this.appPid = o.appPid ?? process.pid;
    this.runner = o.runner ?? run;
    this.now = o.now ?? Date.now;
    this.kill = o.kill ?? ((pid, sig) => void process.kill(pid, sig));
    this.appAlive = o.appAlive ?? defaultAppAlive;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.termGraceMs = o.termGraceMs ?? 4000;
  }

  /** After close() no new process is started (the app is ending). */
  get closed(): boolean {
    return this._closed;
  }

  close(): void {
    this._closed = true;
  }

  /** Records a child right after it was spawned and drops the record when it exits. */
  track(child: ChildProcess, org: { orgId: string; hqPath: string }): void {
    const pid = child.pid;
    if (!validPid(pid)) return;
    this.live.set(pid, child);
    this.update((list) => [...list.filter((e) => e.pid !== pid), { pid, orgId: org.orgId, hqPath: org.hqPath, appPid: this.appPid, spawnedAt: this.now() }]);
    const done = () => {
      if (this.live.get(pid) !== child) return;
      this.live.delete(pid);
      this.update((list) => list.filter((e) => e.pid !== pid || e.appPid !== this.appPid));
    };
    child.once('exit', done);
    child.once('error', () => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) done();
    });
  }

  /** Signals the process group of every child of this run that is still alive. Synchronous, best effort, never throws. */
  killAllSync(signal: NodeJS.Signals): void {
    for (const [pid, child] of this.live) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      signalGroup(this.kill, pid, signal);
    }
  }

  /** How many children of this run are alive (tests). */
  get liveCount(): number {
    return this.live.size;
  }

  /** An entry of an earlier run: not a child of this run, and its owning app is gone (a live other instance's children are not ours to judge). */
  private isForeign(e: LedgerEntry): boolean {
    if (this.live.has(e.pid)) return false;
    return !(e.appPid !== this.appPid && validPid(e.appPid) && this.appAlive(e.appPid));
  }

  /** True when the file holds an entry of an earlier run (a leftover to look at, or a stale line to prune). */
  hasForeign(): boolean {
    return this.read().some((e) => this.isForeign(e));
  }

  /**
   * The processes of earlier runs that are still alive and are ours, per org (only registered orgs whose folder matches the one
   * recorded). An entry owned by another app pid that is still running (a second instance) is skipped: neither reported nor pruned.
   * An entry whose pid is dead, whose command line is not our `claude -p`, or whose start time does not match the
   * recorded spawn time (a reused pid) is removed from the ledger. When `ps` cannot be run nothing is reported or pruned.
   */
  async findLeftovers(orgs: OrgRef[]): Promise<Map<string, Leftover[]>> {
    const out = new Map<string, Leftover[]>();
    const foreign = this.read().filter((e) => this.isForeign(e));
    if (foreign.length === 0) return out;
    const res = await this.runner('ps', ['-ww', '-o', 'pid=,etime=,command=', '-p', foreign.map((e) => e.pid).join(',')], { timeoutMs: 5000 });
    if (res.error) return out;
    const rows = parsePs(res.stdout);
    const now = this.now();
    const stale: LedgerEntry[] = [];
    for (const e of foreign) {
      const row = rows.get(e.pid);
      const startedAt = row ? now - row.elapsedMs : 0;
      if (!row || !row.ours || Math.abs(startedAt - e.spawnedAt) > START_TOLERANCE_MS) {
        stale.push(e);
        continue;
      }
      if (!orgs.some((o) => o.id === e.orgId && path.resolve(o.path) === path.resolve(e.hqPath))) continue;
      const list = out.get(e.orgId) ?? [];
      list.push({ pid: e.pid, startedAt });
      out.set(e.orgId, list);
    }
    if (stale.length > 0) this.update((list) => list.filter((e) => !stale.some((s) => s.pid === e.pid && s.spawnedAt === e.spawnedAt)));
    return out;
  }

  /**
   * Stops one leftover of `orgId`: SIGTERM to its group, SIGKILL after the grace time when it is still alive, then the record goes.
   * Checks again, just now, that `pid` is a current leftover of that org; anything else is refused (false).
   */
  async stopLeftover(orgId: string, pid: number, orgs: OrgRef[]): Promise<boolean> {
    if (!validPid(pid)) return false;
    const found = (await this.findLeftovers(orgs)).get(orgId)?.some((l) => l.pid === pid);
    if (!found) return false;
    signalGroup(this.kill, pid, 'SIGTERM');
    const t0 = this.now();
    while (this.alive(pid) && this.now() - t0 < this.termGraceMs) await this.sleep(100);
    if (this.alive(pid)) {
      signalGroup(this.kill, pid, 'SIGKILL');
      await this.sleep(300);
    }
    if (this.alive(pid)) return false;
    this.update((list) => list.filter((e) => e.pid !== pid || this.live.has(e.pid)));
    return true;
  }

  /** The process, or the group it leads, still exists. */
  private alive(pid: number): boolean {
    for (const target of [pid, -pid]) {
      try {
        this.kill(target, 0);
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EPERM') return true;
      }
    }
    return false;
  }

  // ---------- the file ----------

  private read(): LedgerEntry[] {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { entries?: unknown };
      if (!v || !Array.isArray(v.entries)) return [];
      return v.entries
        .filter((e): e is LedgerEntry => !!e && validPid((e as LedgerEntry).pid) && typeof (e as LedgerEntry).orgId === 'string' && typeof (e as LedgerEntry).hqPath === 'string' && typeof (e as LedgerEntry).appPid === 'number' && typeof (e as LedgerEntry).spawnedAt === 'number')
        .map((e) => ({ pid: e.pid, orgId: e.orgId, hqPath: e.hqPath, appPid: e.appPid, spawnedAt: e.spawnedAt }));
    } catch {
      return [];
    }
  }

  /** Read, change, write back atomically (temp file in the same folder, then rename). Best effort: a failed write never stops a spawn. */
  private update(change: (list: LedgerEntry[]) => LedgerEntry[]): void {
    try {
      const next = change(this.read()).slice(-MAX_ENTRIES);
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: next }, null, 2) + '\n');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.warn('process ledger not written', e instanceof Error ? e.message : e);
    }
  }
}

/** A spawner that records every child in the ledger, and refuses to start one once the ledger is closed (the app is ending). */
export function trackedSpawner(ledger: ProcessLedger, base: Spawner, org: { orgId: string; hqPath: string }): Spawner {
  return (cmd, args, opts) => {
    if (ledger.closed) throw new Error(t('claude.shuttingDown'));
    const child = base(cmd, args, opts);
    ledger.track(child, org);
    return child;
  };
}

/** SIGTERM, SIGINT and SIGHUP to the main process (`npm start` and Ctrl-C, `kill`, a closed terminal): stop every child, then exit. */
export function installSignalHandlers(ledger: ProcessLedger, exit: (code: number) => void, proc: Pick<NodeJS.Process, 'on'> = process): void {
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    proc.on(sig, () => {
      ledger.close();
      ledger.killAllSync('SIGTERM');
      exit(0);
    });
  }
}
