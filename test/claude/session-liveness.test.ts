import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeSession, type Aside, type ClaudeSessionOptions, type TurnEnd } from '../../src/main/claude/session';
import type { ClaudeEvent } from '../../src/main/claude/stream';
import type { Spawner } from '../../src/main/system/exec';

const FIX = path.join(__dirname, '..', 'fixtures', 'claude');
const FAKE = path.join(FIX, 'fake-claude-lifecycle.mjs');
const REPORT = 'The background agent finished and returned `pong`.';

let dir: string;
const sessions: ClaudeSession[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-live-'));
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.stop()));
  fs.rmSync(dir, { recursive: true, force: true });
});

function make(scenario: string, env: Record<string, string> = {}, opts: Partial<ClaudeSessionOptions> = {}) {
  const logFile = path.join(dir, 'stdin.log');
  const spawner: Spawner = (_cmd, _args, opts) => spawn(process.execPath, [FAKE], { ...opts, env: { ...process.env, FAKE_SCENARIO: scenario, FAKE_LOG: logFile, ...env } });
  const s = new ClaudeSession({ claudePath: 'claude', cwd: dir, args: ['-p'], spawner, ...opts });
  sessions.push(s);
  const log: string[] = [];
  const ends: TurnEnd[] = [];
  const asides: Aside[] = [];
  const pending: boolean[] = [];
  const stream: ClaudeEvent[] = [];
  s.on('turn-end', (e: TurnEnd) => {
    ends.push(e);
    log.push(`end:${e.text}`);
  });
  s.on('aside', (a: Aside) => {
    asides.push(a);
    log.push(`aside:${a.text}`);
  });
  s.on('report-pending', (v: boolean) => {
    pending.push(v);
    log.push(`pending:${v}`);
  });
  s.on('stream', (e: ClaudeEvent) => stream.push(e));
  const written = () => fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { s, log, ends, asides, pending, stream, written };
}

const until = async (cond: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('ClaudeSession report pending (dispatch-race.jsonl replayed with the session uuids)', () => {
  const race = { FAKE_FIXTURE: path.join(FIX, 'dispatch-race.jsonl'), FAKE_DELAY_MS: '5' };

  it('a message sent when the notification arrives: the report is an aside, the turn ends with the answer to it', async () => {
    const { s, log, ends, asides, pending, stream, written } = make('race-recorded', race);
    let sentB = false;
    const seenOnNotification: boolean[] = [];
    s.on('stream', (e: ClaudeEvent) => {
      if (e.kind === 'task-ended' && e.notification && e.topLevel && !sentB) {
        sentB = true;
        seenOnNotification.push(s.reportPending);
        s.send('B');
      }
    });
    s.send('dispatch it');
    await until(() => ends.length === 2 && !s.busy);
    expect(sentB).toBe(true);
    // reportPending is already true when the notification reaches the stream listeners
    expect(seenOnNotification).toEqual([true]);
    expect(ends[0]).toMatchObject({ text: 'dispatched.', isError: false, resultText: 'dispatched.' });
    expect(asides).toEqual([{ text: REPORT }]);
    expect(ends[1]).toMatchObject({ text: 'B', isError: false, resultText: 'B' });
    // the report is not the turn of B: an aside, then B's own turn-end
    expect(log.filter((l) => !l.startsWith('pending'))).toEqual(['end:dispatched.', `aside:${REPORT}`, 'end:B']);
    expect(pending).toEqual([true, false]);
    expect(s.reportPending).toBe(false);
    // the report's result reached the stream before B's
    expect(stream.filter((e) => e.kind === 'result').map((e) => (e as { text: string }).text)).toEqual(['dispatched.', REPORT, 'B']);
    // the uuids the session wrote are the ones Claude Code was told about (the fake mapped the recorded ones to them)
    const w = written();
    expect(w.map((m) => m.message.content)).toEqual(['dispatch it', 'B']);
    expect(w[0].uuid).not.toBe(w[1].uuid);
  });

  it('reportPending is true from the notification to the report result, and false for the turns around it', async () => {
    const { s, pending, stream } = make('race-recorded', race);
    const states: Array<[string, boolean]> = [];
    let sentB = false;
    s.on('stream', (e: ClaudeEvent) => {
      if (e.kind === 'task-ended' && e.notification && e.topLevel && !sentB) {
        sentB = true;
        states.push(['notification', s.reportPending]);
        s.send('B');
      }
      if (e.kind === 'result') states.push([`result:${(e as { text: string }).text}`, s.reportPending]);
    });
    s.send('dispatch it');
    await until(() => stream.filter((e) => e.kind === 'result').length === 3);
    // the result reaches the stream listeners first, the flag drops right after it (the 'report-pending' false)
    expect(states).toEqual([
      ['result:dispatched.', false],
      ['notification', true],
      [`result:${REPORT}`, true],
      ['result:B', false],
    ]);
    expect(pending).toEqual([true, false]);
    expect(s.reportPending).toBe(false);
  });
});

describe('ClaudeSession pending reports, one per notification', () => {
  const notified = (s: ClaudeSession) => new Promise<void>((r) => s.on('stream', (e: ClaudeEvent) => e.kind === 'task-ended' && e.notification && e.topLevel && r()));
  /** Waits for the notification of the first message's agent, then sends a message of ours and waits for its turn. */
  const settle = async (s: ClaudeSession, ends: TurnEnd[]) => {
    s.send('x');
    await until(() => ends.length === 2);
    await s.idle();
  };

  it('a foreground agent\'s notification does not set it', async () => {
    const { s, pending, ends } = make('rp-one', { FAKE_BG: 'false' });
    s.send('dispatch it');
    await notified(s);
    expect(s.reportPending).toBe(false);
    await settle(s, ends);
    expect(s.reportPending).toBe(false);
    expect(pending).toEqual([]);
  });

  it.each(['stopped', 'killed', 'cancelled'])('a background agent that was %s does not set it', async (status) => {
    const { s, pending, ends } = make('rp-one', { FAKE_STATUS: status });
    s.send('dispatch it');
    await notified(s);
    expect(s.reportPending).toBe(false);
    await settle(s, ends);
    expect(s.reportPending).toBe(false);
    expect(pending).toEqual([]);
  });

  it.each(['completed', 'failed', 'error'])('a background agent that %s sets it, and its report turn clears it', async (status) => {
    const { s, pending, asides } = make('rp-one', { FAKE_STATUS: status, FAKE_OWN: '1' });
    const seen: boolean[] = [];
    s.on('aside', () => seen.push(s.reportPending));
    s.send('dispatch it');
    await until(() => asides.length === 1);
    expect(seen).toEqual([false]); // already cleared when the aside is shown
    expect(pending).toEqual([true, false]);
    expect(s.reportPending).toBe(false);
  });

  it('a result of no model call (num_turns 0) of Claude Code\'s own consumes one report too', async () => {
    const { s, pending, stream } = make('report-pending-empty');
    s.send('dispatch it');
    await notified(s);
    expect(s.reportPending).toBe(true);
    await until(() => stream.some((e) => e.kind === 'result' && e.numTurns === 0));
    expect(s.reportPending).toBe(false);
    expect(pending).toEqual([true, false]);
  });

  it('two notifications close together while idle need two own-turn results', async () => {
    const { s, pending, asides } = make('rp-two');
    const seen: boolean[] = [];
    s.on('aside', () => seen.push(s.reportPending));
    s.send('dispatch it');
    await until(() => asides.length === 2);
    expect(asides.map((a) => a.text)).toEqual(['report a', 'report b']);
    // after the first report still pending, after the second not
    expect(seen).toEqual([true, false]);
    expect(pending).toEqual([true, false]); // it flips once each way
    expect(s.reportPending).toBe(false);
  });

  describe('a message of ours around the notification', () => {
    const race = (scenario: string) => {
      const m = make(scenario);
      const turnEnds: boolean[] = [];
      m.s.on('turn-end', () => turnEnds.push(m.s.reportPending));
      return { ...m, turnEnds };
    };

    it('the notification came while idle and our message started before any own turn: our turn carries it and clears it', async () => {
      const { s, pending, asides, ends, turnEnds } = race('rp-fold');
      s.send('dispatch it');
      await notified(s);
      expect(s.reportPending).toBe(true);
      s.send('M');
      await until(() => ends.length === 2);
      expect(ends[1].text).toBe('M');
      expect(asides).toEqual([]);
      expect(turnEnds).toEqual([false, false]);
      expect(pending).toEqual([true, false]);
      expect(s.reportPending).toBe(false);
    });

    it('the notification came while our message was queued: the own report turn consumes it before our turn starts', async () => {
      const { s, log, pending, asides, ends, turnEnds } = race('rp-queued-own');
      s.send('dispatch it');
      await until(() => ends.length === 1);
      s.send('M');
      await until(() => ends.length === 2);
      expect(asides).toEqual([{ text: 'report' }]);
      expect(ends[1].text).toBe('M');
      expect(pending).toEqual([true, false]);
      // cleared by the report turn (right after its aside), not left for the end of our turn
      expect(log).toEqual(['end:dispatched.', 'pending:true', 'pending:false', 'aside:report', 'end:M']);
      expect(turnEnds).toEqual([false, false]);
    });

    it('our turn ends before the own report turn comes: still pending after our turn, cleared by the own turn', async () => {
      const { s, log, pending, asides, ends, turnEnds } = race('rp-queued-completed');
      s.send('dispatch it');
      await until(() => ends.length === 1);
      s.send('M');
      await until(() => ends.length === 2);
      expect(ends[1].text).toBe('M');
      expect(turnEnds).toEqual([false, true]); // our turn did not clear a report that was still to come
      expect(s.reportPending).toBe(true);
      await until(() => asides.length === 1);
      expect(asides).toEqual([{ text: 'report' }]);
      expect(s.reportPending).toBe(false);
      expect(pending).toEqual([true, false]);
      expect(log).toEqual(['end:dispatched.', 'pending:true', 'end:M', 'pending:false', 'aside:report']);
    });
  });

  describe('a notification with no report turn at all', () => {
    it('is given up at the second turn end that did not carry it, without waiting for the timer', async () => {
      const { s, pending, ends } = make('rp-queued-never');
      s.send('dispatch it');
      await until(() => ends.length === 1);
      s.send('M');
      await until(() => ends.length === 2);
      expect(s.reportPending).toBe(true); // our turn did not carry it: one turn end
      s.send('N');
      await until(() => ends.length === 3);
      expect(ends[2].text).toBe('N');
      expect(s.reportPending).toBe(false);
      expect(pending).toEqual([true, false]);
    });

    it('is given up after reportIdleMs of silence', async () => {
      const { s, pending } = make('rp-one', {}, { reportIdleMs: 150 });
      s.send('dispatch it');
      await notified(s);
      const t0 = Date.now();
      expect(s.reportPending).toBe(true);
      await until(() => pending.length === 2);
      expect(pending).toEqual([true, false]);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
      expect(s.reportPending).toBe(false);
    });

    it('any stream event re-arms the timer', async () => {
      const idle = 400;
      const beat = 80;
      const beats = 8; // 640 ms of events, longer than the timeout
      const { s, pending, stream } = make('rp-keepalive', { FAKE_BEATS: String(beats), FAKE_BEAT_MS: String(beat) }, { reportIdleMs: idle });
      let lastEvent = 0;
      let clearedAt = 0;
      s.on('stream', (e: ClaudeEvent) => {
        if (e.kind === 'task-progress') lastEvent = Date.now();
      });
      s.on('report-pending', (v: boolean) => {
        if (!v) clearedAt = Date.now();
      });
      s.send('dispatch it');
      await until(() => pending.length === 2);
      const progressSeen = stream.filter((e) => e.kind === 'task-progress').length;
      // the whole burst arrived before it was given up, and the timeout counted from its last event
      expect(progressSeen).toBe(beats);
      expect(clearedAt - lastEvent).toBeGreaterThanOrEqual(idle - 50);
      expect(pending).toEqual([true, false]);
    });
  });

  describe('exit', () => {
    it('stopping the process clears it and says so', async () => {
      const { s, pending } = make('rp-one');
      s.send('dispatch it');
      await notified(s);
      expect(s.reportPending).toBe(true);
      await s.stop();
      expect(s.running).toBe(false);
      expect(s.reportPending).toBe(false);
      expect(pending).toEqual([true, false]);
    });

    it('a crash clears it and says so', async () => {
      const { s, pending } = make('rp-one', { FAKE_EXIT: '1' });
      s.send('dispatch it');
      await notified(s);
      await until(() => !s.running);
      expect(s.reportPending).toBe(false);
      expect(pending).toEqual([true, false]);
    });
  });

  it('only a top-level notification sets it', async () => {
    const { s, pending } = make('absorbed');
    s.send('hello');
    await s.idle();
    expect(s.reportPending).toBe(false);
    expect(pending).toEqual([]);
  });
});
