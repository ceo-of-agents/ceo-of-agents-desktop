// Pushes the hq after each commit. Watches the HEAD reflog; debounced.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { t } from '../../shared/strings';
import { run, type Runner } from '../system/exec';
import * as g from './git';

export interface AutoPusherOptions {
  enabled: () => boolean;
  runner?: Runner;
  retryDelaysMs?: number[];
  /** Consecutive failed attempts before the failure is reported (default 3: the first try plus 2 retries). */
  failureThreshold?: number;
}

const DEFAULT_DELAYS = [15000, 30000, 60000, 120000, 300000];
const DEFAULT_THRESHOLD = 3;

export function isRebaseConflict(text: string): boolean {
  return /CONFLICT|could not apply|Resolve all conflicts/i.test(text);
}

export function isNonFastForward(text: string): boolean {
  return /rejected|non-fast-forward|fetch first/i.test(text);
}

/** One short line for the user: no URLs with credentials, no long output. */
export function shortError(text: string | null | undefined): string {
  const lines = (text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const pick =
    lines.find((l) => /rejected|fatal:|error: (?!failed to push)/i.test(l)) ??
    lines.find((l) => !/^hint:/i.test(l)) ??
    lines[0] ??
    'push failed';
  const clean = pick
    .replace(/^(fatal|error):\s*/i, '')
    .replace(/\/\/[^/\s@]+@/g, '//')
    .replace(/'[^']*\/[^']*'/g, 'the remote')
    .replace(/https?:\/\/\S+/gi, '(remote)')
    .replace(/\s+/g, ' ');
  return clean.length > 140 ? `${clean.slice(0, 137)}...` : clean;
}

export class AutoPusher extends EventEmitter {
  private readonly runner: Runner;
  private readonly delays: number[];
  private watchers: fs.FSWatcher[] = [];
  private debounce: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private lastHead: string | null = null;
  private attempt = 0;
  private running = false;
  private rerun = false;
  private stopped = true;
  private failures = 0;
  private _failing = false;
  private _error: string | null = null;
  private readonly threshold: number;

  constructor(
    private readonly hqPath: string,
    private readonly opts: AutoPusherOptions,
  ) {
    super();
    this.runner = opts.runner ?? run;
    this.delays = opts.retryDelaysMs && opts.retryDelaysMs.length ? opts.retryDelaysMs : DEFAULT_DELAYS;
    this.threshold = Math.max(1, opts.failureThreshold ?? DEFAULT_THRESHOLD);
  }

  /** True only when the failure persisted for the threshold number of attempts. */
  get failing(): boolean {
    return this._failing;
  }

  /** Short last error line while failing, else null. */
  get lastError(): string | null {
    return this._failing ? this._error : null;
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.lastHead = await g.headSha(this.hqPath, this.runner);
    const targets = [
      await g.gitPath(this.hqPath, 'logs/HEAD', this.runner),
      await g.gitPath(this.hqPath, 'refs/heads', this.runner),
    ];
    for (const p of targets) {
      if (!p || !fs.existsSync(p)) continue;
      try {
        const w = fs.watch(p, { recursive: false }, () => this.schedule());
        w.on('error', () => undefined);
        this.watchers.push(w);
      } catch {
        // watching is best effort
      }
    }
  }

  stop(): void {
    this.stopped = true;
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.debounce) clearTimeout(this.debounce);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.debounce = null;
    this.retryTimer = null;
  }

  /** Call after a manual successful sync. */
  markSynced(): void {
    this._failing = false;
    this._error = null;
    this.failures = 0;
    this.attempt = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.checkNow();
    }, 1000);
  }

  /** Looks at HEAD and pushes if it moved and the branch is ahead. */
  async checkNow(force = false): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    try {
      const head = await g.headSha(this.hqPath, this.runner);
      const moved = head !== this.lastHead;
      if (!force && !moved) return;
      this.lastHead = head;
      if (moved) this.emit('head-moved', { head });
      if (!this.opts.enabled()) return;
      if ((await g.remotes(this.hqPath, this.runner)).length === 0) return;
      const ab = await g.aheadBehind(this.hqPath, this.runner);
      // No upstream yet: push anyway so the first push sets it up.
      if (ab && ab.ahead === 0) return;
      await this.doPush(head);
    } finally {
      this.running = false;
      if (this.rerun) {
        this.rerun = false;
        this.schedule();
      }
    }
  }

  /** One push attempt: fetch, skip when the remote has HEAD, push, and on non-fast-forward rebase once and push again. */
  private async attemptPush(): Promise<{ ok: boolean; error: string | null; conflict: boolean; skipped?: boolean }> {
    // A rebase or merge in progress means someone is working in the hq: leave it alone, try later.
    if (await g.operationInProgress(this.hqPath, this.runner)) return { ok: false, error: null, conflict: false, skipped: true };
    if (await g.upstream(this.hqPath, this.runner)) {
      await g.fetch(this.hqPath, this.runner); // a failed fetch shows up as a failed push below
      if (await g.upstreamContainsHead(this.hqPath, this.runner)) return { ok: true, error: null, conflict: false };
    }
    let r = await g.push(this.hqPath, this.runner);
    if (r.ok) return { ok: true, error: null, conflict: false };
    if (isNonFastForward(r.detail ?? r.error ?? '')) {
      // Uncommitted edits (for example a session still writing) make the rebase refuse: not a conflict, retry later.
      if (await g.hasTrackedChanges(this.hqPath, this.runner)) return { ok: false, error: t('health.pushError.localChanges'), conflict: false };
      // The user may have started their own rebase since the check at the top: look again so we never pull into it or abort it.
      if (await g.operationInProgress(this.hqPath, this.runner)) return { ok: false, error: null, conflict: false, skipped: true };
      const pulled = await g.pullRebase(this.hqPath, this.runner);
      if (!pulled.ok) {
        const text = pulled.detail ?? pulled.error ?? '';
        // Abort only a rebase this pull started (none was running before: checked at the top), whatever the failure,
        // so the next attempts do not see "operation in progress" and skip forever.
        if (await g.operationInProgress(this.hqPath, this.runner)) await g.rebaseAbort(this.hqPath, this.runner);
        if (isRebaseConflict(text)) return { ok: false, error: t('health.pushError.conflict'), conflict: true };
        return { ok: false, error: shortError(text), conflict: false };
      }
      r = await g.push(this.hqPath, this.runner);
      if (r.ok) return { ok: true, error: null, conflict: false };
    }
    return { ok: false, error: shortError(r.detail ?? r.error), conflict: false };
  }

  private async doPush(head: string | null): Promise<void> {
    const r = await this.attemptPush();
    if (this.stopped && !r.ok) return;
    if (r.ok) {
      this.markSynced();
      this.emit('pushed', { head });
      return;
    }
    if (r.skipped) {
      // Not a failure: retry later without counting it.
      const delay = this.delays[Math.min(this.attempt, this.delays.length - 1)];
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (this.stopped) return;
        void this.retry();
      }, delay);
      return;
    }
    this.failures += 1;
    this._error = r.error;
    if (r.conflict) {
      // Retrying cannot fix a conflict: report now and wait for the next commit.
      this._failing = true;
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.emit('push-failed', { error: r.error ?? 'conflict', nextRetryMs: 0, conflict: true });
      return;
    }
    const nextRetryMs = this.delays[Math.min(this.attempt, this.delays.length - 1)];
    this.attempt += 1;
    if (this.failures >= this.threshold) {
      this._failing = true;
      this.emit('push-failed', { error: r.error ?? 'push failed', nextRetryMs });
    }
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.stopped) return;
      void this.retry();
    }, nextRetryMs);
  }

  /** Runs one push attempt now (the Retry button). */
  async retryNow(): Promise<void> {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    while (this.running) await new Promise((r) => setTimeout(r, 50));
    await this.retry();
  }

  private async retry(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (!this.opts.enabled()) return;
      await this.doPush(await g.headSha(this.hqPath, this.runner));
    } finally {
      this.running = false;
    }
  }
}
