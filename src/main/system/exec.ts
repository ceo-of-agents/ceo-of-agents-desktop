// The only place that runs child processes for one-shot commands. Long-lived claude sessions use spawn in claude/session.ts;
// a command the user runs from the chat with "!" uses system/user-command.ts.
import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not start or timed out. */
  error: string | null;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  input?: string;
}

/** Usual install folders. A Mac app started from Finder gets a minimal PATH, so we add these. */
export function usualBinDirs(home = os.homedir()): string[] {
  return [
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
}

/** Environment for child processes: the app's own environment plus the usual bin folders on PATH. */
export function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const parts = (process.env.PATH || '').split(':').filter(Boolean);
  for (const d of usualBinDirs()) if (!parts.includes(d)) parts.push(d);
  return { ...process.env, PATH: parts.join(':'), GIT_TERMINAL_PROMPT: '0', ...extra };
}

export type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

export const run: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 30000, env: opts.env ?? childEnv(), maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
        const code = e ? (typeof e.code === 'number' ? e.code : null) : 0;
        const error = e && typeof e.code !== 'number' ? String(e.message || e.code) : e?.killed ? 'timeout' : null;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });

export type Spawner = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
export const spawnProcess: Spawner = (cmd, args, opts) => spawn(cmd, args, { env: childEnv(), ...opts });
