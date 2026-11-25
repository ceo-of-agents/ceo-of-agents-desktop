import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignInState } from '../../src/shared/types';
import { SignInFlow } from '../../src/main/system/signin';
import type { Spawner } from '../../src/main/system/exec';
import { mockRunner, ok, fixture } from './helpers';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = null;
  killed = false;
  kill() {
    this.killed = true;
    return true;
  }
}

let child: FakeChild;
let spawnArgs: { cmd: string; args: string[]; opts: { stdio?: unknown } } | null;
const spawner: Spawner = (cmd, args, opts) => {
  child = new FakeChild();
  spawnArgs = { cmd, args, opts: opts as { stdio?: unknown } };
  return child as never;
};
let signedIn = false;
const { runner } = mockRunner(() => ok(signedIn ? fixture('auth-status-in.json') : fixture('auth-status-out.json')));

beforeEach(() => {
  vi.useFakeTimers();
  signedIn = false;
});
afterEach(() => vi.useRealTimers());

function make() {
  const flow = new SignInFlow({ runner, spawner });
  const states: SignInState[] = [];
  let done = 0;
  flow.on('state', (s: SignInState) => states.push(s));
  flow.on('done', () => done++);
  return { flow, states, done: () => done };
}

describe('SignInFlow', () => {
  it('spawns auth login with stdin ignored and keeps only the first URL', async () => {
    const { flow, states } = make();
    flow.start('/c');
    expect(spawnArgs?.args).toEqual(['auth', 'login']);
    expect(spawnArgs?.opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(child.stdin).toBeNull();
    child.stdout.write("Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?a=1\n");
    child.stderr.write('see https://other.example/x\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(flow.getState().url).toBe('https://claude.com/cai/oauth/authorize?a=1');
    expect(states.at(-1)?.running).toBe(true);
    flow.cancel();
  });
  it('polls until signed in, then kills and finishes', async () => {
    const { flow, states, done } = make();
    flow.start('/c');
    await vi.advanceTimersByTimeAsync(3000);
    expect(flow.getState().running).toBe(true);
    signedIn = true;
    await vi.advanceTimersByTimeAsync(3000);
    expect(child.killed).toBe(true);
    expect(states.at(-1)).toEqual({ running: false, url: null, error: null });
    expect(done()).toBe(1);
  });
  it('cancel stops everything', async () => {
    const { flow, done } = make();
    flow.start('/c');
    flow.cancel();
    expect(child.killed).toBe(true);
    expect(flow.getState().running).toBe(false);
    expect(done()).toBe(1);
    signedIn = true;
    await vi.advanceTimersByTimeAsync(10000);
    expect(done()).toBe(1);
  });
  it('times out after 10 minutes', async () => {
    const { flow, done } = make();
    flow.start('/c');
    await vi.advanceTimersByTimeAsync(600000);
    expect(flow.getState().running).toBe(false);
    expect(flow.getState().error).toMatch(/timed out/);
    expect(done()).toBe(1);
  });
  it('process exit: keeps polling 30 s then errors', async () => {
    const { flow, done } = make();
    flow.start('/c');
    child.emit('exit', 0);
    await vi.advanceTimersByTimeAsync(20000);
    expect(flow.getState().running).toBe(true);
    await vi.advanceTimersByTimeAsync(11000);
    expect(flow.getState().running).toBe(false);
    expect(flow.getState().error).not.toBeNull();
    expect(done()).toBe(1);
  });
  it('process exit then signed in is success', async () => {
    const { flow } = make();
    flow.start('/c');
    child.emit('exit', 0);
    signedIn = true;
    await vi.advanceTimersByTimeAsync(3000);
    expect(flow.getState()).toEqual({ running: false, url: null, error: null });
  });
});
