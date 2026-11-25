import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeSession, type Aside, type TurnEnd } from '../../src/main/claude/session';
import type { Spawner } from '../../src/main/system/exec';

// Each test spawns a real child process: give them room on a busy machine.
vi.setConfig({ testTimeout: 40_000 });

const FAKE = path.join(__dirname, '..', 'fixtures', 'claude', 'fake-claude-lifecycle.mjs');

let dir: string;
const sessions: ClaudeSession[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-lc-'));
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.stop()));
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A hold far longer than any wait: a result released at once cannot be mistaken for one released by the hold. */
const HOLD_LONG = 60_000;

function make(scenario: string, holdMs = 5000) {
  const logFile = path.join(dir, 'stdin.log');
  const spawner: Spawner = (_cmd, _args, opts) => spawn(process.execPath, [FAKE], { ...opts, env: { ...process.env, FAKE_SCENARIO: scenario, FAKE_LOG: logFile } });
  const s = new ClaudeSession({ claudePath: 'claude', cwd: dir, args: ['-p'], spawner, holdMs });
  sessions.push(s);
  const ends: TurnEnd[] = [];
  const asides: Aside[] = [];
  const deltas: string[] = [];
  s.on('turn-end', (e: TurnEnd) => ends.push(e));
  s.on('aside', (a: Aside) => asides.push(a));
  s.on('delta', (d: string) => deltas.push(d));
  const written = () => fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { s, ends, asides, deltas, written };
}

const until = async (cond: () => boolean, ms = 20_000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('ClaudeSession and turns Claude Code starts on its own', () => {
  it('writes each message with a uuid', async () => {
    const { s, written } = make('absorbed');
    s.send('hello');
    await s.idle();
    const w = written();
    expect(w[0]).toMatchObject({ type: 'user', message: { role: 'user', content: 'hello' } });
    expect(w[0].uuid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('on --resume, the empty result of a leftover notice does not end the turn (the update case)', async () => {
    const { s, ends, asides } = make('resume-notice');
    s.send('apply the update');
    await until(() => ends.length > 0);
    expect(ends).toMatchObject([{ text: 'resumed', isError: false, resultText: 'resumed' }]);
    expect(asides).toEqual([]); // nothing to show for an empty turn
    expect(s.busy).toBe(false);
  });

  it('a turn of its own that ends while the message is queued is an aside, never streamed as the reply; the message ends with its own result', async () => {
    const { s, ends, asides, deltas } = make('queued-behind');
    s.send('question');
    await until(() => ends.length > 0);
    expect(asides).toEqual([{ text: 'A background agent finished.' }]);
    expect(ends.map((e) => e.text)).toEqual(['answer']);
    expect(deltas).toEqual(['answer']);
  });

  it('completed after the result (no started): the held result is the message\'s own, at once', async () => {
    const { s, ends, asides } = make('completed-after-result', HOLD_LONG);
    const t0 = Date.now();
    s.send('question');
    await until(() => ends.length > 0);
    expect(ends.map((e) => e.text)).toEqual(['answer']);
    expect(asides).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(HOLD_LONG / 2); // released well before the hold, however slow the machine
  });

  it('queued and never started: after the hold the result counts as the message\'s, so nothing stays busy', async () => {
    const { s, ends } = make('queued-never-started', 100);
    s.send('question');
    await until(() => ends.length > 0);
    expect(ends.map((e) => e.text)).toEqual(['Background done.']);
    expect(s.busy).toBe(false);
    s.send('again');
    await until(() => ends.length > 1);
    expect(ends[1].text).toBe('next');
  });

  it('an empty result of no model call never ends the turn, whatever the order (after started; without lifecycle)', async () => {
    for (const scenario of ['notice-after-started', 'no-lifecycle-notice']) {
      const { s, ends, asides } = make(scenario);
      s.send('apply the update');
      await until(() => ends.length > 0);
      expect(ends, scenario).toMatchObject([{ text: 'resumed', isError: false, resultText: 'resumed' }]);
      expect(asides, scenario).toEqual([]);
    }
  });

  it('an empty result held after started is never the answer while the model works (it replies after 4 hold windows)', async () => {
    for (const scenario of ['empty-then-slow', 'empty-before-started', 'no-lifecycle-slow']) {
      const { s, ends, asides } = make(scenario, 80); // the reply comes 300 ms later: like 8 s after a 5 s hold
      s.send('apply the update');
      await until(() => ends.length > 0);
      expect(ends, scenario).toMatchObject([{ text: 'resumed', isError: false, resultText: 'resumed' }]);
      expect(asides, scenario).toEqual([]);
    }
  });

  it('a turn of its own is not released as the reply while the message is still queued behind a longer own turn', async () => {
    const { s, ends, asides } = make('queued-behind-long', 80); // the second own turn is silent for 300 ms
    s.send('question');
    await until(() => ends.length > 0);
    expect(asides).toEqual([{ text: 'First.' }, { text: 'Second.' }]);
    expect(ends.map((e) => e.text)).toEqual(['answer']);
  });

  it('the process exits while a result is held: the turn ends once, as an error, and no timer fires later', async () => {
    const { s, ends, asides } = make('exit-while-held', 50);
    s.send('question');
    await until(() => ends.length > 0);
    await until(() => !s.running);
    // No hold timer is left to fire later.
    expect((s as unknown as { held: unknown }).held).toBeNull();
    expect(asides).toEqual([{ text: 'Own turn.' }]);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ isError: true, text: '' });
    expect(s.busy).toBe(false);
  });

  it('an empty result of no model call that is the only answer (a local command) ends the turn after the hold', async () => {
    const { s, ends } = make('no-lifecycle-local', 100);
    s.send('/cost');
    await until(() => ends.length > 0);
    expect(ends).toMatchObject([{ text: '', isError: false, resultText: '' }]);
    expect(s.busy).toBe(false);
  });

  it('a second message waits for the real end of the first one', async () => {
    const { s, ends, written } = make('resume-notice');
    s.send('first');
    s.send('second');
    await s.idle();
    expect(ends.map((e) => e.text)).toEqual(['resumed', 'next']);
    expect(written().map((w) => w.message.content)).toEqual(['first', 'second']);
  });

  it('a turn of its own while idle (a background agent finished) is an aside, not dropped, and does not stream', async () => {
    const { s, ends, asides, deltas } = make('background-later');
    s.send('start max');
    await until(() => ends.length > 0);
    expect(ends.map((e) => e.text)).toEqual(['started']);
    await until(() => asides.length > 0);
    expect(asides).toEqual([{ text: 'Max is done.' }]);
    expect(deltas).toEqual(['started']);
    // The next message is not affected.
    s.send('next one');
    await until(() => ends.length > 1);
    expect(ends.map((e) => e.text)).toEqual(['started', 'next']);
  });

  it('a message absorbed into a running turn (completed before the result) ends with that result', async () => {
    const { s, ends, asides } = make('absorbed');
    s.send('also this');
    await until(() => ends.length > 0);
    expect(ends.map((e) => e.text)).toEqual(['one and two']);
    expect(asides).toEqual([]);
  });
});
