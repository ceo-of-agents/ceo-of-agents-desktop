// Thread pieces the run guard relies on: holdRestart (quiet restarts wait for background work), interrupt (stop now,
// end the messages not answered) and awaitingReport (the gap before Claude Code's own report turn starts).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeSession } from '../../src/main/claude/session';
import type { Spawner } from '../../src/main/system/exec';
import { Thread } from '../../src/main/org/thread';
import { fakeFactory, waitFor } from './helpers';

let dir: string;
const threads: Thread[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-hold-'));
});
afterEach(async () => {
  await Promise.all(threads.splice(0).map((t) => t.stop()));
  fs.rmSync(dir, { recursive: true, force: true });
});

function make(extra: Partial<ConstructorParameters<typeof Thread>[0]> = {}, env: Record<string, string> = {}) {
  const factory = fakeFactory(dir, env);
  let day = new Date(2026, 10, 18, 9, 0, 0);
  let stored: { sessionId: string; day: string } | null = null;
  const th = new Thread({
    orgId: 'o1',
    threadId: 'cos',
    title: 'T',
    speaker: 'Ada',
    logFile: path.join(dir, 'log.jsonl'),
    makeSession: factory.makeSession,
    sessions: { get: () => stored, set: (sessionId, d) => (stored = { sessionId, day: d }), clear: () => (stored = null) },
    fresh: { idleMs: () => 0, sizeTokens: () => 0 },
    now: () => day,
    emit: () => undefined,
    ...extra,
  });
  threads.push(th);
  const say = async (text: string, n: number) => {
    th.enqueue(text, 'user', { kind: 'user', author: 'You', text });
    await waitFor(() => th.info().entries.filter((e) => e.kind === 'assistant').length >= n && !th.busy);
  };
  return { th, factory, say, nextDay: () => (day = new Date(day.getTime() + 24 * 3600_000)) };
}

describe('Thread holdRestart', () => {
  it('needsRestart is ignored while background work runs; the process is replaced (with --resume) once it ends', async () => {
    let hold = true;
    const { th, factory, say } = make({ needsRestart: () => true, holdRestart: () => hold });
    await say('one', 1);
    await say('two', 2);
    expect(factory.sessions).toHaveLength(1);
    expect(factory.resumeIds).toEqual([null]);
    hold = false;
    await say('three', 3);
    expect(factory.sessions).toHaveLength(2);
    expect(factory.resumeIds).toEqual([null, 'sid-1']);
    expect(th.info().entries.filter((e) => e.kind === 'assistant')).toHaveLength(3);
  });

  it('without a hold a needed restart still happens at the next message', async () => {
    const { factory, say } = make({ needsRestart: () => true });
    await say('one', 1);
    await say('two', 2);
    expect(factory.sessions).toHaveLength(2);
  });

  it('a new session (new day) does not replace the process while background work runs, and says so once; after it, it does', async () => {
    let hold = true;
    const { th, factory, say, nextDay } = make({ holdRestart: () => hold });
    await say('one', 1);
    nextDay();
    await say('two', 2);
    expect(factory.sessions).toHaveLength(1);
    const held = 'Work is still running in the background: the new session starts with your first message after it has ended.';
    expect(th.info().entries.filter((e) => e.kind === 'system').map((e) => e.text)).toEqual([held]);
    hold = false;
    await say('three', 3);
    expect(factory.sessions).toHaveLength(2);
    expect(factory.resumeIds).toEqual([null, null]);
    expect(th.info().entries.filter((e) => e.kind === 'system').map((e) => e.text)).toEqual([held]);
    expect(th.info().entries.filter((e) => e.kind === 'session')).toHaveLength(2);
  });
});

describe('Thread interrupt', () => {
  it('stops the process at once; every message not answered yet ends with it, the thread counts as idle, the next message starts a new process', async () => {
    const { th, factory } = make({}, { FAKE_DELAY_MS: '300', FAKE_REPLY: 'answer' });
    th.enqueue('first', 'user', { kind: 'user', author: 'You', text: 'first' });
    await waitFor(() => th.busy);
    th.enqueue('second', 'user', { kind: 'user', author: 'You', text: 'second' });
    await th.interrupt();
    expect(th.busy).toBe(false);
    expect(th.sessionId).toBeNull();
    await th.idle();
    await new Promise((r) => setTimeout(r, 100));
    expect(factory.sessions).toHaveLength(1); // nothing was sent on its own
    expect(th.info().entries.filter((e) => e.kind === 'assistant')).toEqual([]);
    th.enqueue('third', 'user', { kind: 'user', author: 'You', text: 'third' });
    await waitFor(() => th.info().entries.filter((e) => e.kind === 'assistant').length === 1 && !th.busy);
    expect(factory.sessions).toHaveLength(2);
  });

  it('with one message in flight it just stops the process', async () => {
    const { th } = make({}, { FAKE_DELAY_MS: '300' });
    th.enqueue('first', 'user', { kind: 'user', author: 'You', text: 'first' });
    await waitFor(() => th.busy);
    await th.interrupt();
    expect(th.busy).toBe(false);
    expect(th.info().entries.some((e) => e.kind === 'error')).toBe(false);
  });
});

describe('Thread awaitingReport', () => {
  const FIX = path.join(__dirname, '..', 'fixtures', 'claude');
  it('is true from the background agent\'s notification until the result of the report turn (ClaudeSession.reportPending)', async () => {
    const spawner: Spawner = (_c, a, opts) =>
      spawn(process.execPath, [path.join(FIX, 'fake-claude-lifecycle.mjs'), ...a], {
        ...opts,
        env: { ...process.env, FAKE_SCENARIO: 'race-recorded', FAKE_FIXTURE: path.join(FIX, 'dispatch-race.jsonl'), FAKE_DELAY_MS: '5' },
      });
    const atNotification: Array<{ busy: boolean; awaiting: boolean }> = [];
    let sent = false;
    const th: Thread = new Thread({
      orgId: 'o1',
      threadId: 'cos',
      title: 'T',
      speaker: 'Ada',
      logFile: path.join(dir, 'log2.jsonl'),
      makeSession: () => new ClaudeSession({ claudePath: 'claude', cwd: dir, args: ['-p'], spawner }),
      emit: () => undefined,
      onStream: (ev) => {
        if (ev.kind === 'task-ended' && ev.notification && ev.topLevel && !sent) {
          sent = true;
          atNotification.push({ busy: th.busy, awaiting: th.awaitingReport });
          // the 2nd message makes the fake play Claude Code's own report turn
          th.enqueue('B', 'user', { kind: 'user', author: 'You', text: 'B' });
        }
      },
    });
    threads.push(th);
    expect(th.awaitingReport).toBe(false);
    th.enqueue('dispatch', 'user', { kind: 'user', author: 'You', text: 'dispatch' });
    await waitFor(() => th.info().entries.filter((e) => e.kind === 'assistant').some((e) => e.text === 'B') && !th.busy);
    // the first turn had ended (idle) when the notification arrived, and the report was already pending
    expect(atNotification).toEqual([{ busy: false, awaiting: true }]);
    expect(th.awaitingReport).toBe(false);
  });
});
