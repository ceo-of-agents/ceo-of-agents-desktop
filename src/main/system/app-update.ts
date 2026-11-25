// The app's own update: the newest GitHub release of the app's repo is read with the user's `gh`, downloaded and
// staged BEFORE the app quits, and installed by a detached shell helper once the app has exited (see CLAUDE.md, "Release flow").
// Nothing here runs in an unpackaged (dev) app. Pure helpers are exported for the tests; every command goes through
// the injected Runner.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP_REPO } from '../config';
import { t } from '../../shared/strings';
import type { AppUpdateStatus } from '../../shared/types';
import { run, type RunResult, type Runner } from './exec';
import { compareVersions, parseVersion } from './version';

const CACHE_MS = 60 * 60 * 1000;
const VIEW_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const STEP_TIMEOUT_MS = 2 * 60 * 1000;

export const assetName = (version: string): string => `CEO-of-Agents-${version}.dmg`;

export interface Release {
  version: string;
  /** The release's tagName exactly as GitHub reports it (with or without a leading v). */
  tag: string;
}

/** Pure: the newest release in `gh release view --json tagName,assets` output when it carries the exact .dmg asset, else null. */
export function parseRelease(stdout: string): Release | null {
  try {
    const doc = JSON.parse(stdout) as { tagName?: unknown; assets?: unknown } | null;
    if (!doc || typeof doc.tagName !== 'string') return null;
    const version = parseVersion(doc.tagName.replace(/^v/, ''));
    if (!version || doc.tagName.replace(/^v/, '') !== version) return null;
    if (!Array.isArray(doc.assets)) return null;
    const want = assetName(version);
    return doc.assets.some((a) => !!a && typeof a === 'object' && (a as { name?: unknown }).name === want) ? { version, tag: doc.tagName } : null;
  } catch {
    return null;
  }
}

/** How one `gh release view` run ended. */
export type ReleaseOutcome =
  | { kind: 'release'; release: Release }
  | { kind: 'noRelease' }
  | { kind: 'ghMissing' }
  | { kind: 'notSignedIn' }
  | { kind: 'failed' };

/** Pure: tells apart the ways `gh release view` can end (gh not found, not signed in, other failure or timeout, no usable release, a release). */
export function classifyRelease(r: RunResult): ReleaseOutcome {
  if (r.error) return /ENOENT|not found/i.test(r.error) ? { kind: 'ghMissing' } : { kind: 'failed' };
  if (r.code !== 0) return /gh auth login|not logged in|authenticat|HTTP 401/i.test(r.stderr) ? { kind: 'notSignedIn' } : { kind: 'failed' };
  const release = parseRelease(r.stdout);
  return release ? { kind: 'release', release } : { kind: 'noRelease' };
}

/** Runs `gh release view` and classifies the result. Never throws. */
export async function fetchLatestOutcome(runner: Runner = run, repo = APP_REPO): Promise<ReleaseOutcome> {
  try {
    return classifyRelease(await runner('gh', ['release', 'view', '--repo', repo, '--json', 'tagName,assets'], { timeoutMs: VIEW_TIMEOUT_MS }));
  } catch {
    return { kind: 'failed' };
  }
}

/** The latest release with a .dmg, or null for anything that goes wrong (gh missing, not signed in, no release, bad output). */
export async function fetchLatestApp(runner: Runner = run, repo = APP_REPO): Promise<Release | null> {
  const o = await fetchLatestOutcome(runner, repo);
  return o.kind === 'release' ? o.release : null;
}

/** The result of the menu's "Check for Updates…". `reason` is already translated. */
export type ManualCheckResult =
  | { kind: 'upToDate'; current: string }
  | { kind: 'available'; current: string; latest: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'dev' }
  | { kind: 'busy' };

const FAIL_KEYS: Record<'noRelease' | 'ghMissing' | 'notSignedIn' | 'failed', string> = {
  ghMissing: 'appUpdate.check.err.ghMissing',
  notSignedIn: 'appUpdate.check.err.notSignedIn',
  failed: 'appUpdate.check.err.network',
  noRelease: 'appUpdate.check.err.noRelease',
};

/** Pure: the update is offered when `latest` is newer than `current`. */
export function isNewer(latest: string | null, current: string): boolean {
  return !!latest && compareVersions(latest, current) > 0;
}

export type BundleResult = { ok: true; app: string } | { ok: false; error: 'notFound' | 'translocated' | 'notWritable' };

export interface BundleFs {
  realpath(p: string): string;
  /** Throws when the folder is not writable. */
  accessWritable(p: string): void;
}

const realFs: BundleFs = {
  realpath: (p) => fs.realpathSync(p),
  accessWritable: (p) => fs.accessSync(p, fs.constants.W_OK),
};

/** Pure (fs injected): the running app's bundle, from the executable's path, and whether it can be replaced. */
export function resolveBundle(execPath: string, bfs: BundleFs = realFs): BundleResult {
  let dir = execPath;
  let found: string | null = null;
  for (;;) {
    if (dir.endsWith('.app') && path.basename(dir).length > 4) {
      found = dir;
      break;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  if (!found) return { ok: false, error: 'notFound' };
  let app: string;
  try {
    app = bfs.realpath(found);
  } catch {
    return { ok: false, error: 'notFound' };
  }
  if (app.includes('/AppTranslocation/') || found.includes('/AppTranslocation/')) return { ok: false, error: 'translocated' };
  try {
    bfs.accessWritable(path.dirname(app));
  } catch {
    return { ok: false, error: 'notWritable' };
  }
  return { ok: true, app };
}

/**
 * The install helper. Every value comes in as a positional argument, never inside the script text:
 * $1 pid of the app, $2 staged app, $3 target app, $4 relaunch (1 or 0), $5 temp folder (deleted at the very end).
 * The new copy is built next to the target ("$3.new", same volume) and the target is never written in place: the old
 * one is renamed to "$3.old", the new one renamed into place, and "$3.old" is deleted only after both renames worked.
 * A failure puts the old one back; a run that was interrupted between the renames is repaired at the next start.
 * If the app is still running after 60 s the helper gives up and deletes its temp folder.
 */
export const INSTALL_SCRIPT = `set -u
n=0
while kill -0 "$1" 2>/dev/null; do
  n=$((n + 1))
  if [ "$n" -ge 120 ]; then
    rm -rf "$5"
    exit 0
  fi
  sleep 0.5
done
new="$3.new"
old="$3.old"
if [ ! -e "$3" ] && [ -e "$old" ]; then
  mv "$old" "$3"
fi
rm -rf "$new" "$old"
if ditto "$2" "$new"; then
  if mv "$3" "$old"; then
    if mv "$new" "$3"; then
      rm -rf "$old"
    else
      if [ -e "$3" ]; then rm -rf "$3"; fi
      mv "$old" "$3"
      rm -rf "$new"
    fi
  else
    rm -rf "$new"
  fi
else
  rm -rf "$new"
fi
if [ "$4" = "1" ]; then
  open "$3"
fi
rm -rf "$5"
`;

export interface StagedUpdate {
  stagedApp: string;
  targetApp: string;
  tmpDir: string;
}

/** Pure: the arguments for `/bin/sh <script> ...`. */
export function helperArgs(script: string, pid: number, staged: StagedUpdate, relaunch: boolean): string[] {
  return [script, String(pid), staged.stagedApp, staged.targetApp, relaunch ? '1' : '0', staged.tmpDir];
}

export interface StageFs {
  mkdtemp(prefix: string): string;
  readdir(p: string): string[];
  rm(p: string): void;
}

const realStageFs: StageFs = {
  mkdtemp: (prefix) => fs.mkdtempSync(prefix),
  readdir: (p) => fs.readdirSync(p),
  rm: (p) => fs.rmSync(p, { recursive: true, force: true }),
};

export type StageResult = { ok: true; staged: StagedUpdate } | { ok: false; error: string };

export interface StageDeps {
  runner: Runner;
  fsx?: StageFs;
  repo?: string;
  tmpRoot?: string;
}

/**
 * Downloads release `release` (by its exact tag), checks it and copies the app to a staging folder. Nothing outside the temp folder
 * changes. The disk image is always detached; on any failure the temp folder is removed.
 */
export async function stageUpdate(release: Release, targetApp: string, d: StageDeps): Promise<StageResult> {
  const { runner } = d;
  const { version } = release;
  const fsx = d.fsx ?? realStageFs;
  const repo = d.repo ?? APP_REPO;
  const tmp = fsx.mkdtemp(path.join(d.tmpRoot ?? os.tmpdir(), 'coa-app-update-'));
  const mnt = path.join(tmp, 'mnt');
  let mounted = false;
  let success = false;
  const fail = (key: string, vars: Record<string, string> = {}): StageResult => ({ ok: false, error: t(key, vars) });
  const plist = (app: string, key: string) => runner('plutil', ['-extract', key, 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')], { timeoutMs: STEP_TIMEOUT_MS });
  try {
    const dl = await runner('gh', ['release', 'download', release.tag, '--repo', repo, '--pattern', assetName(version), '--dir', tmp], { timeoutMs: DOWNLOAD_TIMEOUT_MS });
    if (dl.error || dl.code !== 0) return fail('appUpdate.err.download');
    const dmg = path.join(tmp, assetName(version));

    const attach = await runner('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mnt, dmg], { timeoutMs: STEP_TIMEOUT_MS });
    if (attach.error || attach.code !== 0) return fail('appUpdate.err.mount');
    mounted = true;

    const apps = fsx.readdir(mnt).filter((n) => n.endsWith('.app'));
    if (apps.length !== 1) return fail('appUpdate.err.noApp');
    const mountedApp = path.join(mnt, apps[0]);

    const [wantId, id, ver] = await Promise.all([plist(targetApp, 'CFBundleIdentifier'), plist(mountedApp, 'CFBundleIdentifier'), plist(mountedApp, 'CFBundleShortVersionString')]);
    if (wantId.code !== 0 || id.code !== 0 || wantId.stdout.trim() === '' || id.stdout.trim() !== wantId.stdout.trim()) return fail('appUpdate.err.bundleId');
    if (ver.code !== 0 || ver.stdout.trim() !== version) return fail('appUpdate.err.version', { version });

    const stagedApp = path.join(tmp, 'staged', apps[0]);
    const copy = await runner('ditto', [mountedApp, stagedApp], { timeoutMs: STEP_TIMEOUT_MS });
    if (copy.error || copy.code !== 0) return fail('appUpdate.err.copy');
    await detach(runner, mnt);
    mounted = false;

    const sig = await runner('codesign', ['--verify', '--deep', '--strict', stagedApp], { timeoutMs: STEP_TIMEOUT_MS });
    if (sig.error || sig.code !== 0) return fail('appUpdate.err.signature');
    success = true;
    return { ok: true, staged: { stagedApp, targetApp, tmpDir: tmp } };
  } catch (err) {
    console.warn('app update: staging failed', err);
    return fail('appUpdate.err.download');
  } finally {
    if (mounted) await detach(runner, mnt);
    // Success keeps the folder (the helper deletes it); every failure removes it.
    if (!success) {
      try {
        fsx.rm(tmp);
      } catch {
        // best effort
      }
    }
  }
}

async function detach(runner: Runner, mnt: string): Promise<void> {
  const r = await runner('hdiutil', ['detach', mnt], { timeoutMs: STEP_TIMEOUT_MS }).catch(() => null);
  if (r && !r.error && r.code === 0) return;
  await runner('hdiutil', ['detach', '-force', mnt], { timeoutMs: STEP_TIMEOUT_MS }).catch(() => null);
}

export interface AppUpdaterDeps {
  packaged: boolean;
  version: string;
  execPath: string;
  pid: number;
  emit: (s: AppUpdateStatus) => void;
  /** The usual quit path (QuitCoordinator.request): handover check, run guard, shutdown. True when the quit went through. */
  requestQuit: () => Promise<boolean>;
  runner?: Runner;
  spawner?: (cmd: string, args: string[]) => void;
  now?: () => number;
  stageFs?: StageFs;
  bundleFs?: BundleFs;
  tmpRoot?: string;
}

/** App-wide state of the update: the cached check, the staged copy and what happens at exit. */
export class AppUpdater {
  private state: AppUpdateStatus;
  private checkedAt = 0;
  private staged: StagedUpdate | null = null;
  /** The tag of the release `state.latest` came from; the download uses exactly this. */
  private latestTag: string | null = null;
  private relaunch = false;
  private started = false;
  private checking: Promise<void> | null = null;
  private lastOutcome: ReleaseOutcome = { kind: 'noRelease' };

  constructor(private readonly d: AppUpdaterDeps) {
    this.state = { state: d.packaged ? 'idle' : 'dev', current: d.version, latest: null, error: null };
  }

  status(): AppUpdateStatus {
    return this.state;
  }

  private set(patch: Partial<AppUpdateStatus>): void {
    this.state = { ...this.state, ...patch };
    this.d.emit(this.state);
  }

  /** Reads the latest release (cached for an hour unless `force`). Never throws; a packaged app only. */
  async check(force = false): Promise<AppUpdateStatus> {
    if (!this.d.packaged) return this.state;
    if (this.state.state !== 'idle' && this.state.state !== 'available' && this.state.state !== 'error') return this.state;
    const now = (this.d.now ?? Date.now)();
    if (!force && this.checkedAt && now - this.checkedAt < CACHE_MS) return this.state;
    if (!this.checking) {
      this.checking = (async () => {
        const outcome = await fetchLatestOutcome(this.d.runner ?? run);
        this.lastOutcome = outcome;
        const release = outcome.kind === 'release' ? outcome.release : null;
        const latest = release?.version ?? null;
        this.checkedAt = (this.d.now ?? Date.now)();
        // A click may have started a download meanwhile: the check never overwrites that.
        if (this.state.state !== 'idle' && this.state.state !== 'available' && this.state.state !== 'error') return;
        const next = isNewer(latest, this.d.version) ? 'available' : 'idle';
        this.latestTag = next === 'available' && release ? release.tag : null;
        if (next !== this.state.state || latest !== this.state.latest) this.set({ state: next, latest: next === 'available' ? latest : null, error: null });
      })().finally(() => {
        this.checking = null;
      });
    }
    await this.checking;
    return this.state;
  }

  /** The menu's "Check for Updates…": always asks GitHub (skips the cache) through the same path as `check`, then says what happened. */
  async checkNow(): Promise<ManualCheckResult> {
    if (!this.d.packaged) return { kind: 'dev' };
    const busy = () => this.state.state === 'downloading' || this.state.state === 'ready';
    if (busy()) return { kind: 'busy' };
    await this.check(true);
    if (busy()) return { kind: 'busy' };
    const o = this.lastOutcome;
    if (o.kind !== 'release') return { kind: 'failed', reason: t(FAIL_KEYS[o.kind]) };
    if (this.state.state === 'available' && this.state.latest) return { kind: 'available', current: this.d.version, latest: this.state.latest };
    return { kind: 'upToDate', current: this.d.version };
  }

  /** The "Update app" button: stage, then ask to quit. When already staged, only asks to quit again. */
  async update(): Promise<void> {
    if (!this.d.packaged) return;
    const s = this.state;
    if (s.state === 'ready' && this.staged) {
      await this.quitFromButton();
      return;
    }
    if ((s.state !== 'available' && s.state !== 'error') || !s.latest || !this.latestTag) return;
    const bundle = resolveBundle(this.d.execPath, this.d.bundleFs);
    if (!bundle.ok) {
      this.set({ state: 'error', error: t(`appUpdate.err.${bundle.error}`) });
      return;
    }
    this.set({ state: 'downloading', error: null });
    const r = await stageUpdate({ version: s.latest, tag: this.latestTag }, bundle.app, { runner: this.d.runner ?? run, fsx: this.d.stageFs, tmpRoot: this.d.tmpRoot });
    if (!r.ok) {
      this.set({ state: 'error', error: r.error });
      return;
    }
    this.staged = r.staged;
    this.set({ state: 'ready', error: null });
    await this.quitFromButton();
  }

  /**
   * Asks to quit the usual way. `relaunch` is set first: the exit (and so `installAtExit`) runs inside the quit, before it
   * resolves. When the quit did not go through (cancelled, or queued with "Wait"), a later plain quit still installs the
   * staged update but does not relaunch.
   */
  private async quitFromButton(): Promise<void> {
    this.relaunch = true;
    let quitting = false;
    try {
      quitting = await this.d.requestQuit();
    } finally {
      if (!quitting) this.relaunch = false;
    }
  }

  /** Called right before the app exits. Installs a staged update with the detached helper; `shutdown` (macOS going down) installs nothing. */
  installAtExit(shutdown: boolean): void {
    if (!this.staged || this.started || shutdown) return;
    this.started = true;
    const staged = this.staged;
    try {
      const script = path.join(staged.tmpDir, 'install.sh');
      fs.writeFileSync(script, INSTALL_SCRIPT, { mode: 0o700 });
      const args = helperArgs(script, this.d.pid, staged, this.relaunch);
      (this.d.spawner ?? defaultSpawner)('/bin/sh', args);
    } catch (err) {
      console.warn('app update: could not start the installer', err);
    }
  }
}

function defaultSpawner(cmd: string, args: string[]): void {
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}
