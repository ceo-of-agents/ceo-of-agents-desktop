import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeSession, type Aside, type ClaudeSessionOptions, type TurnEnd } from '../../src/main/claude/session';
import type { Spawner } from '../../src/main/system/exec';

// Live captures (Claude Code 2.1.328) of messages written while a turn runs, replayed by fake-claude-replay.mjs.
const FIX = path.join(__dirname, '..', 'fixtures', 'claude');
const FAKE = path.join(FIX, 'fake-claude-replay.mjs');

let dir: string;
const sessions: ClaudeSession[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-mt-'));
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.stop()));
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Sends every message of the capture at once and returns the uuids (in order) and the turn ends. */
async function replay(fixture: string, count: number, extra: Partial<ClaudeSessionOptions> = {}) {
  const spawner: Spawner = (_cmd, _args, opts) => spawn(process.execPath, [FAKE], { ...opts, env: { ...process.env, FAKE_FIXTURE: path.join(FIX, fixture), FAKE_KEEP_OPEN: '1' } });
  const s = new ClaudeSession({ claudePath: 'claude', cwd: dir, args: ['-p'], spawner, ...extra });
  sessions.push(s);
  const ends: TurnEnd[] = [];
  s.on('turn-end', (e: TurnEnd) => ends.push(e));
  const uuids = Array.from({ length: count }, (_, i) => s.send(`message ${i}`));
  expect(s.busy).toBe(true);
  const t0 = Date.now();
  while (s.busy) {
    if (Date.now() - t0 > 20_000) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
  return { s, ends, uuids };
}

describe('ClaudeSession with messages written while a turn runs (live captures)', () => {
  it('a message written during a tool call is absorbed: one turn end answers both', async () => {
    const { ends, uuids } = await replay('midturn-s1-absorbed.jsonl', 2);
    expect(ends).toHaveLength(1);
    expect(ends[0].uuids).toEqual(uuids);
    expect(ends[0]).toMatchObject({ text: 'ALPHA\nBETA', isError: false });
  });

  it('two messages written during a tool call are both absorbed', async () => {
    const { ends, uuids } = await replay('midturn-s2-two.jsonl', 3);
    expect(ends).toHaveLength(1);
    expect(ends[0].uuids).toEqual(uuids);
    expect(ends[0].text).toBe('ALPHA\nBETA\nGAMMA');
  });

  it('a message written during streaming text gets its own turn: two turn ends, in order', async () => {
    const { ends, uuids } = await replay('midturn-s3-text.jsonl', 2);
    expect(ends.map((e) => e.uuids)).toEqual([[uuids[0]], [uuids[1]]]);
    expect(ends[0].text).toMatch(/^1 2 3 .* 150$/);
    expect(ends[1].text).toBe('DONE');
  });

  it('a message written at the result gets its own turn: two turn ends, in order', async () => {
    const { ends, uuids } = await replay('midturn-s4-after-result.jsonl', 2);
    expect(ends.map((e) => [e.uuids, e.text])).toEqual([
      [[uuids[0]], 'OK'],
      [[uuids[1]], 'YES'],
    ]);
  });
});

// Hand-made streams, in the shapes of the captures, written to a temp fixture and replayed the same way.
const life = (label: string, state: string) => ({ type: 'command_lifecycle', command_uuid: `uuid-${label}`, state, uuid: `evt-${label}-${state}`, session_id: 'sid-hm' });
const init = () => ({ type: 'system', subtype: 'init', session_id: 'sid-hm', model: 'claude-haiku-5-5' });
const text = (t: string) => [
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }, session_id: 'sid-hm', parent_tool_use_id: null },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] }, session_id: 'sid-hm', parent_tool_use_id: null },
];
const result = (t: string) => ({ type: 'result', subtype: 'success', is_error: false, result: t, num_turns: 1, session_id: 'sid-hm' });

/** Replays hand-made lines; `writes` say after which line (0-based, -1 = at the start) each message is written. */
async function replayLines(lines: object[], afterLines: number[], extra: Partial<ClaudeSessionOptions> = {}) {
  const file = path.join(dir, `hand-${sessions.length}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(file.replace(/\.jsonl$/, '.writes.json'), JSON.stringify(afterLines.map((afterLine, i) => ({ label: String.fromCharCode(65 + i), text: '', afterLine }))));
  const spawner: Spawner = (_cmd, _args, opts) => spawn(process.execPath, [FAKE], { ...opts, env: { ...process.env, FAKE_FIXTURE: file, FAKE_KEEP_OPEN: '1' } });
  const s = new ClaudeSession({ claudePath: 'claude', cwd: dir, args: ['-p'], spawner, ...extra });
  sessions.push(s);
  const ends: TurnEnd[] = [];
  const asides: Aside[] = [];
  s.on('turn-end', (e: TurnEnd) => ends.push(e));
  s.on('aside', (a: Aside) => asides.push(a));
  const uuids = afterLines.map((_, i) => s.send(`message ${i}`));
  return { s, ends, asides, uuids };
}
const until = async (cond: () => boolean, ms = 10_000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('ClaudeSession without lifecycle events, and partial lifecycle states', () => {
  it('B absorbed, lifecycle missing: the result answers A, and B is answered by the guard (empty text, not an error)', async () => {
    const { s, ends, uuids } = await replay('midturn-s1-nolifecycle.jsonl', 2, { absorbedMs: 300 });
    await until(() => !s.busy);
    expect(ends).toHaveLength(2);
    expect(ends[0]).toMatchObject({ uuids: [uuids[0]], text: 'ALPHA\nBETA' });
    expect(ends[1]).toEqual({ text: '', isError: false, resultText: '', uuids: [uuids[1]] });
  });

  it('the absorbed guard does not fire for a message whose own result arrives in time, and is cleared by it', async () => {
    const lines = [init(), ...text('a'), result('a'), init(), ...text('b'), result('b')];
    const { s, ends, uuids } = await replayLines(lines, [-1, 3], { absorbedMs: 200 });
    await until(() => !s.busy);
    await new Promise((r) => setTimeout(r, 400));
    expect(ends.map((e) => [e.uuids, e.text])).toEqual([[[uuids[0]], 'a'], [[uuids[1]], 'b']]);
  });

  it('[A started, B null]: a result ends A only; B is answered by its own later result', async () => {
    const lines = [life('A', 'queued'), life('A', 'started'), init(), ...text('a'), result('a'), init(), ...text('b'), result('b')];
    const { s, ends, uuids } = await replayLines(lines, [-1, 4], { absorbedMs: 60_000 });
    await until(() => !s.busy);
    expect(ends.map((e) => [e.uuids, e.text])).toEqual([[[uuids[0]], 'a'], [[uuids[1]], 'b']]);
  });

  it('[A queued, B null]: a result of a turn Claude Code started on its own is held, not given to A', async () => {
    const lines = [life('A', 'queued'), init(), ...text('own'), result('own'), life('A', 'started'), init(), ...text('a'), result('a')];
    const { s, ends, asides, uuids } = await replayLines(lines, [-1, 3], { holdMs: 60_000, absorbedMs: 60_000 });
    await until(() => ends.length > 0);
    expect(asides).toEqual([{ text: 'own' }]);
    expect(ends[0]).toMatchObject({ uuids: [uuids[0]], text: 'a' });
    expect(s.busy).toBe(true); // B is still waiting
  });

  it('a late completed after the result, for a message already ended: no crash, no extra turn end', async () => {
    const lines = [life('A', 'queued'), life('A', 'started'), init(), ...text('a'), result('a'), life('A', 'completed')];
    const { s, ends, uuids } = await replayLines(lines, [-1]);
    await until(() => !s.busy);
    await new Promise((r) => setTimeout(r, 300));
    expect(ends).toHaveLength(1);
    expect(ends[0].uuids).toEqual([uuids[0]]);
  });
});
