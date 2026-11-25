import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DispatchTracker, endedNotificationText } from '../../src/main/org/dispatches';
import { StreamParser, type ClaudeEvent } from '../../src/main/claude/stream';
import type { Dispatch, DispatchBy } from '../../src/shared/types';

const FIX = path.join(__dirname, '..', 'fixtures', 'claude');
const events = (f: string): ClaudeEvent[] => new StreamParser().feed(fs.readFileSync(path.join(FIX, f), 'utf8'));

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-disp-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const DEPTS = [
  { id: 'engineering', agent: 'max', persona: 'Max' },
  { id: 'ghosts', agent: 'ghost', persona: 'Casper' },
];

function make(depts = DEPTS) {
  let ms = Date.UTC(2026, 10, 18, 9, 0, 0);
  const clock = { advance: (by: number) => (ms += by) };
  const changes: Dispatch[][] = [];
  const ended: Dispatch[] = [];
  const file = path.join(dir, 'dispatches.json');
  const tr = new DispatchTracker({ file, departments: () => depts, now: () => new Date(ms), onChange: (l) => changes.push(l), onEnded: (d) => ended.push(d) });
  /** Feeds events one by one, two seconds apart. */
  const feed = (evs: ClaudeEvent[], owner?: DispatchBy) => {
    for (const e of evs) {
      clock.advance(2000);
      tr.handle(e, owner);
    }
  };
  return { tr, feed, changes, ended, file, clock };
}

const start = (id: string, extra: Record<string, unknown> = {}, agent = 'max'): ClaudeEvent => ({ kind: 'tool-use', id, name: 'Agent', input: { subagent_type: agent, description: 'Do it', prompt: 'secret prompt', ...extra } });
const resultEv: ClaudeEvent = { kind: 'result', isError: false, text: 'Done.', sessionId: null, numTurns: 2, contextTokens: null };
const emptyResult: ClaudeEvent = { kind: 'result', isError: false, text: '', sessionId: null, numTurns: 1, contextTokens: null };
const noModelResult: ClaudeEvent = { kind: 'result', isError: false, text: '', sessionId: null, numTurns: 0, contextTokens: null };
const taskStarted = (toolUseId: string, taskId: string, background = false, over: { agent?: string; description?: string } = {}): ClaudeEvent => ({ kind: 'task-started', toolUseId, taskId, agent: 'max', description: 'Do it', background, ...over });

describe('DispatchTracker on recorded streams', () => {
  it('foreground: running, then done when the task ends', () => {
    const { tr, feed, ended } = make();
    const evs = events('dispatch-foreground.jsonl');
    const endIdx = evs.findIndex((e) => e.kind === 'task-ended');
    feed(evs.slice(0, endIdx));
    expect(tr.list()).toMatchObject([{ id: 'toolu_01AwMPXkYJjgz2p1HDNRQMvC', agent: 'max', departmentId: 'engineering', name: 'Max', description: 'Say pong', background: false, state: 'running', endedAt: null }]);
    feed(evs.slice(endIdx));
    const [d] = tr.list();
    expect(d.state).toBe('done');
    expect(d.endedAt).not.toBeNull();
    expect(d.lastActivityAt > d.startedAt).toBe(true);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ id: d.id, state: 'done', departmentId: 'engineering' });
  });

  it('background: still running after the first result, done after the notification, one onEnded', () => {
    const { tr, feed, ended } = make();
    const evs = events('dispatch-background.jsonl');
    const firstResult = evs.findIndex((e) => e.kind === 'result');
    feed(evs.slice(0, firstResult + 1));
    expect(tr.list()).toMatchObject([{ state: 'running', background: true, departmentId: 'engineering' }]);
    expect(ended).toHaveLength(0);
    feed(evs.slice(firstResult + 1));
    expect(tr.list()).toMatchObject([{ state: 'done' }]);
    expect(tr.list()[0].endedAt).not.toBeNull();
    expect(ended).toHaveLength(1);
    expect(ended[0].description).toBe('Count to three');
  });

  it('failed: an error tool_result fails the dispatch', () => {
    const { tr, feed, ended } = make();
    feed(events('dispatch-failed.jsonl'));
    expect(tr.list()).toMatchObject([{ agent: 'ghost', departmentId: 'ghosts', name: 'Casper', state: 'failed' }]);
    expect(ended).toHaveLength(1);
    expect(ended[0].state).toBe('failed');
  });

  it('failed: an agent that is no department is shown under its own name and sends no onEnded', () => {
    const { tr, feed, ended } = make([]);
    feed(events('dispatch-failed.jsonl'));
    expect(tr.list()).toMatchObject([{ departmentId: null, name: 'ghost', state: 'failed' }]);
    expect(ended).toHaveLength(0);
  });

  it('parallel: two max dispatches tracked apart, the reader is a helper', () => {
    const { tr, feed, ended } = make();
    const evs = events('dispatch-parallel.jsonl');
    const results = evs.map((e, i) => (e.kind === 'result' ? i : -1)).filter((i) => i >= 0);
    feed(evs.slice(0, results[0] + 1));
    const byDesc = (d: string) => tr.list().find((x) => x.description === d)!;
    expect(byDesc('First job')).toMatchObject({ state: 'running', background: true, departmentId: 'engineering' });
    expect(byDesc('Second job')).toMatchObject({ state: 'running', background: true });
    expect(byDesc('Helper read')).toMatchObject({ state: 'done', departmentId: null, name: 'reader', background: false });
    expect(ended).toHaveLength(0);
    // the second turn: the first job ends (and a later "killed" for it changes nothing)
    feed(evs.slice(results[0] + 1, results[1] + 1));
    expect(byDesc('First job').state).toBe('done');
    expect(byDesc('Second job').state).toBe('running');
    expect(ended.map((d) => d.description)).toEqual(['First job']);
    // then the second job ends, and Claude Code reports it in a turn of its own
    feed(evs.slice(results[1] + 1));
    expect(byDesc('Second job').state).toBe('done');
    expect(tr.list()).toHaveLength(3);
    expect(ended.map((d) => d.description)).toEqual(['First job', 'Second job']);
    expect(ended.every((d) => d.name === 'Max')).toBe(true);
  });
});

describe('DispatchTracker rules', () => {
  it('a task killed while running is stopped', () => {
    const { tr, feed, ended } = make();
    feed([start('t1', { run_in_background: true }), taskStarted('t1', 'k1', true), { kind: 'task-ended', toolUseId: null, taskId: 'k1', status: 'killed', notification: true, topLevel: true, background: true }]);
    expect(tr.list()[0].state).toBe('stopped');
    expect(ended.map((d) => d.state)).toEqual(['stopped']);
    // the first end signal wins
    feed([{ kind: 'task-ended', toolUseId: 't1', taskId: 'k1', status: 'completed', notification: true, topLevel: true, background: true }]);
    expect(tr.list()[0].state).toBe('stopped');
    expect(ended).toHaveLength(1);
  });

  it('maps statuses: stopped -> stopped, other final words -> failed', () => {
    const { tr, feed } = make();
    feed([start('a'), start('b'), start('c')]);
    feed([
      { kind: 'task-ended', toolUseId: 'a', taskId: 'x', status: 'stopped', notification: true, topLevel: true, background: true },
      { kind: 'task-ended', toolUseId: 'b', taskId: 'y', status: 'failed', notification: true, topLevel: true, background: true },
      { kind: 'task-ended', toolUseId: 'c', taskId: 'z', status: 'error', notification: true, topLevel: true, background: true },
    ]);
    expect(tr.list().map((d) => d.state)).toEqual(['stopped', 'failed', 'failed']);
  });

  it('maps cancelled and canceled to stopped', () => {
    const { tr, feed } = make();
    feed([start('a'), start('b')]);
    feed([
      { kind: 'task-ended', toolUseId: 'a', taskId: 'x', status: 'cancelled', notification: true, topLevel: true, background: true },
      { kind: 'task-ended', toolUseId: 'b', taskId: 'y', status: 'canceled', notification: false, topLevel: true, background: true },
    ]);
    expect(tr.list().map((d) => d.state)).toEqual(['stopped', 'stopped']);
  });

  it('an end signal for work it does not know (a nested shell task) is ignored', () => {
    const { tr, feed } = make();
    feed([start('t1'), { kind: 'task-ended', toolUseId: 'toolu_bash', taskId: 'bash1', status: 'completed', notification: true, topLevel: true, background: true }]);
    expect(tr.list()[0].state).toBe('running');
  });

  it('a result ends a running foreground dispatch as unknown, not a background one', () => {
    const { tr, feed, ended } = make();
    feed([start('fg'), start('bg', { run_in_background: true }), resultEv]);
    expect(tr.list().map((d) => [d.id, d.state, d.endedAt])).toEqual([
      ['fg', 'unknown', null],
      ['bg', 'running', null],
    ]);
    expect(ended).toHaveLength(0);
  });

  it('an empty result and a result of no model call (num_turns 0) leave a running foreground dispatch running', () => {
    const { tr, feed, ended } = make();
    feed([start('fg'), start('bg', { run_in_background: true }), emptyResult, noModelResult]);
    expect(tr.list().map((d) => [d.id, d.state])).toEqual([
      ['fg', 'running'],
      ['bg', 'running'],
    ]);
    // a result with text but no model call (a leftover notice) says nothing either
    feed([{ ...noModelResult, text: 'notice' }]);
    expect(tr.list().map((d) => d.state)).toEqual(['running', 'running']);
    // an error result is a real end of turn, whatever its text
    feed([{ kind: 'result', isError: true, text: '', sessionId: null, numTurns: 1, contextTokens: null }]);
    expect(tr.list().map((d) => d.state)).toEqual(['unknown', 'running']);
    expect(ended).toHaveLength(0);
  });

  it('a background launch result keeps it running; is_backgrounded on task_started makes it background', () => {
    const { tr, feed } = make();
    feed([start('a'), { kind: 'tool-result', id: 'a', isError: false, async: true }]);
    expect(tr.list()[0]).toMatchObject({ state: 'running', background: true });
    feed([start('b'), taskStarted('b', 't', true)]);
    expect(tr.list()[1].background).toBe(true);
  });

  it('a tool_result without error ends a foreground dispatch as done', () => {
    const { tr, feed } = make();
    feed([start('a'), { kind: 'tool-result', id: 'a', isError: false, async: false }, start('b'), { kind: 'tool-result', id: 'b', isError: true, async: false }]);
    expect(tr.list().map((d) => d.state)).toEqual(['done', 'failed']);
  });

  it('sessionExited turns every running dispatch into unknown', () => {
    const { tr, feed, ended } = make();
    feed([start('a'), start('b', { run_in_background: true })]);
    tr.sessionExited();
    expect(tr.list().map((d) => [d.state, d.endedAt])).toEqual([
      ['unknown', null],
      ['unknown', null],
    ]);
    expect(ended).toHaveLength(0);
  });

  it('keeps the list in a file; a reload turns running into unknown', () => {
    const { tr, feed, file } = make();
    feed([start('a'), start('b'), { kind: 'tool-result', id: 'b', isError: false, async: false }]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toHaveLength(2);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(tr.list().map((d) => d.state)).toEqual(['running', 'done']);
    const again = make();
    expect(again.tr.list().map((d) => [d.id, d.state])).toEqual([
      ['a', 'unknown'],
      ['b', 'done'],
    ]);
    expect(again.tr.list()[0].endedAt).toBeNull();
  });

  it('a damaged file gives an empty list', () => {
    fs.writeFileSync(path.join(dir, 'dispatches.json'), '{nope');
    expect(make().tr.list()).toEqual([]);
  });

  it('ack removes ended and unknown dispatches, not running ones', () => {
    const { tr, feed, changes } = make();
    feed([start('a'), start('b'), start('c'), { kind: 'tool-result', id: 'a', isError: false, async: false }]);
    tr.sessionExited();
    feed([start('d')]);
    tr.ack(['a', 'd', 'missing']);
    expect(tr.list().map((d) => d.id)).toEqual(['b', 'c', 'd']);
    expect(changes[changes.length - 1].map((d) => d.id)).toEqual(['b', 'c', 'd']);
    const n = changes.length;
    tr.ack(['d']);
    expect(changes).toHaveLength(n);
  });

  it('keeps one entry per call id; the description is one short line; prompts are never kept', () => {
    const { tr, feed, file } = make();
    feed([start('a', { description: `  First\n   line ${'x'.repeat(200)}` }), start('a')]);
    const [d] = tr.list();
    expect(tr.list()).toHaveLength(1);
    expect(d.description).toHaveLength(120);
    expect(d.description.startsWith('First line x')).toBe(true);
    expect(JSON.stringify(d)).not.toContain('secret prompt');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('secret prompt');
  });

  it('reads the legacy Task name; ignores other tools and a missing agent type', () => {
    const { tr, feed } = make();
    feed([
      { kind: 'tool-use', id: 't', name: 'Task', input: { subagent_type: 'max', description: 'x' } },
      { kind: 'tool-use', id: 'b', name: 'Bash', input: { subagent_type: 'max' } },
      { kind: 'tool-use', id: 'n', name: 'Agent', input: { description: 'no type' } },
      { kind: 'tool-use', id: 'z', name: 'Agent', input: null },
    ]);
    expect(tr.list().map((d) => d.id)).toEqual(['t']);
  });

  it('activity updates lastActivityAt and tells at most once a second', () => {
    const { tr, changes, clock } = make();
    tr.handle(start('a'));
    const startedAt = tr.list()[0].startedAt;
    const n = changes.length;
    clock.advance(400);
    tr.handle({ kind: 'sub-activity', parentToolUseId: 'a' });
    expect(changes).toHaveLength(n);
    expect(tr.list()[0].lastActivityAt > startedAt).toBe(true);
    clock.advance(1200);
    tr.handle({ kind: 'task-progress', toolUseId: 'a' });
    expect(changes).toHaveLength(n + 1);
    tr.handle({ kind: 'sub-activity', parentToolUseId: 'nobody' });
    expect(changes).toHaveLength(n + 1);
  });

  it('keeps at most 50 entries, dropping the oldest ended ones first', () => {
    const { tr, feed } = make();
    feed([start('keep-running')]);
    for (let i = 0; i < 55; i++) feed([start(`d${i}`), { kind: 'tool-result', id: `d${i}`, isError: false, async: false }]);
    const ids = tr.list().map((d) => d.id);
    expect(ids).toHaveLength(50);
    expect(ids[0]).toBe('keep-running');
    expect(ids).not.toContain('d0');
    expect(ids).toContain('d54');
  });

  it('onChange carries the whole list after each state change', () => {
    const { feed, changes } = make();
    feed([start('a'), { kind: 'tool-result', id: 'a', isError: false, async: false }]);
    expect(changes.map((l) => l.map((d) => d.state))).toEqual([['running'], ['done']]);
  });
});

const AGENT_ID = 'a1b2c3d4e5f607182';
const idx = (evs: ClaudeEvent[], from: number, pred: (e: ClaudeEvent) => boolean): number => evs.findIndex((e, i) => i >= from && pred(e));
const sendMessage = (id: string, to = AGENT_ID): ClaudeEvent => ({ kind: 'tool-use', id, name: 'SendMessage', input: { to, message: 'again', summary: 'again' } });

describe('SendMessage resumes', () => {
  /** The positions of the resume in dispatch-resume.jsonl. */
  const resumeParts = () => {
    const evs = events('dispatch-resume.jsonl');
    const send = evs.findIndex((e) => e.kind === 'tool-use' && e.name === 'SendMessage');
    const resumed = idx(evs, send, (e) => e.kind === 'task-started');
    const toolResult = idx(evs, resumed, (e) => e.kind === 'tool-result');
    const turnResult = idx(evs, resumed, (e) => e.kind === 'result');
    const end = idx(evs, resumed, (e) => e.kind === 'task-ended');
    return { evs, send, resumed, toolResult, turnResult, end };
  };

  it('the first launch keeps the agent id (task_started) and the parser gives sub-activity its agent id', () => {
    const { tr, feed } = make();
    const evs = events('dispatch-resume.jsonl');
    expect(evs.find((e) => e.kind === 'sub-activity')).toMatchObject({ parentToolUseId: 'toolu_01Ab3dEf5gH7jK9mN1pQ3rS5', agentId: AGENT_ID });
    feed(evs.slice(0, 5));
    expect(tr.list()).toMatchObject([{ id: 'toolu_01Ab3dEf5gH7jK9mN1pQ3rS5', agentId: AGENT_ID, state: 'running', background: true }]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'dispatches.json'), 'utf8'))[0].agentId).toBe(AGENT_ID);
  });

  it('after the agent finished, a SendMessage to it makes the same dispatch run again; its next end is a second onEnded', () => {
    const { tr, feed, ended } = make();
    const { evs, send, resumed, toolResult, turnResult, end } = resumeParts();
    feed(evs.slice(0, send));
    expect(tr.list()).toMatchObject([{ state: 'done', description: 'Fix the build' }]);
    expect(ended).toHaveLength(1);
    const first = tr.list()[0];
    feed(evs.slice(send, resumed + 1));
    expect(tr.list()).toHaveLength(1);
    expect(tr.list()[0]).toMatchObject({ id: first.id, name: 'Max', description: 'Fix the build', state: 'running', background: true, endedAt: null, agentId: AGENT_ID });
    expect(tr.list()[0].lastActivityAt > first.lastActivityAt).toBe(true);
    expect(tr.list()[0].startedAt > first.startedAt).toBe(true);
    // the answer to the SendMessage and the turn's result do not end it
    feed(evs.slice(resumed + 1, toolResult + 1));
    expect(tr.list()[0].state).toBe('running');
    feed(evs.slice(toolResult + 1, turnResult + 1));
    expect(tr.list()[0].state).toBe('running');
    feed(evs.slice(turnResult + 1, end));
    expect(tr.list()[0].state).toBe('running');
    expect(ended).toHaveLength(1);
    // the sub-agent line of the resumed run carries the original Agent id; the notification carries the SendMessage id
    feed(evs.slice(end));
    expect(tr.list()).toMatchObject([{ id: first.id, state: 'done' }]);
    expect(tr.list()[0].endedAt).not.toBeNull();
    expect(ended).toHaveLength(2);
    expect(ended[1]).toMatchObject({ id: first.id, state: 'done', description: 'Fix the build' });
  });

  it('a SendMessage answer never ends or fails a dispatch', () => {
    const { tr, feed, ended } = make();
    feed([start('a', { run_in_background: true }), taskStarted('a', AGENT_ID, true), sendMessage('S')]);
    feed([{ kind: 'tool-result', id: 'S', isError: false, async: false }, { kind: 'tool-result', id: 'S', isError: true, async: false }]);
    expect(tr.list().map((d) => d.state)).toEqual(['running']);
    // also for a dispatch made from the SendMessage itself
    feed([taskStarted('S2', 'other-agent', true)]);
    expect(tr.list()).toHaveLength(1);
    feed([sendMessage('S3', 'x'), taskStarted('S3', 'x', true), { kind: 'tool-result', id: 'S3', isError: true, async: false }]);
    expect(tr.list().map((d) => [d.id, d.state])).toEqual([['a', 'running'], ['S3', 'running']]);
    expect(ended).toHaveLength(0);
  });

  it('every state revives: done, failed, stopped, unknown (and a description the old one lacked comes from the event)', () => {
    const { tr, feed } = make();
    feed([start('d', { description: 'First' }), taskStarted('d', 'ag-d'), { kind: 'tool-result', id: 'd', isError: false, async: false }]);
    feed([start('f', { description: 'Second' }), taskStarted('f', 'ag-f'), { kind: 'tool-result', id: 'f', isError: true, async: false }]);
    feed([start('s', { description: '' }), taskStarted('s', 'ag-s')]);
    feed([start('u', { description: 'Fourth' }), taskStarted('u', 'ag-u')]);
    tr.sessionExited();
    expect(tr.list().map((d) => d.state)).toEqual(['done', 'failed', 'unknown', 'unknown']);
    for (const [i, a] of ['ag-d', 'ag-f', 'ag-s', 'ag-u'].entries()) feed([sendMessage(`S${i}`, a), taskStarted(`S${i}`, a, true, { description: 'From the event' })]);
    expect(tr.list().map((d) => [d.id, d.state, d.description])).toEqual([
      ['d', 'running', 'First'],
      ['f', 'running', 'Second'],
      ['s', 'running', 'From the event'],
      ['u', 'running', 'Fourth'],
    ]);
    tr.stopRunning();
    feed([sendMessage('Sx', 'ag-d'), taskStarted('Sx', 'ag-d', true)]);
    expect(tr.list().map((d) => d.state)).toEqual(['running', 'stopped', 'stopped', 'stopped']);
  });

  it('after an app restart the dispatch (loaded as unknown) runs again and ends', () => {
    const first = make();
    const evs = events('dispatch-resume.jsonl');
    first.feed(evs.slice(0, 5)); // launched, running
    const again = make(); // the app restarted: the list comes from the file
    expect(again.tr.list()).toMatchObject([{ id: 'toolu_01Ab3dEf5gH7jK9mN1pQ3rS5', state: 'unknown', agentId: AGENT_ID }]);
    const r = events('dispatch-resume-restart.jsonl');
    const started = r.findIndex((e) => e.kind === 'task-started');
    again.feed(r.slice(0, started + 1));
    expect(again.tr.list()).toMatchObject([{ id: 'toolu_01Ab3dEf5gH7jK9mN1pQ3rS5', state: 'running', description: 'Fix the build', background: true, endedAt: null }]);
    const sub = r.findIndex((e) => e.kind === 'sub-activity');
    again.feed(r.slice(started + 1, sub + 1));
    expect(again.tr.list()[0].state).toBe('running');
    again.feed(r.slice(sub + 1));
    expect(again.tr.list()).toMatchObject([{ state: 'done' }]);
    expect(again.ended).toHaveLength(1);
  });

  it('an agent the tracker knows nothing about gets a dispatch of its own (the SendMessage id), then ends', () => {
    const { tr, feed, ended } = make();
    const r = events('dispatch-resume-restart.jsonl');
    const started = r.findIndex((e) => e.kind === 'task-started');
    const sub = r.findIndex((e) => e.kind === 'sub-activity');
    feed(r.slice(0, started + 1));
    expect(tr.list()).toMatchObject([{ id: 'toolu_01Ij2kL4mN6oP8qR0sT2uV4w', agent: 'max', departmentId: 'engineering', name: 'Max', description: 'Fix the build', background: true, state: 'running', agentId: AGENT_ID, endedAt: null }]);
    expect(tr.list()[0].by).toBeUndefined();
    const at = tr.list()[0].lastActivityAt;
    // the sub-agent line names the ORIGINAL Agent call: the agent id finds the dispatch
    feed(r.slice(started + 1, sub + 1));
    expect(tr.list()).toHaveLength(1);
    expect(tr.list()[0].lastActivityAt > at).toBe(true);
    feed(r.slice(sub + 1));
    expect(tr.list()).toMatchObject([{ state: 'done' }]);
    expect(ended).toHaveLength(1);
  });

  it('an unknown agent that is no department is named by its agent type and sends no onEnded', () => {
    const { tr, feed, ended } = make([]);
    feed(events('dispatch-resume-restart.jsonl'));
    expect(tr.list()).toMatchObject([{ agent: 'max', departmentId: null, name: 'max', state: 'done' }]);
    expect(ended).toHaveLength(0);
  });

  it('a task_started with an unknown tool_use_id and no SendMessage seen is ignored', () => {
    const { tr, feed } = make();
    feed([taskStarted('toolu_nobody', 'ag-x', true)]);
    expect(tr.list()).toEqual([]);
    // a SendMessage of another thread does not license it either
    feed([sendMessage('S9')]);
    feed([taskStarted('S9', 'ag-x', true)], { threadId: 'tab:t1', departmentId: 'engineering', name: 'Max' });
    expect(tr.list()).toEqual([]);
    // and a resume needs an agent type
    feed([taskStarted('S9', 'ag-x', true, { agent: '' })]);
    expect(tr.list()).toEqual([]);
  });

  it('sub-activity with only the agent id bumps lastActivityAt; an unknown agent id changes nothing', () => {
    const { tr, feed, changes, clock } = make();
    feed([start('a'), taskStarted('a', 'ag-a')]);
    const before = tr.list()[0].lastActivityAt;
    const n = changes.length;
    clock.advance(1500);
    tr.handle({ kind: 'sub-activity', parentToolUseId: 'toolu_other', agentId: 'ag-a' });
    expect(tr.list()[0].lastActivityAt > before).toBe(true);
    expect(changes).toHaveLength(n + 1);
    clock.advance(1500);
    tr.handle({ kind: 'sub-activity', parentToolUseId: 'toolu_other', agentId: 'ag-zzz' });
    tr.handle({ kind: 'sub-activity', parentToolUseId: 'toolu_other' });
    expect(changes).toHaveLength(n + 1);
  });

  it('a dispatch saved without agentId or by still loads, and keeps none', () => {
    const file = path.join(dir, 'dispatches.json');
    fs.writeFileSync(file, JSON.stringify([{ id: 'old', agent: 'max', departmentId: 'engineering', name: 'Max', description: 'x', background: false, state: 'done', startedAt: '2026-11-01T10:00:00.000Z', lastActivityAt: '2026-11-01T10:00:05.000Z', endedAt: '2026-11-01T10:00:09.000Z' }]));
    const { tr } = make();
    expect(tr.list()).toHaveLength(1);
    expect(tr.list()[0]).not.toHaveProperty('agentId');
    expect(tr.list()[0]).not.toHaveProperty('by');
    expect(tr.list()[0].state).toBe('done');
  });
});

describe('department chat dispatches', () => {
  const maxTab: DispatchBy = { threadId: 'tab:t1', departmentId: 'engineering', name: 'Max' };
  const otherTab: DispatchBy = { threadId: 'tab:t2', departmentId: null, name: 'Nina' };

  it('a tab stream gives "Max → worker" running, then done, attributed to the tab; no onEnded', () => {
    const { tr, feed, ended } = make();
    const evs = events('dispatch-tab.jsonl');
    const taskStart = evs.findIndex((e) => e.kind === 'task-started');
    feed(evs.slice(0, taskStart + 1), maxTab);
    expect(tr.list()).toMatchObject([{ agent: 'worker', departmentId: null, name: 'Max → worker', description: 'Check the docs', background: false, state: 'running', by: maxTab }]);
    const end = evs.findIndex((e) => e.kind === 'task-ended');
    feed(evs.slice(taskStart + 1, end), maxTab);
    expect(tr.list()[0].state).toBe('running');
    feed(evs.slice(end), maxTab);
    expect(tr.list().map((d) => [d.agent, d.name, d.state, d.background])).toEqual([
      ['worker', 'Max → worker', 'done', false],
      ['reader', 'Max → reader', 'done', true],
    ]);
    expect(tr.list().every((d) => d.by?.threadId === 'tab:t1')).toBe(true);
    expect(ended).toHaveLength(0);
  });

  it('a tab dispatch to a department agent keeps that department as target and still sends no onEnded', () => {
    const { tr, feed, ended } = make();
    feed([start('x', {}, 'max'), taskStarted('x', 'ag-x'), { kind: 'task-ended', toolUseId: 'x', taskId: 'ag-x', status: 'completed', notification: true, topLevel: true, background: false }], otherTab);
    expect(tr.list()).toMatchObject([{ departmentId: 'engineering', name: 'Nina → max', state: 'done', by: otherTab }]);
    expect(ended).toHaveLength(0);
  });

  it('a result and a process exit touch only their own thread', () => {
    const { tr, feed } = make();
    feed([start('c')]); // the chief of staff's, foreground
    feed([start('w'), start('wb', { run_in_background: true })], maxTab);
    feed([start('n')], otherTab);
    tr.handle(resultEv); // the chief of staff's turn is over
    expect(tr.list().map((d) => [d.id, d.state])).toEqual([['c', 'unknown'], ['w', 'running'], ['wb', 'running'], ['n', 'running']]);
    tr.handle(resultEv, maxTab);
    expect(tr.list().map((d) => [d.id, d.state])).toEqual([['c', 'unknown'], ['w', 'unknown'], ['wb', 'running'], ['n', 'running']]);
    tr.sessionExited('tab:t1');
    expect(tr.list().map((d) => [d.id, d.state])).toEqual([['c', 'unknown'], ['w', 'unknown'], ['wb', 'unknown'], ['n', 'running']]);
    tr.sessionExited(); // the chief of staff's
    expect(tr.list().find((d) => d.id === 'n')?.state).toBe('running');
    tr.sessionExited('tab:t2');
    expect(tr.list().find((d) => d.id === 'n')?.state).toBe('unknown');
  });

  it('lookups are per thread: the same call id in two threads is two dispatches', () => {
    const { tr, feed } = make();
    feed([start('same'), taskStarted('same', 'ag-1', true)]);
    feed([start('same'), taskStarted('same', 'ag-2', true)], maxTab);
    expect(tr.list()).toHaveLength(2);
    feed([{ kind: 'tool-result', id: 'same', isError: true, async: false }], maxTab);
    expect(tr.list().map((d) => [d.by?.threadId ?? 'cos', d.state])).toEqual([['cos', 'running'], ['tab:t1', 'failed']]);
    feed([{ kind: 'task-ended', toolUseId: null, taskId: 'ag-1', status: 'completed', notification: false, topLevel: true, background: true }], maxTab);
    expect(tr.list()[0].state).toBe('running');
    feed([{ kind: 'task-ended', toolUseId: null, taskId: 'ag-1', status: 'completed', notification: false, topLevel: true, background: true }]);
    expect(tr.list()[0].state).toBe('done');
  });

  it('a SendMessage resume inside a tab revives that tab dispatch, and creates one for an unknown agent', () => {
    const { tr, feed, ended } = make();
    feed([start('a', { run_in_background: true }, 'worker'), taskStarted('a', 'ag-a', true), { kind: 'task-ended', toolUseId: 'a', taskId: 'ag-a', status: 'completed', notification: true, topLevel: true, background: true }], maxTab);
    expect(tr.list()[0].state).toBe('done');
    feed([sendMessage('S', 'ag-a'), taskStarted('S', 'ag-a', true, { agent: 'worker' })], maxTab);
    expect(tr.list()).toMatchObject([{ id: 'a', state: 'running', by: maxTab }]);
    feed([sendMessage('S2', 'ag-new'), taskStarted('S2', 'ag-new', true, { agent: 'reader', description: 'Read it' })], maxTab);
    expect(tr.list()[1]).toMatchObject({ id: 'S2', name: 'Max → reader', agent: 'reader', description: 'Read it', state: 'running', by: maxTab, agentId: 'ag-new' });
    expect(ended).toHaveLength(0);
  });

  it('hasRunningBackground asks per thread; running() and stopRunning() stay org-wide', () => {
    const { tr, feed, clock } = make();
    feed([start('c')]);
    feed([start('wb', { run_in_background: true }, 'reader')], maxTab);
    expect(tr.hasRunningBackground()).toBe(true);
    expect(tr.hasRunningBackground('tab:t1')).toBe(true);
    expect(tr.hasRunningBackground('tab:t2')).toBe(false);
    expect(tr.hasRunningBackground('cos')).toBe(false);
    expect(tr.running().map((d) => d.id)).toEqual(['c', 'wb']);
    clock.advance(16 * 60_000);
    expect(tr.hasRunningBackground('tab:t1')).toBe(false); // silent for too long
    expect(tr.hasRunningBackground('tab:t1', 60 * 60_000)).toBe(true);
    const stopped = tr.stopRunning();
    expect(stopped.map((d) => [d.id, d.state, d.by?.threadId])).toEqual([['c', 'stopped', undefined], ['wb', 'stopped', 'tab:t1']]);
  });

  it('dropThread stops what ran in the thread, then removes all of its dispatches; the others stay', () => {
    const { tr, feed, changes, ended, file } = make();
    feed([start('c')]);
    feed([start('w'), start('d'), { kind: 'tool-result', id: 'd', isError: false, async: false }], maxTab);
    feed([start('n')], otherTab);
    const n = changes.length;
    const stopped = tr.dropThread('tab:t1');
    expect(stopped.map((d) => [d.id, d.state])).toEqual([['w', 'stopped']]);
    expect(stopped[0].endedAt).not.toBeNull();
    expect(tr.list().map((d) => d.id)).toEqual(['c', 'n']);
    expect(changes).toHaveLength(n + 1);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).map((d: Dispatch) => d.id)).toEqual(['c', 'n']);
    expect(ended).toHaveLength(0);
    expect(tr.dropThread('tab:t1')).toEqual([]);
    expect(changes).toHaveLength(n + 1);
    // the dropped thread's call ids are free again
    feed([start('w')], maxTab);
    expect(tr.list().map((d) => d.id)).toEqual(['c', 'n', 'w']);
  });

  it('`by` is kept in the file and read back (loaded running ones are unknown); a malformed one is dropped', () => {
    const { feed, file } = make();
    feed([start('w', {}, 'worker'), taskStarted('w', 'ag-w')], maxTab);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))[0].by).toEqual(maxTab);
    const again = make();
    expect(again.tr.list()).toMatchObject([{ id: 'w', state: 'unknown', by: maxTab, agentId: 'ag-w' }]);
    // the loaded dispatch still belongs to its tab: a resume in that tab revives it, in the chief of staff thread it does not
    again.feed([sendMessage('S', 'ag-w'), taskStarted('S', 'ag-w', true, { agent: 'worker' })]);
    expect(again.tr.list().map((d) => [d.id, d.state, d.by?.threadId])).toEqual([['w', 'unknown', 'tab:t1'], ['S', 'running', undefined]]);
    again.feed([sendMessage('S2', 'ag-w'), taskStarted('S2', 'ag-w', true, { agent: 'worker' })], maxTab);
    expect(again.tr.list().find((d) => d.id === 'w')?.state).toBe('running');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw[0].by = { threadId: 'tab:t1', departmentId: 7 };
    raw.push({ ...raw[0], id: 'k', by: { threadId: 'tab:t3', departmentId: null, name: 'Nina' } });
    fs.writeFileSync(file, JSON.stringify(raw));
    const bad = make();
    expect(bad.tr.list().find((d) => d.id === 'w')).not.toHaveProperty('by');
    expect(bad.tr.list().find((d) => d.id === 'k')?.by).toEqual({ threadId: 'tab:t3', departmentId: null, name: 'Nina' });
  });
});

describe('endedNotificationText', () => {
  it('names who and how it ended, never the task description (a notification can show on a locked screen)', () => {
    expect(endedNotificationText({ name: 'Max', state: 'done' })).toBe('Max finished');
    expect(endedNotificationText({ name: 'Max', state: 'failed' })).toBe('Max failed');
    expect(endedNotificationText({ name: 'Max', state: 'stopped' })).toBe('Max stopped');
  });
});
