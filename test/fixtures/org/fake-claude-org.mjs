// A scriptable fake `claude -p --input-format stream-json` for orchestration tests. One turn per stdin line.
// Env: FAKE_SID (session id, default "sid-1"), FAKE_REPLY (text, default "ok"), FAKE_TOOLS (JSON array of
// {name,input} emitted as tool_use before the text), FAKE_DELAY_MS (wait before the result),
// FAKE_STALE_RESUME=1 (when started with --resume: answer with an error result "No conversation found"),
// FAKE_TOOL_RESULTS=1 (a tool_result user message after each tool_use), FAKE_TEXT_DELAY_MS (wait between the last tool and the text),
// A tool may also carry `write` (a string: the file at input.file_path is written with it when the tool runs, unless `error` is set)
// and `error: true` (its tool_result has is_error: true). Set FAKE_TOOL_RESULTS=1 for tool results at all.
// FAKE_MCP_FAILED (comma list: init carries `mcp_servers` with these names as failed, plus a connected `coa`),
// A tool may also carry `writePath` (an absolute path written instead of input.file_path: for a Bash tool that writes a file).
// FAKE_SUB_TOOLS (JSON array of tools like FAKE_TOOLS, `write` honoured): run by a foreground sub-agent, so every line carries
// parent_tool_use_id and none is a tool call of the thread itself (a top-level Agent tool_use is emitted first).
// FAKE_BG_WRITE (JSON {path, content, delayMs}): a background agent is launched during the turn (task_started, is_backgrounded);
// delayMs after the result it writes `content` to `path`, ends (task_notification) and Claude Code reports with a turn of its own.
// FAKE_MODEL (resolved model id in the init message), FAKE_LOG (file: append "ARGS <json>" at start and each stdin line).
import fs from 'node:fs';
import readline from 'node:readline';

const sid = process.env.FAKE_SID || 'sid-1';
const reply = process.env.FAKE_REPLY ?? 'ok';
const tools = JSON.parse(process.env.FAKE_TOOLS || '[]');
const delay = Number(process.env.FAKE_DELAY_MS || 0);
const subTools = JSON.parse(process.env.FAKE_SUB_TOOLS || '[]');
let bg = process.env.FAKE_BG_WRITE ? JSON.parse(process.env.FAKE_BG_WRITE) : null;
const toolResults = process.env.FAKE_TOOL_RESULTS === '1';
const textDelay = Number(process.env.FAKE_TEXT_DELAY_MS || 0);
const stale = process.env.FAKE_STALE_RESUME === '1' && process.argv.includes('--resume');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, 'ARGS ' + JSON.stringify(process.argv.slice(2)) + '\n');

let chain = Promise.resolve();
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, line + '\n');
  chain = chain.then(async () => {
    out({ type: 'system', subtype: 'init', session_id: sid, ...(process.env.FAKE_MODEL ? { model: process.env.FAKE_MODEL } : {}), ...(process.env.FAKE_MCP_FAILED ? { mcp_servers: [{ name: 'coa', status: 'connected' }, ...process.env.FAKE_MCP_FAILED.split(',').map((name) => ({ name, status: 'failed' }))] } : {}) });
    if (delay) await sleep(delay);
    if (stale) {
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'No conversation found with session ID: x', session_id: sid });
      return;
    }
    tools.forEach((t, i) => {
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu' + i, name: t.name, input: t.input }] } });
      if (typeof t.write === 'string' && !t.error) fs.writeFileSync(t.writePath ?? t.input.file_path, t.write);
      if (toolResults) out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu' + i, content: t.error ? 'denied' : 'ok', ...(t.error ? { is_error: true } : {}) }] }, parent_tool_use_id: null });
    });
    if (subTools.length) {
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'agent1', name: 'Agent', input: { subagent_type: 'worker', description: 'w' } }] } });
      subTools.forEach((t, i) => {
        out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'su' + i, name: t.name, input: t.input }] }, parent_tool_use_id: 'agent1' });
        if (typeof t.write === 'string' && !t.error) fs.writeFileSync(t.writePath ?? t.input.file_path, t.write);
        out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'su' + i, content: 'ok' }] }, parent_tool_use_id: 'agent1' });
      });
      out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'agent1', content: 'done' }] }, parent_tool_use_id: null });
    }
    if (bg) out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'bg1', name: 'Agent', input: { subagent_type: 'worker', description: 'w', run_in_background: true } }] }, parent_tool_use_id: null });
    if (bg) out({ type: 'system', subtype: 'task_started', task_type: 'local_agent', tool_use_id: 'bg1', task_id: 'bgtask1', subagent_type: 'worker', description: 'w', is_backgrounded: true });
    if (textDelay) await sleep(textDelay);
    if (reply) {
      out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } } });
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } });
    }
    out({ type: 'result', subtype: 'success', is_error: false, result: reply, session_id: sid });
    if (bg) {
      const b = bg;
      bg = null;
      setTimeout(() => {
        fs.writeFileSync(b.path, b.content);
        out({ type: 'system', subtype: 'task_notification', status: 'completed', task_id: 'bgtask1', tool_use_id: 'bg1' });
        out({ type: 'system', subtype: 'init', session_id: sid });
        out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'The worker is done' }] } });
        out({ type: 'result', subtype: 'success', is_error: false, result: 'The worker is done', session_id: sid, num_turns: 1 });
      }, Number(b.delayMs || 0)).unref?.();
    }
  });
});
rl.on('close', () => chain.then(() => process.exit(0)));
