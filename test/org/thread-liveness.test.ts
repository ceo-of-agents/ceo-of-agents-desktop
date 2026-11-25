import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeSession } from '../../src/main/claude/session';
import type { ClaudeEvent } from '../../src/main/claude/stream';
import type { Spawner } from '../../src/main/system/exec';
import { DispatchTracker } from '../../src/main/org/dispatches';
import { Thread, type TurnResult } from '../../src/main/org/thread';
import type { AppEvent, Dispatch } from '../../src/shared/types';
import { waitFor } from './helpers';

const FIX = path.join(__dirname, '..', 'fixtures', 'claude');
const FAKE = path.join(FIX, 'fake-claude.mjs');
const FAKE_LC = path.join(FIX, 'fake-claude-lifecycle.mjs');
const FAKE_REPLAY = path.join(FIX, 'fake-claude-replay.mjs');
const REPORT = 'The background agent finished and returned `pong`.';

let dir: string;
const threads: Thread[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-thread-live-'));
});
afterEach(async () => {
  await Promise.all(threads.splice(0).map((t) => t.stop()));
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Setup {
  fake?: string;
  /** `env` can depend on the 0-based number of the spawned process. */
  env?: (n: number) => Record<string, string>;
  makeSession?: (resumeId: string | null) => ClaudeSession;
  needsRestart?: () => boolean;
  onStream?: (e: ClaudeEvent) => void;
}

function setup(o: Setup = {}) {
  const events: AppEvent[] = [];
  const stream: ClaudeEvent[] = [];
  let exits = 0;
  let spawned = 0;
  const makeSession =
    o.makeSession ??
    (() => {
      const spawner: Spawner = (_c, a, opts) => {
        const extra = o.env?.(spawned++) ?? {};
        return spawn(process.execPath, [o.fake ?? FAKE, ...a], { ...opts, env: { ...process.env, FAKE_DELAY_MS: '5', ...extra } });
      };
      return new ClaudeSession({ claudePath: 'claude', cwd: dir, args: ['-p'], spawner });
    });
  const th = new Thread({
    orgId: 'o1',
    threadId: 'cos',
    title: 'T',
    speaker: 'Ada',
    logFile: path.join(dir, 'log.jsonl'),
    makeSession,
    needsRestart: o.needsRestart,
    emit: (e) => events.push(e),
    onStream: (e) => {
      stream.push(e);
      o.onStream?.(e);
    },
    onSessionExit: () => exits++,
  });
  threads.push(th);
  return { th, events, stream, exits: () => exits, spawned: () => spawned };
}

const assistantTexts = (th: Thread) => th.info().entries.filter((e) => e.kind === 'assistant').map((e) => e.text);
const say = (th: Thread, text: string) => th.enqueue(text, 'user', { kind: 'user', author: 'You', text });

describe('Thread over the replay of dispatch-race.jsonl', () => {
  it('logs the report as an assistant entry, then B; reportPending goes true then false; the tracker sees the dispatch done', async () => {
    const changes: Dispatch[][] = [];
    const tracker = new DispatchTracker({
      file: path.join(dir, 'dispatches.json'),
      departments: () => [{ id: 'engineering', agent: 'max', persona: 'Max' }],
      onChange: (l) => changes.push(l),
      onEnded: () => undefined,
    });
    const onNotification: Array<{ pending: boolean; dispatch: string | undefined }> = [];
    let sentB = false;
    const { th, events } = setup({
      fake: FAKE_LC,
      env: () => ({ FAKE_SCENARIO: 'race-recorded', FAKE_FIXTURE: path.join(FIX, 'dispatch-race.jsonl') }),
      // the tracker is fed by the stream the thread forwards; B is sent when the agent's notification arrives
      onStream: (e) => {
        tracker.handle(e);
        if (e.kind === 'task-ended' && e.notification && e.topLevel && !sentB) {
          sentB = true;
          onNotification.push({ pending: !!th.state().reportPending, dispatch: tracker.list()[0]?.state });
          say(th, 'B');
        }
      },
    });
    say(th, 'dispatch it');
    await waitFor(() => assistantTexts(th).includes('B') && !th.busy);
    expect(sentB).toBe(true);
    expect(assistantTexts(th)).toEqual(['dispatched.', REPORT, 'B']);
    // the notification ended the dispatch, and the thread already knew a report was pending
    expect(onNotification).toEqual([{ pending: true, dispatch: 'done' }]);
    expect(tracker.list()).toMatchObject([{ agent: 'max', departmentId: 'engineering', background: true, state: 'done' }]);
    // the user's B is shown before the report, the answer after it
    const order = th.info().entries.filter((e) => e.kind === 'assistant' || (e.kind === 'user' && e.text === 'B')).map((e) => e.text);
    expect(order).toEqual(['dispatched.', 'B', REPORT, 'B']);
    expect(th.info().entries.some((e) => e.kind === 'error' || e.kind === 'system')).toBe(false);
    // reportPending: true, then false, from the thread-state events
    const flags = events.flatMap((e) => (e.type === 'thread-state' ? [e.state.reportPending] : [])).filter((v, i, a) => i === 0 || v !== a[i - 1]);
    expect(flags).toEqual([false, true, false]);
    expect(th.state().reportPending).toBe(false);
  });
});

describe('Thread.onSessionExit', () => {
  it('fires when the live process exits', async () => {
    const { th, exits } = setup({ env: () => ({ FAKE_FIXTURE: path.join(FIX, 'plain-reply.jsonl'), FAKE_EXIT_MID_TURN: '1' }) });
    say(th, 'hello');
    await waitFor(() => exits() === 1);
    await waitFor(() => !th.busy);
    expect(exits()).toBe(1);
  });

  it('fires when the thread stops the process (stop)', async () => {
    const { th, exits } = setup({ env: () => ({ FAKE_FIXTURE: path.join(FIX, 'plain-reply.jsonl') }) });
    say(th, 'hello');
    await waitFor(() => assistantTexts(th).length === 1 && !th.busy);
    expect(exits()).toBe(0);
    await th.stop();
    expect(exits()).toBe(1);
  });

  it('fires when the thread replaces an idle process (restart)', async () => {
    const { th, exits } = setup({ env: () => ({ FAKE_FIXTURE: path.join(FIX, 'plain-reply.jsonl') }) });
    say(th, 'hello');
    await waitFor(() => assistantTexts(th).length === 1 && !th.busy);
    await th.restart();
    expect(exits()).toBe(1);
  });

  /** A session that is not a process: `exit` is emitted by the test, `stop` never emits it. */
  class Stub extends EventEmitter {
    sessionId = 'sid';
    reportPending = false;
    lastStderr = '';
    constructor(readonly name: string) {
      super();
    }
    send(): string {
      const uuid = `${this.name}-${++this.writes}`;
      setImmediate(() => this.emit('turn-end', { text: `answer from ${this.name}`, isError: false, resultText: '', uuids: [uuid] }));
      return uuid;
    }
    private writes = 0;
    stop(): Promise<void> {
      return Promise.resolve();
    }
  }

  it('does not fire when an old process (replaced earlier) exits late; the live one still counts', async () => {
    const made: Stub[] = [];
    let restart = false;
    const { th, exits } = setup({
      makeSession: () => {
        const s = new Stub(`p${made.length}`);
        made.push(s);
        return s as unknown as ClaudeSession;
      },
      needsRestart: () => restart,
    });
    say(th, 'one');
    await waitFor(() => assistantTexts(th).length === 1 && !th.busy);
    restart = true;
    say(th, 'two');
    await waitFor(() => assistantTexts(th).length === 2 && !th.busy);
    expect(made).toHaveLength(2);
    expect(assistantTexts(th)).toEqual(['answer from p0', 'answer from p1']);
    // the first process was replaced; its exit comes late and touches nothing
    made[0].emit('exit', { code: 0, duringTurn: false });
    expect(exits()).toBe(0);
    made[1].emit('exit', { code: 0, duringTurn: false });
    expect(exits()).toBe(1);
  });

  it('fires for the process stopSession is stopping, even though it is no longer the live session', async () => {
    const made: Stub[] = [];
    let release: () => void = () => undefined;
    const { th, exits } = setup({
      makeSession: () => {
        const s = new Stub(`p${made.length}`);
        s.stop = () => new Promise<void>((r) => (release = r));
        made.push(s);
        return s as unknown as ClaudeSession;
      },
    });
    say(th, 'one');
    await waitFor(() => assistantTexts(th).length === 1 && !th.busy);
    const stopped = th.stop();
    // stop is waiting for the exit of the process
    made[0].emit('exit', { code: 0, duringTurn: false });
    expect(exits()).toBe(1);
    release();
    await stopped;
    // and once it is done, a second exit of the same object is an old process's
    made[0].emit('exit', { code: 0, duringTurn: false });
    expect(exits()).toBe(1);
  });
});

describe('Thread pump with a vanished session', () => {
  it('the process exits during a turn with two messages written: one error line for both, no unhandled rejection, the next message is answered by a new process', async () => {
    const rejections: unknown[] = [];
    const onRej = (e: unknown) => rejections.push(e);
    process.on('unhandledRejection', onRej);
    try {
      const { th, spawned, exits } = setup({ env: (n): Record<string, string> => ({ FAKE_FIXTURE: path.join(FIX, 'two-messages.jsonl'), ...(n === 0 ? { FAKE_EXIT_MID_TURN: '1' } : {}) }) });
      say(th, 'one');
      say(th, 'two');
      await waitFor(() => exits() === 1 && !th.busy);
      expect(spawned()).toBe(1);
      expect(th.info().entries.filter((e) => e.kind === 'error')).toHaveLength(1);
      say(th, 'three');
      await waitFor(() => spawned() === 2 && assistantTexts(th).length === 2 && !th.busy);
      expect(th.info().entries.filter((e) => e.kind === 'user').map((e) => e.text)).toEqual(['one', 'two', 'three']);
      expect(th.info().entries.filter((e) => e.kind === 'error')).toHaveLength(1);
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRej);
    }
  });

  it('a session that is gone when pump reaches it: send is never called on it, ensureSession runs again, then an error line', async () => {
    const sent: string[] = [];
    class Gone extends EventEmitter {
      sessionId = null;
      reportPending = false;
      lastStderr = '';
      send(t: string): string {
        sent.push(t);
        return 'u';
      }
      stop(): Promise<void> {
        return Promise.resolve();
      }
    }
    let made = 0;
    const { th } = setup({
      makeSession: () => {
        made++;
        const s = new Gone();
        // the process is gone before the thread can write to it
        queueMicrotask(() => s.emit('exit', { code: 1, duringTurn: false }));
        return s as unknown as ClaudeSession;
      },
    });
    say(th, 'hello');
    await waitFor(() => !th.busy && th.info().entries.some((e) => e.kind === 'error'));
    expect(sent).toEqual([]);
    expect(made).toBe(2);
  });
});

describe('Thread over the live capture of a message written during a tool call', () => {
  it('both messages are answered by one turn end: the reply goes after them, one batch for the listeners', async () => {
    const { th } = setup({ fake: FAKE_REPLAY, env: () => ({ FAKE_FIXTURE: path.join(FIX, 'midturn-s1-absorbed.jsonl') }) });
    const results: TurnResult[] = [];
    th.onTurnEnd((r) => results.push(r));
    th.enqueue('A', 'user', { kind: 'user', author: 'You', text: 'A' }, 'tag-a');
    th.enqueue('B', 'user', { kind: 'user', author: 'You', text: 'B' }, 'tag-b');
    await waitFor(() => results.length === 1 && !th.busy);
    expect(results).toHaveLength(1);
    expect(results[0].sent.map((m) => m.tag)).toEqual(['tag-a', 'tag-b']);
    expect(results[0].text).toBe('ALPHA\nBETA');
    expect(th.info().entries.filter((e) => e.kind === 'user' || e.kind === 'assistant').map((e) => e.text)).toEqual(['A', 'B', 'ALPHA\nBETA']);
    expect(th.hasTag('tag-a') || th.hasTag('tag-b')).toBe(false);
  });
});
