import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Thread, finishSteps, type ThreadOptions, type TurnResult } from '../../src/main/org/thread';
import { localDay } from '../../src/main/claude/session-store';
import { CONTINUATION_MARKER } from '../../src/main/org/continuation';
import { commandContext } from '../../src/main/system/user-command';
import type { AppEvent } from '../../src/shared/types';
import { fakeFactory, waitFor, type Factory } from './helpers';

let dir: string;
let factory: Factory;
const threads: Thread[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-thread-'));
});
afterEach(async () => {
  await Promise.all(threads.splice(0).map((t) => t.stop()));
  fs.rmSync(dir, { recursive: true, force: true });
});

function setup(opts: { env?: Parameters<typeof fakeFactory>[1]; stored?: { sessionId: string; day: string } | null; fresh?: { idleMs: () => number; sizeTokens?: () => number }; canStart?: () => string | null; now?: () => Date; cwd?: string; onModelSeen?: (m: string) => void; holdRestart?: () => boolean; needsRestart?: () => boolean } = {}) {
  factory = fakeFactory(dir, opts.env ?? {});
  const events: AppEvent[] = [];
  const store = { stored: opts.stored ?? null, sets: [] as Array<[string, string]>, clears: 0 };
  const o: ThreadOptions = {
    orgId: 'o1',
    threadId: 'cos',
    title: 'T',
    speaker: 'Ada',
    cwd: opts.cwd,
    logFile: path.join(dir, 'log.jsonl'),
    makeSession: factory.makeSession,
    sessions: {
      get: () => store.stored,
      set: (id, day) => {
        store.stored = { sessionId: id, day };
        store.sets.push([id, day]);
      },
      clear: () => {
        store.stored = null;
        store.clears++;
      },
    },
    fresh: opts.fresh && { sizeTokens: () => 0, ...opts.fresh },
    holdRestart: opts.holdRestart,
    needsRestart: opts.needsRestart,
    canStart: opts.canStart,
    emit: (e) => events.push(e),
    now: opts.now,
    onModelSeen: opts.onModelSeen,
  };
  const th = new Thread(o);
  threads.push(th);
  return { th, events, store };
}
const idle = (th: Thread) => waitFor(() => !th.busy);
const user = (text: string) => ({ kind: 'user' as const, author: 'You', text });

describe('Thread resolved model', () => {
  it('takes the model of the init message into the state and the assistant entries, and keeps it across restarts', async () => {
    const seen: string[] = [];
    const { th, events } = setup({ env: (n): Record<string, string> => (n === 0 ? { FAKE_MODEL: 'claude-opus-5-5' } : {}), onModelSeen: (m) => seen.push(m) });
    expect(th.state().resolvedModel).toBeNull();
    th.enqueue('one', 'user', user('one'));
    await idle(th);
    expect(th.state().resolvedModel).toBe('claude-opus-5-5');
    expect(seen).toEqual(['claude-opus-5-5']);
    expect(events.some((e) => e.type === 'thread-state' && e.state.resolvedModel === 'claude-opus-5-5')).toBe(true);
    const a = th.info().entries.filter((e) => e.kind === 'assistant');
    expect(a.map((e) => e.model)).toEqual(['claude-opus-5-5']);
    expect(th.info().entries.find((e) => e.kind === 'user')?.model).toBeUndefined();
    // a new process whose init has no model keeps the last one
    await th.restart();
    th.enqueue('two', 'user', user('two'));
    await idle(th);
    expect(th.state().resolvedModel).toBe('claude-opus-5-5');
    expect(seen).toEqual(['claude-opus-5-5']);
  });

  it('a new init with another model replaces it', async () => {
    const { th } = setup({ env: (n) => ({ FAKE_MODEL: n === 0 ? 'claude-opus-5-5' : 'claude-sonnet-4-5-20250929' }) });
    th.enqueue('one', 'user', user('one'));
    await idle(th);
    await th.restart();
    th.enqueue('two', 'user', user('two'));
    await idle(th);
    expect(th.state().resolvedModel).toBe('claude-sonnet-4-5-20250929');
    expect(th.info().entries.filter((e) => e.kind === 'assistant').map((e) => e.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-4-5-20250929']);
  });
});

describe('Thread failed connectors', () => {
  const errors = (th: Thread) => th.info().entries.filter((e) => e.kind === 'error').map((e) => e.text);

  it('shows one error line per failed server, once per process; the app\'s own server is ignored', async () => {
    const { th } = setup({ env: { FAKE_MCP_FAILED: 'github,coa,docs' } });
    th.enqueue('one', 'user', user('one'));
    await idle(th);
    const expected = ['The connector github could not start. The chat goes on without it.', 'The connector docs could not start. The chat goes on without it.'];
    expect(errors(th)).toEqual(expected);
    // a second turn of the same process sends another init: no new line
    th.enqueue('two', 'user', user('two'));
    await idle(th);
    expect(errors(th)).toEqual(expected);
    // a new process reports again
    await th.restart();
    th.enqueue('three', 'user', user('three'));
    await idle(th);
    expect(errors(th)).toEqual([...expected, ...expected]);
  });

  it('no line when no server failed', async () => {
    const { th } = setup();
    th.enqueue('one', 'user', user('one'));
    await idle(th);
    expect(errors(th)).toEqual([]);
  });
});

describe('Thread messages sent at once', () => {
  it('every message is written at once; handoffsWaiting counts handoffs behind another unanswered message only', async () => {
    const { th } = setup({ env: { FAKE_DELAY_MS: '150' } });
    th.enqueue('one', 'user', user('one'));
    await waitFor(() => th.busy);
    expect(th.state()).toMatchObject({ busy: true, handoffsWaiting: 0 });
    th.enqueue('two', 'user', user('two'));
    th.enqueue('three', 'handoff', null, 'handoff:t9');
    expect(th.state()).toMatchObject({ busy: true, handoffsWaiting: 1, handoffTabs: ['t9'] });
    expect(th.handoffsWaiting).toBe(1);
    await idle(th);
    expect(th.state()).toMatchObject({ busy: false, handoffsWaiting: 0 });
    expect(th.info().entries.filter((e) => e.kind === 'assistant')).toHaveLength(3);
  });

  it('a message sent mid-turn is written at once: both are answered, the state has no queued count', async () => {
    const { th } = setup({ env: { FAKE_DELAY_MS: '100' } });
    const results: TurnResult[] = [];
    th.onTurnEnd((r) => results.push(r));
    th.enqueue('one', 'user', user('one'), 'tag-1');
    await waitFor(() => th.busy);
    th.enqueue('two', 'user', user('two'), 'tag-2');
    expect(th.state()).not.toHaveProperty('queued');
    expect(th.hasTag('tag-1') && th.hasTag('tag-2')).toBe(true);
    await waitFor(() => results.length === 2);
    await idle(th);
    expect(results.map((r) => r.sent.map((m) => m.tag))).toEqual([['tag-1'], ['tag-2']]);
    expect(th.info().entries.filter((e) => e.kind === 'assistant')).toHaveLength(2);
    expect(factory.sessions).toHaveLength(1);
    expect(th.hasTag('tag-1') || th.hasTag('tag-2')).toBe(false);
  });

  it('canStart reason drops the unsent message and logs an error entry', async () => {
    const { th, events } = setup({ canStart: () => 'Claude too old' });
    th.enqueue('a', 'user', user('a'));
    await new Promise((r) => setTimeout(r, 50));
    expect(th.busy).toBe(false);
    expect(factory.sessions).toHaveLength(0);
    const errs = th.info().entries.filter((e) => e.kind === 'error');
    expect(errs.map((e) => e.text)).toEqual(['Claude too old']);
    expect(events.some((e) => e.type === 'thread-entry' && e.entry.kind === 'error')).toBe(true);
  });
});

describe('Thread output', () => {
  it('appends assistant text with the speaker as author, and emits deltas and state', async () => {
    const { th, events, store } = setup({ env: { FAKE_REPLY: 'hello there', FAKE_SID: 'S1' } });
    th.enqueue('hi', 'user', user('hi'));
    await idle(th);
    const entries = th.info().entries;
    expect(entries.map((e) => [e.kind, e.author, e.text])).toEqual([
      ['user', 'You', 'hi'],
      ['assistant', 'Ada', 'hello there'],
    ]);
    expect(entries[1].sessionId).toBe('S1');
    expect(events.filter((e) => e.type === 'thread-delta').map((e) => (e as { text: string }).text)).toEqual(['hello there']);
    expect(events.some((e) => e.type === 'thread-state')).toBe(true);
    expect(store.sets).toEqual([['S1', localDay(new Date())]]);
    expect(th.sessionId).toBe('S1');
    expect(th.info().streaming).toBe('');
    // the log is on disk
    expect(fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('onTurnEnd listeners receive sent.tag and the tools of that turn', async () => {
    const tools = [{ name: 'Write', input: { file_path: 'inbox/a.md' } }];
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { th } = setup({ env: { FAKE_TOOLS: JSON.stringify(tools) } });
    const results: TurnResult[] = [];
    th.onTurnEnd((r) => results.push(r));
    th.onTurnEnd(() => {
      throw new Error('listener boom');
    });
    th.enqueue('go', 'user', null, 'mytag');
    await idle(th);
    expect(results).toHaveLength(1);
    expect(results[0].sent).toEqual([{ text: 'go', kind: 'user', tag: 'mytag' }]);
    expect(results[0].tools).toEqual([{ id: 'tu0', name: 'Write', input: { file_path: 'inbox/a.md' }, ok: false }]); // no tool result seen: not ok
    expect(results[0].text).toBe('ok');
    expect(th.info().entries.some((e) => e.kind === 'tool')).toBe(false);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('hasTag is true while a tagged message is not answered yet; offTurnEnd removes a listener', async () => {
    const { th } = setup({ env: { FAKE_DELAY_MS: '100' } });
    const seen: TurnResult[] = [];
    const fn = (r: TurnResult) => seen.push(r);
    th.onTurnEnd(fn);
    th.enqueue('one', 'user', null);
    th.enqueue('two', 'user', null, 'tag2');
    expect(th.hasTag('tag2')).toBe(true);
    expect(th.hasTag('other')).toBe(false);
    await waitFor(() => seen.length === 1);
    expect(seen[0].sent[0].tag).toBeUndefined();
    expect(th.hasTag('tag2')).toBe(true);
    th.offTurnEnd(fn);
    await idle(th);
    expect(th.hasTag('tag2')).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it('a listener that removes itself does not make the next one miss the turn', async () => {
    const { th } = setup();
    const calls: string[] = [];
    const first = () => {
      calls.push('first');
      th.offTurnEnd(first);
    };
    th.onTurnEnd(first);
    th.onTurnEnd(() => calls.push('second'));
    th.enqueue('one', 'user', null);
    await idle(th);
    expect(calls).toEqual(['first', 'second']);
  });
});

describe('Thread sessions', () => {
  const noon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12);

  it('a thread without `fresh` (a tab) resumes whatever is stored', async () => {
    const now = noon(2026, 3, 10);
    const { th } = setup({ now: () => now, stored: { sessionId: 'TAB', day: '2020-01-01' } });
    th.enqueue('x', 'user', null);
    await idle(th);
    expect(factory.resumeIds).toEqual(['TAB']);
    expect(th.info().entries.filter((e) => e.kind === 'session')).toHaveLength(0);
  });

  it('a thread without `fresh` resumes the live id after a needsRestart, with no divider', async () => {
    let restart = false;
    const { th } = setup({ needsRestart: () => restart, env: { FAKE_SID: 'LIVE' } });
    th.enqueue('a', 'user', null);
    await idle(th);
    restart = true;
    th.enqueue('b', 'user', null);
    await idle(th);
    expect(factory.resumeIds).toEqual([null, 'LIVE']);
    expect(th.info().entries.filter((e) => e.kind === 'session')).toHaveLength(0);
  });

  it('stale resume: clears the store and resends the same text on a fresh session', async () => {
    const logFile = path.join(dir, 'fake.log');
    const now = noon(2026, 3, 10);
    const { th, store } = setup({
      now: () => now,
      stored: { sessionId: 'GONE', day: localDay(now) },
      env: (n) => ({ FAKE_STALE_RESUME: '1', FAKE_SID: `S${n}`, FAKE_LOG: logFile, FAKE_REPLY: 'fresh answer' }),
    });
    th.enqueue('hello', 'user', null);
    await idle(th);
    expect(factory.resumeIds).toEqual(['GONE', null]);
    expect(store.clears).toBe(1);
    const entries = th.info().entries;
    expect(entries.filter((e) => e.kind === 'error')).toHaveLength(0);
    expect(entries.filter((e) => e.kind === 'assistant').map((e) => e.text)).toEqual(['fresh answer']);
    const sent = fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l).message.content);
    expect(sent).toEqual(['hello', 'hello']);
  });
});

describe('Thread fresh sessions (the chief of staff)', () => {
  const MIN = 60_000;
  const logFile = () => path.join(dir, 'fake.log');
  /** The fake's log: "ARGS" marks a process start, a JSON line is a message it got. */
  const wire = () =>
    fs
      .readFileSync(logFile(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => (l.startsWith('ARGS') ? 'START' : (JSON.parse(l).message.content as string)));
  const kinds = (th: Thread) => th.info().entries.map((e) => e.kind);
  const dividers = (th: Thread) => th.info().entries.filter((e) => e.kind === 'session');
  const sys = (th: Thread) => th.info().entries.filter((e) => e.kind === 'system').map((e) => e.text);
  const clock = (h: number, m: number, d = 10) => new Date(2026, 2, d, h, m);
  const env = (extra: Record<string, string> = {}) => (n: number): Record<string, string> => ({ FAKE_SID: `S${n}`, FAKE_LOG: logFile(), ...extra });
  const mk = (over: Parameters<typeof setup>[0] = {}) => {
    const clk = { t: over.now ? over.now() : clock(12, 0) };
    const o = setup({ fresh: { idleMs: () => 30 * MIN }, env: env(), ...over, now: () => clk.t });
    return { ...o, clk };
  };

  it('app open: a stored id from today is not resumed; the first message starts a new session and a divider comes before it', async () => {
    const { th } = mk({ stored: { sessionId: 'OLD', day: localDay(clock(12, 0)) } });
    th.enqueue('one', 'user', user('one'));
    await idle(th);
    expect(factory.resumeIds).toEqual([null]);
    expect(kinds(th)).toEqual(['session', 'user', 'assistant']);
    expect(dividers(th)[0]).toMatchObject({ text: '', author: '' });
    expect(dividers(th)[0].sessionId).toBeUndefined();
  });

  it('a second message within the idle time reuses the live process', async () => {
    const { th, clk } = mk();
    th.enqueue('one', 'user', user('one'));
    await idle(th);
    clk.t = clock(12, 29);
    th.enqueue('two', 'user', user('two'));
    await idle(th);
    expect(factory.sessions).toHaveLength(1);
    expect(dividers(th)).toHaveLength(1);
  });

  it('inactivity: the next message after idleMs starts a new session and stops the old process; idleMs 0 never does', async () => {
    const { th, clk } = mk();
    th.enqueue('one', 'user', user('one'));
    await idle(th);
    const first = factory.sessions[0];
    clk.t = clock(12, 30);
    th.enqueue('two', 'user', user('two'));
    await idle(th);
    expect(factory.resumeIds).toEqual([null, null]);
    expect(first.running).toBe(false);
    expect(kinds(th)).toEqual(['session', 'user', 'assistant', 'session', 'user', 'assistant']);
    expect(wire()).toEqual(['START', 'one', 'START', 'two']);
  });

  it('idleMs 0 means no inactivity trigger', async () => {
    const o = mk({ fresh: { idleMs: () => 0 } });
    o.th.enqueue('one', 'user', user('one'));
    await idle(o.th);
    o.clk.t = clock(20, 0);
    o.th.enqueue('two', 'user', user('two'));
    await idle(o.th);
    expect(o.th.info().entries.filter((e) => e.kind === 'session')).toHaveLength(1);
  });

  it('new day: the first message after the last activity on an earlier day is fresh', async () => {
    const a = mk({ now: () => clock(23, 50), fresh: { idleMs: () => 0 } });
    a.th.enqueue('one', 'user', user('one'));
    await idle(a.th);
    a.clk.t = clock(0, 5, 11);
    a.th.enqueue('two', 'user', user('two'));
    await idle(a.th);
    expect(dividers(a.th)).toHaveLength(2);
    expect(factory.resumeIds).toEqual([null, null]);
  });

  it('a conversation going on past midnight is not cut: a turn that ends after it, a message sent during it, one right after', async () => {
    const b = mk({ now: () => clock(23, 58), fresh: { idleMs: () => 0 }, env: env({ FAKE_DELAY_MS: '300' }) });
    b.th.enqueue('one', 'user', user('one'));
    await waitFor(() => b.th.busy);
    b.clk.t = clock(0, 2, 11);
    b.th.enqueue('two', 'user', user('two'));
    await idle(b.th);
    b.clk.t = clock(0, 3, 11);
    b.th.enqueue('three', 'user', user('three'));
    await idle(b.th);
    expect(dividers(b.th)).toHaveLength(1);
    expect(factory.sessions).toHaveLength(1);
    expect(b.th.info().entries.filter((e) => e.kind === 'assistant')).toHaveLength(3);
  });

  it('requestNewSession while idle: a system line, the next message is fresh with a divider, a second request returns false', async () => {
    const { th } = mk();
    th.enqueue('one', 'user', user('one'));
    await idle(th);
    expect(th.requestNewSession()).toBe(true);
    expect(th.requestNewSession()).toBe(false);
    expect(sys(th)).toEqual(['Your next message starts a new session: Ada reads the hq again.']);
    expect(factory.sessions).toHaveLength(1);
    expect(factory.sessions[0].running).toBe(true); // nothing is stopped or sent
    th.enqueue('two', 'user', user('two'));
    await idle(th);
    expect(factory.resumeIds).toEqual([null, null]);
    expect(kinds(th)).toEqual(['session', 'user', 'assistant', 'system', 'session', 'user', 'assistant']);
    // the request is used up: a third message continues the session
    th.enqueue('three', 'user', user('three'));
    await idle(th);
    expect(factory.sessions).toHaveLength(2);
    expect(th.requestNewSession()).toBe(true);
  });

  it('requestNewSession while busy: messages sent during the turn go to the current session in order; the first one from idle after it is fresh', async () => {
    const { th } = mk({ env: env({ FAKE_DELAY_MS: '250' }) });
    th.enqueue('a', 'user', user('a'));
    await waitFor(() => th.busy);
    expect(th.requestNewSession()).toBe(true);
    expect(sys(th)).toEqual(['A new session starts with your first message after the current work has ended.']);
    th.enqueue('b', 'user', user('b'));
    th.enqueue('c', 'user', user('c'));
    await idle(th);
    expect(factory.sessions).toHaveLength(1);
    expect(wire()).toEqual(['START', 'a', 'b', 'c']);
    th.enqueue('d', 'user', user('d'));
    await idle(th);
    expect(wire()).toEqual(['START', 'a', 'b', 'c', 'START', 'd']);
    expect(dividers(th)).toHaveLength(2);
  });

  it('a hold (background work or a report to come): no new session, said once, the message goes to the current process; after it a new session', async () => {
    let hold = true;
    const { th, clk } = mk({ holdRestart: () => hold });
    th.enqueue('one', 'user', user('one'));
    await idle(th);
    clk.t = clock(13, 0);
    th.enqueue('two', 'user', user('two'));
    await idle(th);
    th.enqueue('three', 'user', user('three'));
    await idle(th);
    expect(factory.sessions).toHaveLength(1);
    expect(sys(th)).toEqual(['Work is still running in the background: the new session starts with your first message after it has ended.']);
    expect(dividers(th)).toHaveLength(1);
    expect(wire()).toEqual(['START', 'one', 'two', 'three']);
    hold = false;
    th.enqueue('four', 'user', user('four'));
    await idle(th);
    expect(wire()).toEqual(['START', 'one', 'two', 'three', 'START', 'four']);
    expect(dividers(th)).toHaveLength(2);
    // the hold line is said again for the next hold
    hold = true;
    th.requestNewSession();
    th.enqueue('five', 'user', user('five'));
    await idle(th);
    expect(sys(th).filter((x) => x.startsWith('Work is still running'))).toHaveLength(2);
  });

  it('a hold does not apply without a live process', async () => {
    const { th } = mk({ holdRestart: () => true });
    th.enqueue('one', 'user', user('one'));
    await idle(th);
    expect(dividers(th)).toHaveLength(1);
    expect(sys(th)).toEqual([]);
  });

  it('no message is lost or sent twice across fresh starts, messages sent mid-turn and requests', async () => {
    const { th, clk } = mk({ env: env({ FAKE_DELAY_MS: '120' }) });
    th.enqueue('a', 'user', user('a'));
    await waitFor(() => th.busy);
    th.enqueue('b', 'user', user('b'));
    th.requestNewSession();
    th.enqueue('c', 'user', user('c'));
    clk.t = clock(14, 0);
    th.enqueue('d', 'user', user('d'));
    expect(th.state().busy).toBe(true);
    await idle(th);
    th.enqueue('e', 'user', user('e'));
    await waitFor(() => th.busy);
    th.enqueue('f', 'user', user('f'));
    th.enqueue('g', 'user', user('g'));
    await idle(th);
    expect(wire()).toEqual(['START', 'a', 'b', 'c', 'd', 'START', 'e', 'f', 'g']);
    expect(th.info().entries.filter((e) => e.kind === 'user').map((e) => e.text)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });

  it('a technical restart inside the run resumes the current session, with no divider', async () => {
    let restart = false;
    const { th } = mk({ needsRestart: () => restart });
    th.enqueue('one', 'user', user('one'));
    await idle(th);
    restart = true;
    th.enqueue('two', 'user', user('two'));
    await idle(th);
    restart = false;
    await th.restart(); // like a process that exited, or a plugin update
    th.enqueue('three', 'user', user('three'));
    await idle(th);
    await th.interrupt();
    th.enqueue('four', 'user', user('four'));
    await idle(th);
    expect(factory.resumeIds).toEqual([null, 'S0', 'S1', 'S2']);
    expect(dividers(th)).toHaveLength(1);
  });

  it('a stale --resume of a technical restart starts a new session and says so with a divider', async () => {
    const { th } = mk({ env: (n) => ({ FAKE_SID: `S${n}`, FAKE_LOG: logFile(), ...(n === 1 ? { FAKE_STALE_RESUME: '1' } : {}) }) });
    th.enqueue('one', 'user', user('one'));
    await idle(th);
    await th.restart();
    th.enqueue('two', 'user', user('two'));
    await idle(th);
    expect(factory.resumeIds).toEqual([null, 'S0', null]);
    expect(dividers(th)).toHaveLength(2);
    expect(kinds(th)).toEqual(['session', 'user', 'assistant', 'user', 'session', 'assistant']);
    // the next message continues the new session
    th.enqueue('three', 'user', user('three'));
    await idle(th);
    expect(factory.sessions).toHaveLength(3);
  });

  describe('size trigger: a continued new session', () => {
    const MARK = CONTINUATION_MARKER;
    let limit = 100_000;
    beforeEach(() => {
      limit = 100_000;
    });
    const mkSize = (over: Parameters<typeof setup>[0] = {}) => mk({ fresh: { idleMs: () => 30 * MIN, sizeTokens: () => limit }, ...over });
    /** Sends a message, waits for its turn, then reports the context size of the session it ran in. */
    const turn = async (o: ReturnType<typeof mkSize>, text: string, tokens: number) => {
      o.th.enqueue(text, 'user', user(text));
      await idle(o.th);
      factory.sessions[factory.sessions.length - 1].emit('context', tokens);
    };
    const block = (author: string, time: string, text: string) => `--- ${author}, ${time} ---\n${text}`;
    const contents = (th: Thread) => th.info().entries.map((e) => e.kind + (e.kind === 'session' && e.continued ? ':continued' : ''));

    it('a context at or over the limit on the 2nd result marks renewal; the next message from idle starts makeSession(null) with the marker and the last 6 messages', async () => {
      const o = mkSize({ env: env({ FAKE_TOOLS: JSON.stringify([{ name: 'Read', input: { file_path: '/x/a.md' } }]) }) });
      const { th, clk } = o;
      for (const [i, tokens] of [10, 10, 10, 150_000].entries()) {
        clk.t = clock(12, i);
        await turn(o, `m${i + 1}`, tokens);
      }
      expect(factory.sessions).toHaveLength(1);
      clk.t = clock(12, 10);
      th.enqueue('m5', 'user', user('m5'));
      await idle(th);
      expect(factory.resumeIds).toEqual([null, null]);
      const sent = wire();
      expect(sent.slice(0, 5)).toEqual(['START', 'm1', 'm2', 'm3', 'm4']);
      expect(sent[5]).toBe('START');
      expect(sent[6]).toBe(
        [MARK, block('You', '12:01', 'm2'), block('Ada', '12:01', 'ok'), block('You', '12:02', 'm3'), block('Ada', '12:02', 'ok'), block('You', '12:03', 'm4'), block('Ada', '12:03', 'ok'), '--- New message ---\nm5'].join('\n\n'),
      );
      expect(sent[6].startsWith(MARK + '\n\n')).toBe(true);
      // the divider is continued and comes before the plain user entry; activity lines are not part of the recent messages
      const entries = th.info().entries;
      const i = entries.findIndex((e) => e.kind === 'session' && e.continued);
      expect(i).toBeGreaterThan(0);
      expect(entries[i + 1]).toMatchObject({ kind: 'user', text: 'm5' });
      expect(sent[6]).not.toContain('Reading');
      expect(contents(th).filter((k) => k.startsWith('session'))).toEqual(['session', 'session:continued']);
      // the renewal is used up: the next message continues the new session
      await turn(o, 'm6', 10);
      expect(factory.sessions).toHaveLength(2);
    });

    it('the first result of a session over the limit does not mark', async () => {
      const o = mkSize();
      await turn(o, 'one', 900_000);
      o.th.enqueue('two', 'user', user('two'));
      await idle(o.th);
      expect(factory.sessions).toHaveLength(1);
    });

    it('a context below the limit does not mark', async () => {
      const o = mkSize();
      await turn(o, 'one', 99_999);
      await turn(o, 'two', 99_999);
      o.th.enqueue('three', 'user', user('three'));
      await idle(o.th);
      expect(factory.sessions).toHaveLength(1);
    });

    it('a limit of 0 never marks', async () => {
      limit = 0;
      const o = mkSize();
      await turn(o, 'one', 900_000);
      await turn(o, 'two', 900_000);
      o.th.enqueue('three', 'user', user('three'));
      await idle(o.th);
      expect(factory.sessions).toHaveLength(1);
    });

    it('a context event of an old process is ignored', async () => {
      const o = mkSize();
      await turn(o, 'one', 10);
      o.clk.t = clock(14, 0); // inactivity: a normal new session
      await turn(o, 'two', 10);
      expect(factory.sessions).toHaveLength(2);
      factory.sessions[0].emit('context', 500_000);
      factory.sessions[0].emit('context', 500_000);
      o.th.enqueue('three', 'user', user('three'));
      await idle(o.th);
      expect(factory.sessions).toHaveLength(2);
      expect(dividers(o.th)).toHaveLength(2);
    });

    it('a message sent during the turn that crossed the limit continues in the same session; the first one from idle after it renews', async () => {
      const o = mkSize({ env: env({ FAKE_DELAY_MS: '200' }) });
      await turn(o, 'a', 10);
      o.th.enqueue('b', 'user', user('b'));
      await waitFor(() => o.th.busy);
      o.th.enqueue('c', 'user', user('c'));
      factory.sessions[0].emit('context', 200_000);
      await idle(o.th);
      expect(factory.sessions).toHaveLength(1);
      expect(wire()).toEqual(['START', 'a', 'b', 'c']);
      o.th.enqueue('d', 'user', user('d'));
      await idle(o.th);
      const sent = wire();
      expect(sent.slice(0, 5)).toEqual(['START', 'a', 'b', 'c', 'START']);
      expect(sent[5].startsWith(MARK)).toBe(true);
      expect(sent[5].endsWith('--- New message ---\nd')).toBe(true);
    });

    it('a hold keeps the renewal: said once, the message goes to the current process; after the hold the next message renews', async () => {
      let hold = false;
      const o = mkSize({ holdRestart: () => hold });
      await turn(o, 'a', 10);
      await turn(o, 'b', 150_000);
      hold = true;
      o.th.enqueue('c', 'user', user('c'));
      await idle(o.th);
      o.th.enqueue('d', 'user', user('d'));
      await idle(o.th);
      expect(factory.sessions).toHaveLength(1);
      expect(sys(o.th)).toEqual(['Work is still running in the background: the new session starts with your first message after it has ended.']);
      expect(wire()).toEqual(['START', 'a', 'b', 'c', 'd']);
      expect(dividers(o.th)).toHaveLength(1);
      hold = false;
      o.th.enqueue('e', 'user', user('e'));
      await idle(o.th);
      const sent = wire();
      expect(sent.slice(0, 6)).toEqual(['START', 'a', 'b', 'c', 'd', 'START']);
      expect(sent[6].startsWith(MARK)).toBe(true);
      expect(contents(o.th).filter((k) => k.startsWith('session'))).toEqual(['session', 'session:continued']);
    });

    it.each([
      ['inactivity', (o: ReturnType<typeof mkSize>) => (o.clk.t = clock(13, 0))],
      ['a new day', (o: ReturnType<typeof mkSize>) => (o.clk.t = clock(12, 5, 11))],
      ['a request', (o: ReturnType<typeof mkSize>) => void o.th.requestNewSession()],
    ])('priority: %s with the size flag also set gives a normal new session and clears the flag', async (_name, due) => {
      const o = mkSize({ fresh: { idleMs: () => (_name === 'a new day' ? 0 : 30 * MIN), sizeTokens: () => limit } });
      await turn(o, 'a', 10);
      await turn(o, 'b', 150_000);
      due(o);
      o.th.enqueue('c', 'user', user('c'));
      await idle(o.th);
      expect(factory.resumeIds).toEqual([null, null]);
      expect(wire()).toEqual(['START', 'a', 'b', 'START', 'c']);
      expect(dividers(o.th).map((d) => d.continued)).toEqual([undefined, undefined]);
      o.th.enqueue('d', 'user', user('d'));
      await idle(o.th);
      expect(factory.sessions).toHaveLength(2);
    });

    it('priority: app open with the size flag set gives a normal new session', async () => {
      const o = mkSize({ stored: { sessionId: 'OLD', day: localDay(clock(12, 0)) } });
      (o.th as unknown as { renewForSize: boolean }).renewForSize = true;
      o.th.enqueue('one', 'user', user('one'));
      await idle(o.th);
      expect(wire()).toEqual(['START', 'one']);
      expect(dividers(o.th)[0].continued).toBeUndefined();
      expect((o.th as unknown as { renewForSize: boolean }).renewForSize).toBe(false);
    });

    it('no message is lost or sent twice across a continued start', async () => {
      const o = mkSize({ env: env({ FAKE_DELAY_MS: '120' }) });
      await turn(o, 'a', 10);
      await turn(o, 'b', 150_000);
      o.th.enqueue('c', 'user', user('c'));
      await waitFor(() => o.th.busy);
      o.th.enqueue('d', 'user', user('d'));
      o.th.enqueue('e', 'user', user('e'));
      await idle(o.th);
      o.th.enqueue('f', 'user', user('f'));
      await idle(o.th);
      const sent = wire();
      expect(sent.map((s) => (s.startsWith(MARK) ? 'CONT:' + s.split('--- New message ---\n')[1] : s))).toEqual(['START', 'a', 'b', 'START', 'CONT:c', 'd', 'e', 'f']);
      expect(o.th.info().entries.filter((e) => e.kind === 'user').map((e) => e.text)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    });

    it('a "!" command output goes after "--- New message ---", before the message text', async () => {
      const o = mkSize();
      await turn(o, 'a', 10);
      await turn(o, 'b', 150_000);
      const r = { outcome: 'done' as const, exitCode: 0, stdout: 'files\n', stderr: '', truncated: false };
      o.th.trackCommand('ls', { done: Promise.resolve(r), cancel: () => undefined });
      await waitFor(() => !o.th.commandRunning);
      o.th.enqueue('c', 'user', user('c'));
      await idle(o.th);
      const cont = wire()[4];
      expect(cont.startsWith(MARK + '\n\n--- You, 12:00 ---\na')).toBe(true);
      expect(cont.endsWith(`--- New message ---\n${commandContext('ls', r)}\n\nc`)).toBe(true);
      // the command's own entry is not a recent message
      expect(cont.split('--- You').length - 1).toBe(2);
    });
  });

  it('a thread that cannot start sessions gets no divider', async () => {
    const a = mk({ canStart: () => 'No Claude Code' });
    a.th.enqueue('one', 'user', user('one'));
    await idle(a.th);
    expect(dividers(a.th)).toHaveLength(0);
    expect(a.th.info().entries.some((e) => e.kind === 'error')).toBe(true);
  });

  it('requestNewSession is false and writes nothing on a thread without `fresh`', async () => {
    const b = setup();
    expect(b.th.requestNewSession()).toBe(false);
    expect(b.th.info().entries).toHaveLength(0);
  });
});

describe('Thread activity', () => {
  const tools = [
    { name: 'Read', input: { file_path: '/work/hq/company/state.md' } },
    { name: 'Bash', input: { command: 'git pull' } },
  ];

  it('tracks the turn in thread-state and leaves one activity entry before the answer', async () => {
    const { th, events } = setup({ env: { FAKE_TOOLS: JSON.stringify(tools) } });
    th.enqueue('go', 'user', user('go'));
    await idle(th);
    const states = events.flatMap((e) => (e.type === 'thread-state' ? [e.state] : []));
    const first = states.find((s) => s.activity);
    expect(first?.activity).toMatchObject({ current: null, steps: 0 });
    expect(typeof first?.activity?.startedAt).toBe('string');
    expect(states.some((s) => s.activity?.steps === 1 && s.activity.current === 'Reading state.md')).toBe(true); // cwd not set: base name
    expect(states.some((s) => s.activity?.steps === 2 && s.activity.current === 'Getting updates from GitHub')).toBe(true);
    expect(states[states.length - 1].activity).toBeNull();
    const entries = th.info().entries;
    expect(entries.map((e) => e.kind)).toEqual(['user', 'activity', 'assistant']);
    const steps = entries[1].steps as Array<{ text: string; detail?: string; durationMs?: number; failed?: boolean }>;
    expect(steps.map((x) => x.text)).toEqual(['Reading state.md', 'Getting updates from GitHub']);
    expect(steps.map((x) => x.detail)).toEqual(['Read · state.md', 'Bash · git pull']);
    expect(steps.every((x) => typeof x.durationMs === 'number' && !x.failed)).toBe(true);
    expect(entries[1].text).toMatch(/^2 steps · \d+ s$/);
    expect(typeof entries[1].durationMs).toBe('number');
    expect(th.info().activity).toBeNull();
  });

  it('ends the last step when its tool result arrives, not when the answer has been written', async () => {
    const o = setup({ env: { FAKE_TOOLS: JSON.stringify(tools), FAKE_TOOL_RESULTS: '1', FAKE_TEXT_DELAY_MS: '600' } });
    o.th.enqueue('go', 'user', user('go'));
    await idle(o.th);
    const entry = o.th.info().entries.find((e) => e.kind === 'activity');
    const last = (entry?.steps as Array<{ durationMs: number }>).at(-1)!;
    expect(last.durationMs).toBeLessThan(300);
    expect(entry?.durationMs).toBeGreaterThanOrEqual(600); // the total stays the whole turn
  });

  it('without a tool result the first text after the last step ends it', async () => {
    const o = setup({ env: { FAKE_TOOLS: JSON.stringify(tools), FAKE_TEXT_DELAY_MS: '300' } });
    o.th.enqueue('go', 'user', user('go'));
    await idle(o.th);
    const entry = o.th.info().entries.find((e) => e.kind === 'activity');
    const last = (entry?.steps as Array<{ durationMs: number }>).at(-1)!;
    // The step spans the 300 ms text delay; stdout batching under a loaded run can shift each event by some tens of ms,
    // so the bound keeps a margin. The exact boundaries are unit-tested on finishSteps.
    expect(last.durationMs).toBeGreaterThanOrEqual(150);
    expect(last.durationMs).toBeLessThanOrEqual(entry!.durationMs!);
  });

  it('names the file only, with the cwd option set too', async () => {
    const o = setup({ env: { FAKE_TOOLS: JSON.stringify(tools) }, cwd: '/work/hq' });
    o.th.enqueue('go', 'user', user('go'));
    await idle(o.th);
    const first = o.th.info().entries.find((e) => e.kind === 'activity')?.steps?.[0] as { text: string; detail: string };
    expect(first.text).toBe('Reading state.md');
    expect(first.detail).toBe('Read · company/state.md'); // the detail is relative to the cwd
  });

  it("never lists the app's own permission tool as a step", async () => {
    const o = setup({ env: { FAKE_TOOLS: JSON.stringify([{ name: 'mcp__coa__permission_prompt', input: {} }, ...tools]) } });
    o.th.enqueue('go', 'user', user('go'));
    await idle(o.th);
    const steps = o.th.info().entries.find((e) => e.kind === 'activity')?.steps as Array<{ text: string }>;
    expect(steps.map((x) => x.text)).toEqual(['Reading state.md', 'Getting updates from GitHub']);
  });

  it('a turn without tools has no activity entry', async () => {
    const { th } = setup();
    th.enqueue('go', 'user', user('go'));
    await idle(th);
    expect(th.info().entries.map((e) => e.kind)).toEqual(['user', 'assistant']);
  });

  it('a single step uses the singular summary', async () => {
    const { th } = setup({ env: { FAKE_TOOLS: JSON.stringify([tools[1]]) } });
    th.enqueue('go', 'user', user('go'));
    await idle(th);
    expect(th.info().entries.find((e) => e.kind === 'activity')?.text).toMatch(/^1 step · /);
  });

  it('an empty turn adds a plain system line', async () => {
    const { th } = setup({ env: { FAKE_REPLY: '' } });
    th.enqueue('go', 'user', user('go'));
    await idle(th);
    const last = th.info().entries.slice(-1)[0];
    expect(last).toMatchObject({ kind: 'system', text: 'The turn ended without a reply.' });
  });

  it('an empty turn with steps keeps the order activity, then the system line', async () => {
    const { th } = setup({ env: { FAKE_REPLY: '', FAKE_TOOLS: JSON.stringify(tools) } });
    th.enqueue('go', 'user', user('go'));
    await idle(th);
    expect(th.info().entries.map((e) => e.kind)).toEqual(['user', 'activity', 'system']);
  });

  it('keeps the raw tool uses for listeners', async () => {
    const { th } = setup({ env: { FAKE_TOOLS: JSON.stringify(tools) } });
    const results: TurnResult[] = [];
    th.onTurnEnd((r) => results.push(r));
    th.enqueue('go', 'user', null);
    await idle(th);
    expect(results[0].tools).toEqual(tools.map((x, i) => ({ ...x, id: `tu${i}`, ok: false })));
  });

  it('a tool counts as ok only when its tool_result arrived and was not an error', async () => {
    const mixed = [
      { name: 'Write', input: { file_path: 'a' } },
      { name: 'Edit', input: { file_path: 'b' }, error: true },
      { name: 'Bash', input: { command: 'ls' } },
    ];
    const { th } = setup({ env: { FAKE_TOOLS: JSON.stringify(mixed), FAKE_TOOL_RESULTS: '1' } });
    const results: TurnResult[] = [];
    th.onTurnEnd((r) => results.push(r));
    th.enqueue('go', 'user', null);
    await idle(th);
    expect(results[0].tools.map((x) => [x.id, x.ok])).toEqual([['tu0', true], ['tu1', false], ['tu2', true]]);
  });

  it('onTurnStart fires when a turn starts from idle, before its end', async () => {
    const { th } = setup();
    const seen: string[] = [];
    th.onTurnStart(() => seen.push('start'));
    th.onTurnEnd(() => seen.push('end'));
    th.enqueue('go', 'user', null);
    await idle(th);
    expect(seen).toEqual(['start', 'end']);
  });

  it('reads old logs with tool entries', () => {
    const { th } = setup();
    th.append('tool', '', 'using Bash');
    expect(th.info().entries[0].kind).toBe('tool');
  });
});

describe('Thread.dispose', () => {
  it('a close during the day-rollover stop never starts a session, and later enqueues are dropped', async () => {
    let now = new Date('2026-01-01T10:00:00');
    const { th } = setup({ now: () => now });
    th.enqueue('one', 'user', user('one'));
    await idle(th);
    expect(factory.sessions).toHaveLength(1);
    // Make the old process slow to stop, then roll the day over and close in the middle of it.
    const old = factory.sessions[0];
    const realStop = old.stop.bind(old);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    old.stop = async (g?: number) => {
      await gate;
      return realStop(g);
    };
    now = new Date('2026-01-02T10:00:00');
    th.enqueue('two', 'user', user('two'));
    await new Promise((r) => setTimeout(r, 30));
    const closing = th.dispose(0);
    release();
    await closing;
    await new Promise((r) => setTimeout(r, 100));
    expect(factory.sessions).toHaveLength(1);
    expect(old.running).toBe(false);
    th.enqueue('three', 'user', user('three'));
    await new Promise((r) => setTimeout(r, 50));
    expect(factory.sessions).toHaveLength(1);
    expect(th.busy).toBe(false);
  });
});

describe('finishSteps', () => {
  const at = (ms: number) => new Date(1_000_000 + ms).toISOString();
  const steps = [
    { text: 'a', detail: 'A', time: at(0) },
    { text: 'b', detail: 'B', time: at(2000) },
    { text: 'c', detail: 'C', time: at(5000) },
  ];

  it('a step lasts until the next one starts', () => {
    expect(finishSteps(steps, 1_000_000 + 30_000, false).map((x) => x.durationMs)).toEqual([2000, 3000, 25_000]);
  });

  it('the last step ends at its own end signal, before the end of the turn', () => {
    const withEnd = steps.map((x, i) => (i === 2 ? { ...x, endedAt: at(9000) } : x));
    expect(finishSteps(withEnd, 1_000_000 + 30_000, false).map((x) => x.durationMs)).toEqual([2000, 3000, 4000]);
  });

  it('an end signal of an earlier step is ignored (the next step start wins)', () => {
    const withEnd = steps.map((x, i) => (i === 0 ? { ...x, endedAt: at(500) } : x));
    expect(finishSteps(withEnd, 1_000_000 + 30_000, false)[0].durationMs).toBe(2000);
  });

  it('marks only the last step failed on a failed turn', () => {
    expect(finishSteps(steps, 1_000_000 + 6000, true).map((x) => !!x.failed)).toEqual([false, false, true]);
  });
});

describe('Thread turns that cannot start', () => {
  it('canStart gives a reason: every dropped tagged message ends as a failed turn with no tools; untagged ones do not', async () => {
    const { th, events } = setup({ canStart: () => 'Claude Code is too old' });
    const results: TurnResult[] = [];
    th.onTurnEnd((r) => results.push(r));
    th.enqueue('a', 'user', null, 'tag-a');
    th.enqueue('b', 'user', null);
    await waitFor(() => results.length >= 1);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ isError: true, text: '', tools: [], notStarted: true, sent: [{ text: 'a', kind: 'user', tag: 'tag-a' }] });
    expect(results[0].resultText).toBe('Claude Code is too old');
    expect(th.info().entries.filter((e) => e.kind === 'error').map((e) => e.text)).toContain('Claude Code is too old');
    expect(th.busy).toBe(false);
    expect(events.length).toBeGreaterThan(0);
  });

  it('a process that cannot be made ends the tagged turn as failed, and the thread is idle again', async () => {
    const { th } = setup();
    (th as any).o.makeSession = () => { // eslint-disable-line @typescript-eslint/no-explicit-any
      throw new Error('no claude here');
    };
    const results: TurnResult[] = [];
    th.onTurnEnd((r) => results.push(r));
    th.enqueue('go', 'user', null, 'handover');
    await waitFor(() => results.length === 1);
    expect(results[0]).toMatchObject({ isError: true, tools: [], notStarted: true, sent: [{ tag: 'handover' }] });
    expect(th.busy).toBe(false);
    expect(th.info().entries.some((e) => e.kind === 'error' && e.text === 'no claude here')).toBe(true);
  });
});

describe('Thread messages written while a turn runs', () => {
  it('needsRestart true with a message mid-turn: the process is not replaced, both messages are answered', async () => {
    const { th } = setup({ needsRestart: () => true, env: { FAKE_DELAY_MS: '100' } });
    th.enqueue('one', 'user', user('one'));
    await waitFor(() => th.busy);
    th.enqueue('two', 'user', user('two'));
    await idle(th);
    expect(factory.sessions).toHaveLength(1);
    expect(th.info().entries.filter((e) => e.kind === 'assistant')).toHaveLength(2);
  });

  it('a stale --resume with two unanswered messages: each is resent once on the fresh process and answered once', async () => {
    const logFile = path.join(dir, 'fake.log');
    const now = new Date(2026, 2, 10, 12);
    const { th, store } = setup({
      now: () => now,
      stored: { sessionId: 'GONE', day: localDay(now) },
      env: (n) => ({ FAKE_STALE_RESUME: n === 0 ? '1' : '0', FAKE_DELAY_MS: '100', FAKE_SID: `S${n}`, FAKE_LOG: logFile, FAKE_REPLY: 'fresh' }),
    });
    const results: TurnResult[] = [];
    th.onTurnEnd((r) => results.push(r));
    th.enqueue('one', 'user', null, 'tag-1');
    await waitFor(() => th.busy);
    th.enqueue('two', 'user', null, 'tag-2');
    await idle(th);
    expect(factory.resumeIds).toEqual(['GONE', null]);
    expect(store.clears).toBe(1);
    const sent = fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l).message.content);
    expect(sent).toEqual(['one', 'two', 'one', 'two']);
    expect(results.map((r) => r.sent.map((m) => m.tag))).toEqual([['tag-1'], ['tag-2']]);
    const entries = th.info().entries;
    expect(entries.filter((e) => e.kind === 'error')).toHaveLength(0);
    expect(entries.filter((e) => e.kind === 'assistant')).toHaveLength(2);
  });

  it('interrupt and stop release the tags of messages written behind another', async () => {
    for (const how of ['interrupt', 'stop'] as const) {
      const { th } = setup({ env: { FAKE_DELAY_MS: '2000' } });
      th.enqueue('one', 'user', user('one'), 'tag-1');
      await waitFor(() => th.busy);
      th.enqueue('two', 'user', user('two'), 'tag-2');
      expect(th.hasTag('tag-2')).toBe(true);
      const waiter = th.idle();
      if (how === 'interrupt') await th.interrupt();
      else await th.stop(0);
      expect(th.hasTag('tag-1') || th.hasTag('tag-2')).toBe(false);
      expect(th.busy).toBe(false);
      await waiter;
    }
  });

  it('onTurnStart fires once per busy period, not for a message (or handoff) written mid-turn', async () => {
    const { th } = setup({ env: { FAKE_DELAY_MS: '100' } });
    let starts = 0;
    th.onTurnStart(() => starts++);
    th.enqueue('one', 'user', user('one'));
    await waitFor(() => th.busy);
    th.enqueue('two', 'user', user('two'));
    th.enqueue('three', 'handoff', null, 'handoff:t1');
    await idle(th);
    expect(starts).toBe(1);
    th.enqueue('four', 'user', user('four'));
    await idle(th);
    expect(starts).toBe(2);
  });
});
