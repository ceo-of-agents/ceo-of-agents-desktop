import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeSession, limitStop, userContent, userLine } from '../../src/main/claude/session';
import { attachment } from '../helpers-images';
import type { Spawner } from '../../src/main/system/exec';

const FIX = path.join(__dirname, '..', 'fixtures', 'claude');
const FAKE = path.join(FIX, 'fake-claude.mjs');

let dir: string;
const sessions: ClaudeSession[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-sess-'));
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.stop()));
  fs.rmSync(dir, { recursive: true, force: true });
});

function make(fixture: string, extraEnv: Record<string, string> = {}) {
  const spawns: string[][] = [];
  const spawner: Spawner = (_cmd, args, opts) => {
    spawns.push(args);
    return spawn(process.execPath, [FAKE], { ...opts, env: { ...process.env, FAKE_FIXTURE: path.join(FIX, fixture), ...extraEnv } });
  };
  const s = new ClaudeSession({ claudePath: 'claude', cwd: dir, args: ['-p'], spawner });
  sessions.push(s);
  const log: Array<[string, unknown]> = [];
  for (const ev of ['init', 'delta', 'tool', 'turn-end', 'state', 'exit']) s.on(ev, (...a: unknown[]) => log.push([ev, a.length > 1 ? a : a[0]]));
  return { s, spawns, log };
}

const once = (s: ClaudeSession, ev: string) => new Promise<unknown>((r) => s.once(ev, (...a: unknown[]) => r(a.length > 1 ? a : a[0])));

describe('ClaudeSession', () => {
  it('spawns lazily, streams deltas and ends the turn', async () => {
    const { s, spawns, log } = make('plain-reply.jsonl');
    expect(s.running).toBe(false);
    expect(spawns).toHaveLength(0);
    const end = once(s, 'turn-end');
    s.send('hello');
    expect(s.busy).toBe(true);
    expect(spawns).toHaveLength(1);
    expect(await end).toMatchObject({ text: 'ok', isError: false, resultText: 'ok' });
    expect(s.busy).toBe(false);
    expect(s.sessionId).toBe('fake-id-1_001');
    expect(s.model).toBe('claude-haiku-5-5');
    expect(log.find(([e]) => e === 'init')?.[1]).toEqual(['fake-id-1_001', 'claude-haiku-5-5', [], []]);
    expect(log.filter(([e]) => e === 'delta').map(([, v]) => v)).toEqual(['ok']);
    expect(log.some(([e]) => e === 'init')).toBe(true);
    await s.idle();
    expect(s.running).toBe(true);
  });

  it('emits plan usage, and a failed turn on a usage limit carries the limit and its reset time', async () => {
    const ok = make('rate-limit-allowed.jsonl');
    const usage = once(ok.s, 'rate-limit');
    const end1 = once(ok.s, 'turn-end');
    ok.s.send('hi');
    expect(await usage).toMatchObject({ status: 'allowed_warning' });
    expect(await end1).toMatchObject({ text: 'ok', isError: false, resultText: 'ok' });
    const no = make('rate-limit-rejected.jsonl');
    const end2 = once(no.s, 'turn-end');
    no.s.send('hi');
    expect(await end2).toMatchObject({ isError: true, limit: { limitType: 'five_hour', resetsAt: new Date(1795042800 * 1000).toISOString() } });
  });

  it('emits the context size of each result (recorded fixture), without changing the turn end', async () => {
    const { s } = make('write-permission.jsonl');
    const sizes: unknown[] = [];
    s.on('context', (n: unknown) => sizes.push(n));
    const end = once(s, 'turn-end');
    s.send('go');
    expect(await end).toMatchObject({ isError: false });
    expect(sizes).toEqual([21529]);
  });

  it('limitStop: 429 or a rejected status is a limit, any other error is not', () => {
    expect(limitStop(500, null)).toBeNull();
    expect(limitStop(null, { status: 'allowed', limitType: null, resetsAt: null, windows: [] })).toBeNull();
    expect(limitStop(429, null)).toEqual({ limitType: null, resetsAt: null });
    const w = { key: 'seven_day', utilization: 1, resetsAt: '2026-11-20T09:00:00.000Z', status: 'rejected' };
    expect(limitStop(null, { status: 'rejected', limitType: null, resetsAt: null, windows: [w] })).toEqual({ limitType: 'seven_day', resetsAt: w.resetsAt });
  });

  it('writes a second message at once; each result answers the oldest message (no lifecycle events)', async () => {
    const logFile = path.join(dir, 'stdin.log');
    const { s, spawns, log } = make('two-messages.jsonl', { FAKE_LOG: logFile, FAKE_DELAY_MS: '30' });
    const ends: Array<{ text: string; uuids: string[] }> = [];
    s.on('turn-end', (e) => ends.push(e));
    const first = s.send('first');
    const second = s.send('second');
    expect(first).not.toBe(second);
    expect(s.stateOf(first)).toBeNull();
    expect(s.stateOf('unknown')).toBeUndefined();
    await s.idle();
    const written = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(written.map((w) => w.message.content)).toEqual(['first', 'second']);
    expect(written.map((w) => w.uuid)).toEqual([first, second]);
    expect(written[0]).toMatchObject({ type: 'user', message: { role: 'user' } });
    expect(spawns).toHaveLength(1);
    expect(ends.map((e) => [e.text, e.uuids])).toEqual([
      ['one', [first]],
      ['two', [second]],
    ]);
    const states = log.filter(([e]) => e === 'state').map(([, v]) => v as { busy: boolean; pending: number });
    expect(states[states.length - 1]).toEqual({ busy: false, pending: 0 });
    expect(states.some((x) => x.busy && x.pending === 2)).toBe(true);
  });

  it('skips non-JSON lines', async () => {
    const { s } = make('plain-reply.jsonl', { FAKE_NOISE: '1' });
    const end = once(s, 'turn-end');
    s.send('x');
    expect(await end).toMatchObject({ text: 'ok', isError: false });
  });

  it('emits tool events', async () => {
    const { s, log } = make('write-permission.jsonl');
    const end = once(s, 'turn-end');
    s.send('write');
    const te = (await end) as { text: string };
    expect(te.text).toBe('Done.');
    expect(log.find(([e]) => e === 'tool')?.[1]).toEqual(['Write', { file_path: '/tmp/hq/note.md', content: 'hi' }, 'toolu_fake3_006']);
  });

  it('reports a crash mid-turn as one error turn end for every message written, then respawns on send', async () => {
    const { s, spawns, log } = make('two-messages.jsonl', { FAKE_EXIT_MID_TURN: '1' });
    const first = s.send('first');
    const second = s.send('second');
    const exit = await once(s, 'exit');
    expect(exit).toEqual({ code: 3, duringTurn: true });
    const order = log.map(([e]) => e).filter((e) => e === 'turn-end' || e === 'exit');
    expect(order).toEqual(['turn-end', 'exit']);
    expect(log.find(([e]) => e === 'turn-end')?.[1]).toMatchObject({ isError: true, uuids: [first, second] });
    expect(s.running).toBe(false);
    expect(s.busy).toBe(false);
    s.restart();
    expect(spawns).toHaveLength(2);
    await s.stop();
  });

  it('stop() ends stdin and resolves on exit', async () => {
    const { s } = make('plain-reply.jsonl');
    s.send('x');
    await s.idle();
    expect(s.running).toBe(true);
    await s.stop();
    expect(s.running).toBe(false);
    await s.stop();
  });

  it('idle() resolves at once when nothing is going on', async () => {
    const { s } = make('plain-reply.jsonl');
    await s.idle();
  });

  it('setArgs changes the args used at the next spawn', async () => {
    const { s, spawns } = make('plain-reply.jsonl');
    s.setArgs(['-p', '--resume', 'abc']);
    s.send('x');
    await s.idle();
    expect(spawns[0]).toEqual(['-p', '--resume', 'abc']);
  });

  it('a bare init with no turn in flight does not make the session busy', async () => {
    const { s } = make('plain-reply.jsonl');
    s.send('x');
    await s.idle();
    // a second init on the same process, nothing after it
    const child = (s as unknown as { child: { stdout: { emit: (ev: string, d: Buffer) => void } } }).child;
    child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake-id-1_001', model: 'claude-haiku-5-5' }) + '\n'));
    await new Promise((r) => setTimeout(r, 50));
    expect(s.busy).toBe(false);
    expect(s.running).toBe(true);
  });
});

describe('images in the stdin line', () => {
  const png = attachment('image/png');
  const jpg = attachment('image/jpeg');

  it('text only: content is the plain string, as before', () => {
    expect(userContent('hi')).toBe('hi');
    expect(userContent('hi', [])).toBe('hi');
    expect(JSON.parse(userLine('hi'))).toEqual({ type: 'user', message: { role: 'user', content: 'hi' } });
    expect(userLine('hi').endsWith('\n')).toBe(true);
  });

  it('text and images: the image blocks first, then the text block', () => {
    expect(userContent('what is this?', [png, jpg])).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.data } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpg.data } },
      { type: 'text', text: 'what is this?' },
    ]);
  });

  it('images only: no text block', () => {
    expect(userContent('', [png])).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.data } }]);
  });

  it('PDFs: a document block before the images and the text, with the title and the base64', () => {
    const doc = { title: 'report.pdf', data: Buffer.from('%PDF-1.4 x').toString('base64') };
    const block = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: doc.data }, title: 'report.pdf' };
    expect(userContent('read it', [], [doc])).toEqual([block, { type: 'text', text: 'read it' }]);
    expect(userContent('read it', [png], [doc])).toEqual([block, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.data } }, { type: 'text', text: 'read it' }]);
    expect(userContent('', undefined, [doc])).toEqual([block]);
    expect(userContent('hi', [], [])).toBe('hi');
    expect(JSON.parse(userLine('read it', undefined, 'u1', [doc]))).toEqual({ type: 'user', uuid: 'u1', message: { role: 'user', content: [block, { type: 'text', text: 'read it' }] } });
  });

  it('a session writes the content blocks to stdin, and a plain message after it as a string', async () => {
    const logFile = path.join(dir, 'stdin.log');
    const { s } = make('two-messages.jsonl', { FAKE_LOG: logFile });
    s.send('look', [png]);
    s.send('thanks');
    await s.idle();
    const written = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(written[0].message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.data } },
      { type: 'text', text: 'look' },
    ]);
    expect(written[1].message.content).toBe('thanks');
  });
});
