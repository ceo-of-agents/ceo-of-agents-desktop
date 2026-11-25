// A command the user runs from the chat with "!" (like Claude Code's bash mode): run as the user, in the org's hq folder,
// with the user's shell, outside every permission rule. The caller confirms with the user first (OrgSession.runCommand).
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { childEnv } from './exec';

/** Longest command accepted: the confirmation shows it whole. */
export const USER_COMMAND_MAX_LENGTH = 2000;
/** The run is stopped after this long. */
export const USER_COMMAND_TIMEOUT_MS = 120_000;
/** Output kept (stdout and stderr together, in characters); the rest is dropped and the result says so. */
export const USER_COMMAND_MAX_OUTPUT = 30_000;

export type UserCommandOutcome = 'done' | 'failed' | 'timeout' | 'cancelled' | 'error';

export interface UserCommandResult {
  outcome: UserCommandOutcome;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  /** The process could not start (outcome `error`). */
  error?: string;
}

export interface RunningUserCommand {
  done: Promise<UserCommandResult>;
  cancel(): void;
}

export type CommandProblem = 'empty' | 'long' | 'chars';

// Control characters other than tab and newline, bidi controls and zero-width characters: what the confirmation would
// not show as typed.
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;

/** Why a command is refused before the confirmation, or null. */
export function commandProblem(command: string): CommandProblem | null {
  if (!command.trim()) return 'empty';
  if (command.length > USER_COMMAND_MAX_LENGTH) return 'long';
  if (HIDDEN.test(command)) return 'chars';
  return null;
}

/** The user's login shell from the environment when it is an absolute path to a file, else /bin/zsh. */
export function userShell(env: NodeJS.ProcessEnv = process.env): string {
  const s = env.SHELL;
  if (s && path.isAbsolute(s)) {
    try {
      if (fs.statSync(s).isFile()) return s;
    } catch {
      // fall through
    }
  }
  return '/bin/zsh';
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/g;

/** Terminal colour and cursor codes removed, CRLF as LF. */
export function cleanOutput(s: string): string {
  return s.replace(ANSI, '').replace(/\r\n/g, '\n');
}

export interface StartOptions {
  cwd: string;
  timeoutMs?: number;
  maxOutput?: number;
  shell?: string;
  /** Grace between SIGTERM and SIGKILL. */
  killGraceMs?: number;
  spawn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
}

/**
 * Starts `command` with `<shell> -c`, in its own process group (cancel and timeout end the whole group), stdin closed.
 * Never rejects.
 */
export function startUserCommand(command: string, o: StartOptions): RunningUserCommand {
  const max = o.maxOutput ?? USER_COMMAND_MAX_OUTPUT;
  let stdout = '';
  let stderr = '';
  let kept = 0;
  let truncated = false;
  let stopped: 'timeout' | 'cancelled' | null = null;
  let child: ChildProcess;
  let killTimer: NodeJS.Timeout | null = null;
  let finished = false;
  let timer: NodeJS.Timeout | undefined;

  const killGroup = (signal: NodeJS.Signals) => {
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    }
  };
  const stop = (why: 'timeout' | 'cancelled') => {
    if (finished || stopped) return;
    stopped = why;
    killGroup('SIGTERM');
    killTimer = setTimeout(() => killGroup('SIGKILL'), o.killGraceMs ?? 2000);
  };

  const done = new Promise<UserCommandResult>((resolve) => {
    const finish = (r: UserCommandResult) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve(r);
    };
    try {
      child = (o.spawn ?? spawn)(o.shell ?? userShell(), ['-c', command], {
        cwd: o.cwd,
        env: childEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (e) {
      finish({ outcome: 'error', exitCode: null, stdout: '', stderr: '', truncated: false, error: String((e as Error).message || e) });
      return;
    }
    const take = (which: 'out' | 'err') => (chunk: string) => {
      const room = max - kept;
      if (room <= 0) {
        truncated = truncated || chunk.length > 0;
        return;
      }
      const part = chunk.length > room ? chunk.slice(0, room) : chunk;
      if (part.length < chunk.length) truncated = true;
      kept += part.length;
      if (which === 'out') stdout += part;
      else stderr += part;
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', take('out'));
    child.stderr?.on('data', take('err'));
    child.on('error', (e) => finish({ outcome: 'error', exitCode: null, stdout, stderr, truncated, error: String(e.message || e) }));
    child.on('close', (code) => {
      const outcome: UserCommandOutcome = stopped ?? (code === 0 ? 'done' : 'failed');
      finish({ outcome, exitCode: typeof code === 'number' ? code : null, stdout: cleanOutput(stdout), stderr: cleanOutput(stderr), truncated });
    });
  });
  if (!finished) timer = setTimeout(() => stop('timeout'), o.timeoutMs ?? USER_COMMAND_TIMEOUT_MS);
  return { done, cancel: () => stop('cancelled') };
}

/**
 * What the model gets on its next turn, in the form Claude Code itself uses for a "!" command
 * (`<bash-input>`, `<bash-stdout>`, `<bash-stderr>`), plus one line on how it ended when it did not end well.
 */
export function commandContext(command: string, r: UserCommandResult): string {
  const notes: string[] = [];
  if (r.outcome === 'failed') notes.push(`[exit code ${r.exitCode ?? 'unknown'}]`);
  if (r.outcome === 'timeout') notes.push('[stopped: timed out]');
  if (r.outcome === 'cancelled') notes.push('[stopped by the user]');
  if (r.outcome === 'error') notes.push(`[could not start: ${r.error ?? 'unknown error'}]`);
  if (r.truncated) notes.push('[output truncated]');
  const err = [r.stderr.replace(/\n$/, ''), ...notes].filter(Boolean).join('\n');
  return `<bash-input>${command}</bash-input>\n<bash-stdout>${r.stdout.replace(/\n$/, '')}</bash-stdout><bash-stderr>${err}</bash-stderr>`;
}
