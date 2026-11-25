import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeSession } from '../../src/main/claude/session';
import { type Spawner } from '../../src/main/system/exec';

/** A child that only exits when it is sent one of `diesOn`. */
function fakeChild(diesOn: string[]) {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 4242;
  const signals: string[] = [];
  child.kill = (sig: string) => {
    signals.push(sig);
    if (diesOn.includes(sig)) child.emit('close', null);
    return true;
  };
  return { child, signals };
}

afterEach(() => vi.useRealTimers());

describe('ClaudeSession.stop', () => {
  it('SIGTERM after the grace time, then SIGKILL when the child ignores it; resolves after the exit', async () => {
    vi.useFakeTimers();
    const { child, signals } = fakeChild(['SIGKILL']);
    const s = new ClaudeSession({ claudePath: 'claude', cwd: '.', args: [], spawner: (() => child) as unknown as Spawner });
    s.send('hi');
    let stopped = false;
    const p = s.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(2999);
    expect(signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals).toEqual(['SIGTERM']);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(4000);
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    await p;
    expect(stopped).toBe(true);
    expect(s.running).toBe(false);
  });

  it('no SIGKILL when the child exits on SIGTERM; grace 0 sends SIGTERM at once', async () => {
    vi.useFakeTimers();
    const { child, signals } = fakeChild(['SIGTERM']);
    const s = new ClaudeSession({ claudePath: 'claude', cwd: '.', args: [], spawner: (() => child) as unknown as Spawner });
    s.send('hi');
    const p = s.stop(0);
    await vi.advanceTimersByTimeAsync(0);
    await p;
    await vi.advanceTimersByTimeAsync(10000);
    expect(signals).toEqual(['SIGTERM']);
  });
});

describe('ClaudeSession.stop kills the process group', () => {
  it('spawns detached and signals the negative pid, not just the child', async () => {
    vi.useFakeTimers();
    const { child, signals } = fakeChild([]);
    let spawnOpts: { detached?: boolean } = {};
    const groupSignals: Array<[number, string | number | undefined]> = [];
    const spy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
      groupSignals.push([pid, sig]);
      if (sig === 'SIGKILL') child.emit('close', null);
      return true;
    }) as typeof process.kill);
    try {
      const spawner = ((_c: string, _a: string[], o: { detached?: boolean }) => {
        spawnOpts = o;
        return child;
      }) as unknown as Spawner;
      const s = new ClaudeSession({ claudePath: 'claude', cwd: '.', args: [], spawner });
      s.send('hi');
      const p = s.stop(0);
      await vi.advanceTimersByTimeAsync(4000);
      await p;
      expect(spawnOpts.detached).toBe(true);
      expect(groupSignals).toEqual([[-4242, 'SIGTERM'], [-4242, 'SIGKILL']]);
      expect(signals).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('falls back to child.kill when the group signal throws', async () => {
    vi.useFakeTimers();
    const { child, signals } = fakeChild(['SIGTERM']);
    const spy = vi.spyOn(process, 'kill').mockImplementation((() => {
      throw new Error('ESRCH');
    }) as typeof process.kill);
    try {
      const s = new ClaudeSession({ claudePath: 'claude', cwd: '.', args: [], spawner: (() => child) as unknown as Spawner });
      s.send('hi');
      const p = s.stop(0);
      await vi.advanceTimersByTimeAsync(0);
      await p;
      expect(signals).toEqual(['SIGTERM']);
    } finally {
      spy.mockRestore();
    }
  });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('ClaudeSession.stop with a real process tree', () => {
  it('ends a grandchild started by the process', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-kill-'));
    const pidFile = path.join(dir, 'grandchild.pid');
    // The "claude" is a shell that starts a long background sleep and waits for it, like a long Bash tool.
    const spawner: Spawner = (_c, _a, opts) =>
      spawn('sh', ['-c', `sleep 30 & echo $! > "${pidFile}"; wait`], opts);
    const s = new ClaudeSession({ claudePath: 'sh', cwd: dir, args: [], spawner });
    s.send('hi');
    const t0 = Date.now();
    while (!fs.existsSync(pidFile) || !fs.readFileSync(pidFile, 'utf8').trim()) {
      if (Date.now() - t0 > 5000) throw new Error('grandchild did not start');
      await new Promise((r) => setTimeout(r, 20));
    }
    const grandchild = Number(fs.readFileSync(pidFile, 'utf8').trim());
    expect(alive(grandchild)).toBe(true);
    await s.stop(0);
    const t1 = Date.now();
    while (alive(grandchild) && Date.now() - t1 < 3000) await new Promise((r) => setTimeout(r, 20));
    expect(alive(grandchild)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 15000);
});
