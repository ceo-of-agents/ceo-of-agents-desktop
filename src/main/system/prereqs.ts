import type { ClaudeStatus, GitStatus, PrereqStatus } from '../../shared/types';
import { ALLOW_UNSUPPORTED_ENV, SUPPORTED_CLAUDE } from '../config';
import { run, type Runner } from './exec';
import { locateClaude } from './locate';
import { pluginStatus } from './plugin';
import { inRange, parseVersion, rangeLabel } from './version';

const range = rangeLabel(SUPPORTED_CLAUDE.min, SUPPORTED_CLAUDE.maxExclusive);

export async function checkClaude(claudePath: string | null, runner: Runner = run): Promise<ClaudeStatus> {
  if (!claudePath) return { found: false, path: null, version: null, supported: false, range };
  const r = await runner(claudePath, ['--version'], { timeoutMs: 15000 });
  const version = r.code === 0 && !r.error ? parseVersion(r.stdout) : null;
  if (!version) return { found: true, path: claudePath, version: null, supported: false, range };
  const forced = process.env[ALLOW_UNSUPPORTED_ENV] === '1';
  const supported = forced || inRange(version, SUPPORTED_CLAUDE.min, SUPPORTED_CLAUDE.maxExclusive);
  return { found: true, path: claudePath, version, supported, range };
}

/** Reads only the loggedIn boolean of `claude auth status --json`. Everything else is dropped. */
export async function checkSignedIn(claudePath: string, runner: Runner = run): Promise<boolean> {
  const r = await runner(claudePath, ['auth', 'status', '--json'], { timeoutMs: 20000 });
  if (r.error) return false;
  try {
    const parsed: unknown = JSON.parse(r.stdout);
    return typeof parsed === 'object' && parsed !== null && (parsed as { loggedIn?: unknown }).loggedIn === true;
  } catch {
    return false;
  }
}

export async function checkGit(runner: Runner = run): Promise<GitStatus> {
  const xc = await runner('xcode-select', ['-p'], { timeoutMs: 10000 });
  if (xc.code !== 0 || xc.error) return { found: false, version: null, devToolsMissing: true };
  const r = await runner('git', ['--version'], { timeoutMs: 10000 });
  if (r.code !== 0 || r.error) return { found: false, version: null, devToolsMissing: false };
  return { found: true, version: parseVersion(r.stdout), devToolsMissing: false };
}

export interface PrereqOptions {
  hqPath: string | null;
  fetchLatest?: () => Promise<string | null>;
  runner?: Runner;
  claudePath?: string | null;
}

export async function checkPrereqs(opts: PrereqOptions): Promise<PrereqStatus> {
  const runner = opts.runner ?? run;
  const claudePath = opts.claudePath !== undefined ? opts.claudePath : await locateClaude({ runner });
  const claude = await checkClaude(claudePath, runner);
  const git = await checkGit(runner);
  const signedIn = claude.found && claudePath ? await checkSignedIn(claudePath, runner) : null;
  const plugin =
    opts.hqPath && claude.found && claudePath
      ? await pluginStatus(claudePath, opts.hqPath, { runner, fetchLatest: opts.fetchLatest })
      : null;
  return { claude, signedIn, git, plugin, checkedAt: new Date().toISOString() };
}
