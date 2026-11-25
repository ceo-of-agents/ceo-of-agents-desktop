import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StreamParser } from '../../src/main/claude/stream';

const FIX = path.join(__dirname, '..', 'fixtures', 'claude');
const read = (n: string) => fs.readFileSync(path.join(FIX, n), 'utf8');

describe('StreamParser', () => {
  it('reads plan usage from rate_limit_event and the HTTP status of a failed result (fixtures)', () => {
    const ok = new StreamParser().feed(read('rate-limit-allowed.jsonl'));
    expect(ok.find((e) => e.kind === 'rate-limit')).toMatchObject({ kind: 'rate-limit', info: { status: 'allowed_warning', windows: [{ key: 'five_hour' }, { key: 'seven_day' }] } });
    expect(ok[ok.length - 1]).not.toHaveProperty('apiErrorStatus');
    const no = new StreamParser().feed(read('rate-limit-rejected.jsonl'));
    expect(no.find((e) => e.kind === 'rate-limit')).toMatchObject({ info: { status: 'rejected', limitType: 'five_hour' } });
    expect(no[no.length - 1]).toMatchObject({ kind: 'result', isError: true, apiErrorStatus: 429 });
    expect(new StreamParser().feed('{"type":"rate_limit_event","rate_limit_info":"x"}\n')).toEqual([]);
  });

  it('parses a plain reply', () => {
    const ev = new StreamParser().feed(read('plain-reply.jsonl'));
    expect(ev[0]).toMatchObject({ kind: 'init' });
    expect(ev.filter((e) => e.kind === 'text-delta')).toEqual([{ kind: 'text-delta', text: 'ok' }]);
    expect(ev.filter((e) => e.kind === 'assistant-text')).toEqual([{ kind: 'assistant-text', text: 'ok' }]);
    const r = ev[ev.length - 1];
    expect(r).toMatchObject({ kind: 'result', isError: false, text: 'ok' });
  });

  it('reads the resolved model id of the init message (recorded fixture)', () => {
    for (const f of ['plain-reply.jsonl', 'two-messages.jsonl', 'write-permission.jsonl']) {
      expect(new StreamParser().feed(read(f))[0]).toMatchObject({ kind: 'init', model: 'claude-haiku-5-5' });
    }
  });

  it('init: the model is null when absent or not a string; other system messages are dropped', () => {
    const line = (o: object) => JSON.stringify(o) + '\n';
    const ev = new StreamParser().feed(
      line({ type: 'system', subtype: 'init', session_id: 's1' }) + line({ type: 'system', subtype: 'init', session_id: 's2', model: 5 }) +
        line({ type: 'system', subtype: 'init', session_id: 's3', model: ' claude-opus-5-5[1m] ' }) + line({ type: 'system', subtype: 'hook_started', session_id: 's4', model: 'x' }),
    );
    expect(ev).toEqual([
      { kind: 'init', sessionId: 's1', model: null, mcpFailed: [], mcpServers: [] },
      { kind: 'init', sessionId: 's2', model: null, mcpFailed: [], mcpServers: [] },
      { kind: 'init', sessionId: 's3', model: 'claude-opus-5-5[1m]', mcpFailed: [], mcpServers: [] },
    ]);
  });

  it('init: mcpFailed lists the servers with status failed, in order and without repeats; junk is ignored', () => {
    const line = (o: object) => JSON.stringify(o) + '\n';
    const init = (mcp: unknown) => new StreamParser().feed(line({ type: 'system', subtype: 'init', session_id: 's', mcp_servers: mcp }));
    expect(init([{ name: 'coa', status: 'connected' }, { name: 'github', status: 'failed' }, { name: 'docs', status: 'pending' }, { name: 'github', status: 'failed' }, { name: 'wiki', status: 'failed' }])).toMatchObject([{ kind: 'init', mcpFailed: ['github', 'wiki'] }]);
    expect(init('nope')).toMatchObject([{ mcpFailed: [] }]);
    expect(init([null, 5, { status: 'failed' }, { name: 7, status: 'failed' }])).toMatchObject([{ mcpFailed: [] }]);
  });

  it('init: mcpServers keeps name, status and source; coa stays at parse level; bad entries are ignored', () => {
    const line = (o: object) => JSON.stringify(o) + '\n';
    const init = (mcp: unknown) => new StreamParser().feed(line({ type: 'system', subtype: 'init', session_id: 's', mcp_servers: mcp }))[0] as { mcpServers: unknown };
    expect(
      init([
        { name: 'coa', status: 'connected', source: 'dynamic' },
        { name: ' example-project ', status: ' connected ', source: 'project' },
        { name: 'claude.ai Example', status: 5, source: 7 },
        { name: 'example-project', status: 'failed', source: 'local' },
        { name: '', status: 'connected' },
        { name: '   ' },
        { status: 'failed' },
        { name: 9 },
        null,
        'x',
        [],
      ]).mcpServers,
    ).toEqual([
      { name: 'coa', status: 'connected', source: 'dynamic' },
      { name: 'example-project', status: 'connected', source: 'project' },
      { name: 'claude.ai Example', status: 'unknown', source: null },
    ]);
    expect(init('nope').mcpServers).toEqual([]);
    expect(init(undefined).mcpServers).toEqual([]);
  });

  it('init: mcpServers cuts strings at 200 characters, keeps at most 200 entries, one per name', () => {
    const line = (o: object) => JSON.stringify(o) + '\n';
    const many = Array.from({ length: 250 }, (_, i) => ({ name: `s${i % 230}`, status: 'connected', source: 'project' }));
    const ev = new StreamParser().feed(line({ type: 'system', subtype: 'init', session_id: 's', mcp_servers: [{ name: 'n'.repeat(300), status: 's'.repeat(300), source: 'p'.repeat(300) }, ...many] }))[0] as { mcpServers: Array<{ name: string; status: string; source: string }> };
    expect(ev.mcpServers).toHaveLength(200);
    expect(ev.mcpServers[0]).toEqual({ name: 'n'.repeat(200), status: 's'.repeat(200), source: 'p'.repeat(200) });
    expect(new Set(ev.mcpServers.map((m) => m.name)).size).toBe(200);
  });

  it('init: the recorded fixtures give every server with its scope (Claude Code 2.1.327)', () => {
    const ev = new StreamParser().feed(read('mcp-init-cos.jsonl')).filter((e) => e.kind === 'init');
    expect(ev).toHaveLength(2);
    expect(ev[1]).toMatchObject({ mcpServers: [{ name: 'example-project', source: 'project' }, { name: 'example-remote' }, { name: 'example-local', source: 'local' }] });
  });

  it('is chunk-independent', () => {
    const raw = read('two-messages.jsonl');
    const whole = new StreamParser().feed(raw);
    const p = new StreamParser();
    const parts: ReturnType<StreamParser['feed']> = [];
    for (let i = 0; i < raw.length; i += 7) parts.push(...p.feed(raw.slice(i, i + 7)));
    parts.push(...p.flush());
    expect(parts).toEqual(whole);
    expect(whole.filter((e) => e.kind === 'result')).toHaveLength(2);
  });

  it('reads tool_use blocks', () => {
    const ev = new StreamParser().feed(read('write-permission.jsonl'));
    const tool = ev.find((e) => e.kind === 'tool-use');
    expect(tool).toMatchObject({ kind: 'tool-use', name: 'Write', input: { file_path: '/tmp/hq/note.md', content: 'hi' } });
  });

  it('reads the result of each tool call (a tool_result block in a user message)', () => {
    const line = (content: unknown[], parent: string | null = null) => JSON.stringify({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: parent }) + '\n';
    const ev = new StreamParser().feed(
      line([{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }]) + line([{ type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: 'no' }]) + line([{ type: 'tool_result', tool_use_id: 'sub' }], 'toolu_x') + line([{ type: 'text', text: 'hi' }]),
    );
    expect(ev).toEqual([
      { kind: 'tool-result', id: 'tu1', isError: false, async: false },
      { kind: 'tool-result', id: 'tu2', isError: true, async: false },
      { kind: 'sub-activity', parentToolUseId: 'toolu_x' },
    ]);
  });

  it('reads the real tool result of a recorded turn', () => {
    const ev = new StreamParser().feed(read('write-permission.jsonl'));
    expect(ev.find((e) => e.kind === 'tool-result')).toMatchObject({ kind: 'tool-result', id: 'toolu_fake3_006', isError: false });
  });

  it('drops hooks, empty rate limits, sub-agent events, tool results and non-JSON', () => {
    const lines = [
      'Warning: something',
      JSON.stringify({ type: 'system', subtype: 'hook_started', output: 'secret managed text' }),
      JSON.stringify({ type: 'system', subtype: 'hook_response', output: 'secret managed text' }),
      JSON.stringify({ type: 'rate_limit_event', rate_limit_info: {} }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'from sub-agent' } },
        parent_tool_use_id: 'toolu_x',
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'sub text' }] },
        parent_tool_use_id: 'toolu_x',
      }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'main' } },
        parent_tool_use_id: null,
      }),
    ];
    const ev = new StreamParser().feed(lines.join('\n') + '\n');
    // sub-agent traffic only shows as a sign of life, with no content
    expect(ev).toEqual([
      { kind: 'sub-activity', parentToolUseId: 'toolu_x' },
      { kind: 'sub-activity', parentToolUseId: 'toolu_x' },
      { kind: 'text-delta', text: 'main' },
    ]);
  });

  it('flush parses a last line without newline and flags error results', () => {
    const p = new StreamParser();
    expect(p.feed('{"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom"}')).toEqual([]);
    expect(p.flush()).toEqual([{ kind: 'result', isError: true, text: 'boom', sessionId: null, numTurns: null, contextTokens: null }]);
  });
});

describe('StreamParser contextTokens', () => {
  const results = (name: string) => new StreamParser().feed(read(name)).filter((e) => e.kind === 'result');

  it('reads the last model call of the turn from usage.iterations (recorded fixtures)', () => {
    // the result's own usage is summed over the turn (cache_read 34789); iterations holds the last call: 2 + 21291 + 236
    expect(results('write-permission.jsonl')).toMatchObject([{ kind: 'result', contextTokens: 21529 }]);
    // the first turn of a session is mostly cache creation: 2 + 7774 + 13498
    expect(results('plain-reply.jsonl')).toMatchObject([{ contextTokens: 21274 }]);
  });

  it('falls back to the usage of the last top-level assistant message of the turn, else null', () => {
    const line = (o: object) => JSON.stringify(o) + '\n';
    const asst = (usage: object | undefined, parent: string | null = null) => line({ type: 'assistant', parent_tool_use_id: parent, message: { role: 'assistant', content: [{ type: 'text', text: 'x' }], ...(usage ? { usage } : {}) } });
    const result = (usage?: object) => line({ type: 'result', subtype: 'success', is_error: false, result: 'x', ...(usage ? { usage } : {}) });
    const ev = new StreamParser().feed(
      asst({ input_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 }) +
        asst({ input_tokens: 5, cache_read_input_tokens: 500 }, 'toolu_sub') + // a sub-agent's call is not the context
        asst({ input_tokens: 2, cache_read_input_tokens: 1000, cache_creation_input_tokens: 20 }) +
        result({ input_tokens: 99999, cache_read_input_tokens: 99999 }) +
        // the fallback is reset at each result: nothing before this one
        result() +
        asst({ input_tokens: 3 }) +
        result({ iterations: [] }) +
        result({ iterations: [{ input_tokens: 7, cache_read_input_tokens: 70, cache_creation_input_tokens: 700 }] }),
    );
    expect(ev.flatMap((e) => (e.kind === 'result' ? [e.contextTokens] : []))).toEqual([1022, null, 3, 777]);
  });
});

describe('StreamParser command_lifecycle', () => {
  it('reads the uuid and state of a written message; drops a malformed one', () => {
    const line = (o: object) => JSON.stringify(o) + '\n';
    const ev = new StreamParser().feed(
      line({ type: 'command_lifecycle', command_uuid: 'u-1', state: 'queued', uuid: 'x', session_id: 's' }) +
        line({ type: 'command_lifecycle', command_uuid: 'u-1', state: 'started', uuid: 'y', session_id: 's' }) +
        line({ type: 'command_lifecycle', state: 'completed' }),
    );
    expect(ev).toEqual([
      { kind: 'command', uuid: 'u-1', state: 'queued' },
      { kind: 'command', uuid: 'u-1', state: 'started' },
    ]);
  });
});

describe('StreamParser result num_turns', () => {
  it('reads num_turns, null when absent', () => {
    const line = (o: object) => JSON.stringify(o) + '\n';
    const ev = new StreamParser().feed(line({ type: 'result', subtype: 'success', is_error: false, result: '', num_turns: 0 }) + line({ type: 'result', subtype: 'success', is_error: false, result: 'x' }));
    expect(ev).toMatchObject([{ kind: 'result', numTurns: 0 }, { kind: 'result', numTurns: null }]);
  });

  it('hook events with a parent are still ignored', () => {
    const l = JSON.stringify({ type: 'system', subtype: 'hook_response', parent_tool_use_id: 'toolu_x', output: 'secret' });
    expect(new StreamParser().feed(l + '\n')).toEqual([]);
  });

  it('marks the tool_result of a background launch as async', () => {
    const l = (content: unknown) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content }] } }) + '\n';
    const ev = new StreamParser().feed(l([{ type: 'text', text: 'Async agent launched successfully. x' }]) + l('Async agent launched') + l('done') + l(undefined));
    expect(ev.map((e) => e.kind === 'tool-result' && e.async)).toEqual([true, true, false, false]);
  });

  it('task_updated: only a final status ends a task', () => {
    const l = (status: string) => JSON.stringify({ type: 'system', subtype: 'task_updated', task_id: 'k1', patch: { status } }) + '\n';
    const noPatch = JSON.stringify({ type: 'system', subtype: 'task_updated', task_id: 'k1', patch: {} }) + '\n';
    expect(new StreamParser().feed(l('running') + l('weird') + noPatch)).toEqual([]);
    const ev = new StreamParser().feed(l('running') + l('weird') + l('killed') + l('cancelled') + noPatch);
    expect(ev).toEqual([
      { kind: 'task-ended', toolUseId: null, taskId: 'k1', status: 'killed', notification: false, topLevel: false, background: false },
      { kind: 'task-ended', toolUseId: null, taskId: 'k1', status: 'cancelled', notification: false, topLevel: false, background: false },
    ]);
  });
});

describe('StreamParser dispatch events (recorded fixtures)', () => {
  const raw = (n: string) =>
    read(n)
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  it.each(['dispatch-foreground.jsonl', 'dispatch-background.jsonl', 'dispatch-failed.jsonl', 'dispatch-parallel.jsonl'])('%s: sub-agent lines give activity only', (f) => {
    const ev = new StreamParser().feed(read(f));
    const lines = raw(f);
    const sub = lines.filter((l) => l.parent_tool_use_id != null && l.type !== 'system').length;
    expect(ev.filter((e) => e.kind === 'sub-activity')).toHaveLength(sub);
    // every text and tool event comes from a top-level line
    const topTools = new Set<string>();
    const topTexts = new Set<string>();
    for (const l of lines) {
      if (l.parent_tool_use_id != null || l.type !== 'assistant') continue;
      for (const b of (l.message as { content: Array<{ type: string; id?: string; text?: string }> }).content) {
        if (b.type === 'tool_use') topTools.add(b.id!);
        if (b.type === 'text') topTexts.add(b.text!);
      }
    }
    for (const e of ev) {
      if (e.kind === 'tool-use') expect(topTools.has(e.id)).toBe(true);
      if (e.kind === 'assistant-text') expect(topTexts.has(e.text)).toBe(true);
    }
    const topResults = lines.filter((l) => l.parent_tool_use_id == null && l.type === 'user').length;
    expect(ev.filter((e) => e.kind === 'tool-result')).toHaveLength(topResults);
  });

  it('foreground: tool use, task start, end signals, result', () => {
    const ev = new StreamParser().feed(read('dispatch-foreground.jsonl'));
    expect(ev.find((e) => e.kind === 'tool-use')).toMatchObject({ kind: 'tool-use', name: 'Agent', input: { subagent_type: 'max', description: 'Say pong' } });
    expect(ev.filter((e) => e.kind === 'task-started')).toEqual([
      { kind: 'task-started', toolUseId: 'toolu_01AwMPXkYJjgz2p1HDNRQMvC', taskId: 'a009c0d7d919ca05b', agent: 'max', description: 'Say pong', background: false },
    ]);
    expect(ev.filter((e) => e.kind === 'task-ended')).toEqual([
      { kind: 'task-ended', toolUseId: null, taskId: 'a009c0d7d919ca05b', status: 'completed', notification: false, topLevel: true, background: false },
      { kind: 'task-ended', toolUseId: 'toolu_01AwMPXkYJjgz2p1HDNRQMvC', taskId: 'a009c0d7d919ca05b', status: 'completed', notification: true, topLevel: true, background: false },
    ]);
    expect(ev.find((e) => e.kind === 'tool-result')).toMatchObject({ id: 'toolu_01AwMPXkYJjgz2p1HDNRQMvC', isError: false, async: false });
    expect(ev.filter((e) => e.kind === 'text-delta')).toEqual([{ kind: 'text-delta', text: 'done.' }]);
  });

  it('background: the launch result is async, nested shell tasks are dropped', () => {
    const ev = new StreamParser().feed(read('dispatch-background.jsonl'));
    expect(ev.filter((e) => e.kind === 'task-started')).toEqual([
      { kind: 'task-started', toolUseId: 'toolu_01JxwAaJcbsgbwoVyNd2eEZ7', taskId: 'a75d2788ce3611bd4', agent: 'max', description: 'Count to three', background: true },
    ]);
    expect(ev.find((e) => e.kind === 'tool-result')).toMatchObject({ isError: false, async: true });
    expect(ev.filter((e) => e.kind === 'task-progress')).toHaveLength(1);
    expect(ev.filter((e) => e.kind === 'result')).toHaveLength(2);
    expect(ev.filter((e) => e.kind === 'assistant-text').map((e) => (e as { text: string }).text)).toEqual(['dispatched.', 'The background agent finished and replied "pong" after its 20-second sleep.']);
  });

  it("task-ended carries the task's is_backgrounded from its task_started", () => {
    const l = (o: object) => JSON.stringify({ type: 'system', ...o }) + '\n';
    const started = (id: string, bg: boolean) => l({ subtype: 'task_started', task_id: id, tool_use_id: 'tu-' + id, description: 'd', subagent_type: 'max', is_backgrounded: bg, task_type: 'local_agent' });
    const note = (id: string) => l({ subtype: 'task_notification', task_id: id, tool_use_id: 'tu-' + id, status: 'completed' });
    const ev = new StreamParser().feed(started('bg', true) + started('fg', false) + note('bg') + note('fg') + note('unknown'));
    expect(ev.filter((e) => e.kind === 'task-ended').map((e) => (e.kind === 'task-ended' ? [e.taskId, e.topLevel, e.background] : null))).toEqual([
      ['bg', true, true],
      ['fg', true, false],
      ['unknown', false, false],
    ]);
    // the recorded fixtures: the top-level agent's notification is a background one only for the background agents
    const topOf = (f: string) => new StreamParser().feed(read(f)).filter((e) => e.kind === 'task-ended' && e.notification && e.topLevel).map((e) => (e.kind === 'task-ended' ? e.background : null));
    expect(topOf('dispatch-background.jsonl')).toEqual([true]);
    expect(topOf('dispatch-foreground.jsonl')).toEqual([false]);
    expect(topOf('dispatch-parallel.jsonl').sort()).toEqual([false, true, true]);
  });

  it('failed: only an error tool_result, no task lines', () => {
    const ev = new StreamParser().feed(read('dispatch-failed.jsonl'));
    expect(ev.some((e) => e.kind.startsWith('task-'))).toBe(false);
    expect(ev.find((e) => e.kind === 'tool-result')).toMatchObject({ isError: true, async: false });
  });

  it('parallel: three top-level tasks, no task for the nested shell commands', () => {
    const ev = new StreamParser().feed(read('dispatch-parallel.jsonl'));
    const started = ev.filter((e) => e.kind === 'task-started') as Array<{ taskId: string; agent: string; background: boolean }>;
    expect(started.map((s) => [s.agent, s.background])).toEqual([
      ['max', true],
      ['max', true],
      ['reader', false],
    ]);
    expect(started.some((s) => s.taskId === 'bg42prkxp' || s.taskId === 'b22hrfvnu')).toBe(false);
    expect(ev.filter((e) => e.kind === 'tool-use' && e.name === 'Agent')).toHaveLength(3);
  });
});

describe('StreamParser activity', () => {
  it('a model stream event other than a text delta is activity; a text delta stays text', () => {
    const line = (o: object) => JSON.stringify(o) + '\n';
    const ev = new StreamParser().feed(
      line({ type: 'stream_event', event: { type: 'message_start', message: {} } }) +
        line({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'x' } } }) +
        line({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } }),
    );
    expect(ev).toEqual([{ kind: 'activity' }, { kind: 'activity' }, { kind: 'text-delta', text: 'hi' }]);
  });
});

describe('StreamParser sub-agent tool calls', () => {
  it('a tool_use of a sub-agent gives a sub-tool-use event next to the sign of life', () => {
    const l = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u1', name: 'Write', input: { file_path: 'inbox/a.md' } }] }, parent_tool_use_id: 'toolu_x' });
    expect(new StreamParser().feed(l + '\n')).toEqual([
      { kind: 'sub-activity', parentToolUseId: 'toolu_x' },
      { kind: 'sub-tool-use', parentToolUseId: 'toolu_x', name: 'Write', input: { file_path: 'inbox/a.md' } },
    ]);
  });
});
