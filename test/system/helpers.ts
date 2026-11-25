import fs from 'node:fs';
import path from 'node:path';
import type { Runner, RunResult } from '../../src/main/system/exec';

export const fixture = (name: string): string => fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'system', name), 'utf8');

export const ok = (stdout = '', stderr = ''): RunResult => ({ code: 0, stdout, stderr, error: null });
export const fail = (stderr = '', code = 1, stdout = ''): RunResult => ({ code, stdout, stderr, error: null });

export interface Call {
  cmd: string;
  args: string[];
  cwd?: string;
}

/** Mock runner: handler gets "cmd arg arg" and returns a result; calls are recorded. */
export function mockRunner(handler: (line: string, call: Call) => RunResult | undefined): { runner: Runner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: Runner = async (cmd, args, opts) => {
    const call = { cmd, args, cwd: opts?.cwd };
    calls.push(call);
    return handler([cmd, ...args].join(' '), call) ?? fail('unexpected command');
  };
  return { runner, calls };
}
