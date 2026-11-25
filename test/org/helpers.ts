import { spawn } from 'node:child_process';
import path from 'node:path';
import { ClaudeSession } from '../../src/main/claude/session';
import type { Spawner } from '../../src/main/system/exec';

export const FAKE_ORG = path.join(__dirname, '..', 'fixtures', 'org', 'fake-claude-org.mjs');

export interface Factory {
  makeSession: (resumeId: string | null) => ClaudeSession;
  resumeIds: Array<string | null>;
  sessions: ClaudeSession[];
  /** Process ids of the children spawned, in order. */
  pids: number[];
}

/** Builds sessions over the fake claude. `env` can depend on the call number (0-based) and the resume id. */
export function fakeFactory(cwd: string, env: Record<string, string> | ((n: number, resumeId: string | null) => Record<string, string>) = {}): Factory {
  const f: Factory = { resumeIds: [], sessions: [], pids: [], makeSession: () => null as never };
  f.makeSession = (resumeId) => {
    const n = f.resumeIds.length;
    f.resumeIds.push(resumeId);
    const extra = typeof env === 'function' ? env(n, resumeId) : env;
    const args = ['-p', ...(resumeId ? ['--resume', resumeId] : [])];
    const spawner: Spawner = (_c, a, opts) => {
      const child = spawn(process.execPath, [FAKE_ORG, ...a], { ...opts, env: { ...process.env, ...extra } });
      if (child.pid) f.pids.push(child.pid);
      return child;
    };
    const s = new ClaudeSession({ claudePath: 'claude', cwd, args, spawner });
    f.sessions.push(s);
    return s;
  };
  return f;
}

export async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
