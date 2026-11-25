import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanOutput, commandContext, commandProblem, startUserCommand, USER_COMMAND_MAX_LENGTH } from '../../src/main/system/user-command';

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coa-cmd-')));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const run = (command: string, o: { timeoutMs?: number; maxOutput?: number } = {}) => startUserCommand(command, { cwd: dir, shell: '/bin/sh', killGraceMs: 200, ...o });

describe('startUserCommand', () => {
  it('runs a plain command in the given folder', async () => {
    const r = await run('echo hello; pwd').done;
    expect(r).toMatchObject({ outcome: 'done', exitCode: 0, stdout: `hello\n${dir}\n`, stderr: '', truncated: false });
  });

  it('reports a failing command with its exit code and stderr', async () => {
    const r = await run('echo oops >&2; exit 3').done;
    expect(r).toMatchObject({ outcome: 'failed', exitCode: 3, stdout: '', stderr: 'oops\n' });
  });

  it('keeps only the first characters of a long output and says so', async () => {
    const r = await run('i=0; while [ $i -lt 5000 ]; do echo line-$i; i=$((i+1)); done', { maxOutput: 1000 }).done;
    expect(r.outcome).toBe('done');
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBe(1000);
    expect(r.stdout.startsWith('line-0\nline-1\n')).toBe(true);
  });

  it('cancel stops the whole process group', async () => {
    const marker = path.join(dir, 'after');
    const c = run(`sleep 30; touch ${marker}`);
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    c.cancel();
    const r = await c.done;
    expect(r.outcome).toBe('cancelled');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('stops a command that runs past the timeout', async () => {
    const r = await run('sleep 30', { timeoutMs: 150 }).done;
    expect(r.outcome).toBe('timeout');
  });

  it('reports a shell that cannot start', async () => {
    const r = await startUserCommand('echo x', { cwd: dir, shell: path.join(dir, 'no-such-shell') }).done;
    expect(r.outcome).toBe('error');
    expect(r.error).toBeTruthy();
  });
});

describe('commandProblem', () => {
  it('refuses empty, too long, control and invisible characters', () => {
    expect(commandProblem('  ')).toBe('empty');
    expect(commandProblem('x'.repeat(USER_COMMAND_MAX_LENGTH + 1))).toBe('long');
    expect(commandProblem('echo a\u001b[2Kb')).toBe('chars');
    expect(commandProblem('echo a\u202eb')).toBe('chars');
    expect(commandProblem('echo a\u200bb')).toBe('chars');
    expect(commandProblem('git status\n\tgit log')).toBeNull();
  });
});

describe('output for the model', () => {
  it('strips terminal codes and CRLF', () => {
    expect(cleanOutput('\u001b[31mred\u001b[0m\r\nnext')).toBe('red\nnext');
  });

  it('uses the bash-input, bash-stdout and bash-stderr form, with how it ended', () => {
    expect(commandContext('ls', { outcome: 'done', exitCode: 0, stdout: 'a\n', stderr: '', truncated: false })).toBe(
      '<bash-input>ls</bash-input>\n<bash-stdout>a</bash-stdout><bash-stderr></bash-stderr>',
    );
    expect(commandContext('x', { outcome: 'failed', exitCode: 2, stdout: '', stderr: 'bad\n', truncated: true })).toBe(
      '<bash-input>x</bash-input>\n<bash-stdout></bash-stdout><bash-stderr>bad\n[exit code 2]\n[output truncated]</bash-stderr>',
    );
    expect(commandContext('x', { outcome: 'cancelled', exitCode: null, stdout: '', stderr: '', truncated: false })).toContain('[stopped by the user]');
  });
});
