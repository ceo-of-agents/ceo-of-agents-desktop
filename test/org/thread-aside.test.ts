import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeSession } from '../../src/main/claude/session';
import { Thread, type TurnResult } from '../../src/main/org/thread';
import type { Spawner } from '../../src/main/system/exec';
import type { AppEvent } from '../../src/shared/types';
import { waitFor } from './helpers';

const FAKE = path.join(__dirname, '..', 'fixtures', 'claude', 'fake-claude-lifecycle.mjs');

let dir: string;
const threads: Thread[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-aside-'));
});
afterEach(async () => {
  await Promise.all(threads.splice(0).map((t) => t.stop()));
  fs.rmSync(dir, { recursive: true, force: true });
});

function setup(scenario: string) {
  const events: AppEvent[] = [];
  const spawner: Spawner = (_c, _a, opts) => spawn(process.execPath, [FAKE], { ...opts, env: { ...process.env, FAKE_SCENARIO: scenario } });
  const idleAsides: number[] = [];
  const th = new Thread({
    orgId: 'o1',
    threadId: 'cos',
    title: 'T',
    speaker: 'Ada',
    logFile: path.join(dir, 'log.jsonl'),
    makeSession: () => new ClaudeSession({ claudePath: 'claude', cwd: dir, args: ['-p'], spawner }),
    emit: (e) => events.push(e),
    onIdleAside: () => idleAsides.push(Date.now()),
  });
  threads.push(th);
  const results: TurnResult[] = [];
  th.onTurnEnd((r) => results.push(r));
  const entries = () => th.info().entries.map((e) => [e.kind, e.text]);
  return { th, results, entries, idleAsides };
}

const user = (text: string) => ({ kind: 'user' as const, author: 'You', text });

describe('Thread with turns Claude Code starts on its own', () => {
  it('update after --resume with a user message sent right after it: the tagged turn ends with its reply, no "without a reply"', async () => {
    const { th, results, entries } = setup('resume-notice');
    th.enqueue('apply the update', 'user', user('apply the update'), 'apply-hq-update:1');
    th.enqueue('is max still going?', 'user', user('is max still going?'));
    await waitFor(() => results.length === 2);
    expect(results.map((r) => [r.sent[0].tag, r.text])).toEqual([
      ['apply-hq-update:1', 'resumed'],
      [undefined, 'next'],
    ]);
    expect(entries()).toEqual([
      ['user', 'apply the update'],
      ['user', 'is max still going?'],
      ['assistant', 'resumed'],
      ['assistant', 'next'],
    ]);
  });

  it('a reply of its own while a message waits for Claude Code is its own entry and does not end the turn', async () => {
    const { th, results, entries, idleAsides } = setup('queued-behind');
    th.enqueue('question', 'user', user('question'), 'tag-q');
    await waitFor(() => results.length === 1);
    expect(results[0]).toMatchObject({ text: 'answer', sent: [{ tag: 'tag-q' }] });
    expect(entries()).toEqual([
      ['user', 'question'],
      ['assistant', 'A background agent finished.'],
      ['assistant', 'answer'],
    ]);
    expect(idleAsides).toHaveLength(0); // the chat was busy: someone is reading it
  });

  it('tool calls of a turn of its own never count as tools of the tagged turn (a handover turn sees only its own writes)', async () => {
    const { th, results, entries } = setup('queued-behind-tool');
    th.enqueue('hand over', 'user', user('hand over'), 'handover');
    await waitFor(() => results.length === 1);
    expect(results[0]).toMatchObject({ text: 'answer', sent: [{ tag: 'handover' }] });
    expect(results[0].tools).toEqual([]);
    expect(entries()).toContainEqual(['assistant', 'A background agent wrote a note.']);
  });

  it('a reply of its own while idle shows in the thread and calls no turn listener', async () => {
    const { th, results, entries, idleAsides } = setup('background-later');
    th.enqueue('start max', 'user', user('start max'));
    await waitFor(() => entries().length === 3);
    expect(entries()).toEqual([
      ['user', 'start max'],
      ['assistant', 'started'],
      ['assistant', 'Max is done.'],
    ]);
    expect(results).toHaveLength(1);
    expect(th.busy).toBe(false);
    expect(idleAsides).toHaveLength(1); // a notice: nobody was waiting on this chat
  });
});
