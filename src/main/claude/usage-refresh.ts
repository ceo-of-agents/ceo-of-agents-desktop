// Keeps plan usage current while every chat is idle, without spending usage: `claude -p /usage` is a local command in
// Claude Code (checked with 2.1.327: `local_command: "usage"`, `num_turns: 0`, no model usage, `duration_api_ms: 0`).
// It runs on a timer only when the last reading is old and no chat is running (a running chat reports usage itself),
// and when the user asks. If a result ever shows a model call, the refresh turns itself off for this app run.
// Only the window lines of the text are read (`parseUsageText`); every other field of the result is dropped unread.
import os from 'node:os';
import { parseUsageText, type PlanUsage, type RateLimitInfo } from '../../shared/usage';
import { run, type Runner } from '../system/exec';
import { compareVersions } from '../system/version';

/** The first Claude Code version checked to run `/usage` in print mode without a model call. */
export const USAGE_COMMAND_MIN = '2.1.327';
/** How often the timer looks. */
export const USAGE_TICK_MS = 5 * 60 * 1000;
/** A reading younger than this is current enough for the timer. */
export const USAGE_STALE_MS = 4 * 60 * 1000;

/** No settings, MCP servers, tools or session file: the command needs none of them. */
export const USAGE_ARGS = ['-p', '/usage', '--output-format', 'json', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--tools', ''];

export type RefreshResult = 'ok' | 'skipped' | 'unavailable' | 'failed' | 'off';

export interface UsageRefreshDeps {
  /** The Claude Code binary when sessions may start (found, supported, signed in), else null. */
  claudePath: () => string | null;
  /** Its version, null when unknown. */
  claudeVersion: () => string | null;
  last: () => PlanUsage | null;
  update: (info: RateLimitInfo) => void;
  /** True while any chat of any org is running: its own events keep usage current. */
  busy: () => boolean;
  runner?: Runner;
  now?: () => Date;
  log?: (line: string) => void;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The result object of `--output-format json` (or the `result` line of stream-json), null when there is none. */
function resultObject(stdout: string): Json | null {
  const tryParse = (s: string): Json | null => {
    try {
      const v: unknown = JSON.parse(s);
      return isObj(v) && v.type === 'result' ? v : null;
    } catch {
      return null;
    }
  };
  const whole = tryParse(stdout.trim());
  if (whole) return whole;
  const lines = stdout.split('\n').reverse();
  for (const l of lines) {
    const r = l.trim() ? tryParse(l.trim()) : null;
    if (r) return r;
  }
  return null;
}

/** True when the result shows that the model was called (then the command is not local in this version). */
export function spentModelCall(r: Json): boolean {
  if (r.local_command !== 'usage') return true;
  if (typeof r.num_turns === 'number' && r.num_turns > 0) return true;
  if (typeof r.duration_api_ms === 'number' && r.duration_api_ms > 0) return true;
  if (typeof r.total_cost_usd === 'number' && r.total_cost_usd > 0) return true;
  return isObj(r.modelUsage) && Object.keys(r.modelUsage).length > 0;
}

/** Reads `claude -p /usage` output: the windows, 'model-call' when the model was called, or null. */
export function readUsageCommand(stdout: string, now: Date = new Date()): RateLimitInfo | 'model-call' | null {
  const r = resultObject(stdout);
  if (!r) return null;
  if (spentModelCall(r)) return 'model-call';
  if (r.is_error === true) return null;
  return parseUsageText(r.result, now);
}

export class UsageRefresher {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<RefreshResult> | null = null;
  private off = false;

  constructor(private readonly d: UsageRefreshDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), USAGE_TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The timer's step: refresh only when every chat is idle and the last reading is old. */
  async tick(): Promise<RefreshResult> {
    if (this.d.busy()) return 'skipped';
    const last = this.d.last();
    const now = this.d.now?.() ?? new Date();
    if (last && now.getTime() - new Date(last.at).getTime() < USAGE_STALE_MS) return 'skipped';
    return this.refresh();
  }

  /** Reads `/usage` now (the user's Refresh, or the timer). One run at a time. */
  refresh(): Promise<RefreshResult> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runOnce().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runOnce(): Promise<RefreshResult> {
    if (this.off) return 'off';
    const claude = this.d.claudePath();
    const version = this.d.claudeVersion();
    if (!claude || !version || compareVersions(version, USAGE_COMMAND_MIN) < 0) return 'unavailable';
    const r = await (this.d.runner ?? run)(claude, USAGE_ARGS, { cwd: os.tmpdir(), timeoutMs: 30000 });
    if (r.error || r.code !== 0) {
      this.d.log?.(`usage refresh failed (${r.error ?? `exit ${r.code}`})`);
      return 'failed';
    }
    const info = readUsageCommand(r.stdout, this.d.now?.() ?? new Date());
    if (info === 'model-call') {
      this.off = true;
      this.d.log?.('usage refresh turned off: /usage called the model in this Claude Code version');
      return 'off';
    }
    if (!info) return 'failed';
    this.d.update(info);
    return 'ok';
  }
}
