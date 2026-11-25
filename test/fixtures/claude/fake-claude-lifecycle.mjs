// A fake `claude -p --input-format stream-json` that sends `command_lifecycle` events for each written message (by its
// `uuid`) and can start turns on its own, as Claude Code 2.1.327 does (checked live with haiku, 2026-11-18):
// - a background task or agent that finishes starts a turn with no message written (task_notification, init, text, result);
// - on --resume, a notice left from the previous process ("background agents did not finish") gets its own empty result
//   (num_turns 0) after the written message is queued and before it starts;
// - a message written while a turn runs is absorbed into that turn: started, completed, then one result.
// Env: FAKE_SCENARIO (below), FAKE_LOG (file: append each stdin line).
//   resume-notice: 1st message: queued, empty result of the leftover notice, then started, "resumed", result, completed.
//   queued-behind: 1st message: queued, a turn of Claude Code's own ("A background agent finished."), then started, "answer".
//   queued-behind-tool: like queued-behind, but the turn of its own makes a Write tool call (tool_use and a successful
//     tool_result, id tu-own) before its result; then started, "answer", completed.
//   background-later: every message gets "started" as a normal turn; 80 ms after the 1st, a turn of its own ("Max is done.").
//   absorbed: 1st message: queued, started, text, completed, then the result (the order of an absorbed message).
//   completed-after-result: 1st message: queued, its text and result, then completed (no started).
//   queued-never-started: 1st message: queued, a turn of its own ("Background done."), then nothing more for it.
//   notice-after-started: 1st message: queued, started, the leftover notice's empty result, then "resumed", completed.
//   no-lifecycle-notice: no lifecycle events: the leftover notice's empty result, then "resumed".
//   no-lifecycle-local: no lifecycle events: only an empty result of no model call (a local command).
//   empty-then-slow: 1st message: queued, started, the leftover notice's empty result, then nothing for FAKE_SLOW_MS
//     (the model thinking), then "resumed", completed.
//   empty-before-started: 1st message: queued, the empty result, started, then "resumed" after FAKE_SLOW_MS.
//   no-lifecycle-slow: no lifecycle events: the empty result, a message_start event, FAKE_SLOW_MS, then "resumed".
//   queued-behind-long: 1st message: queued, a turn of its own (result "First."), a second own turn (init, then
//     FAKE_SLOW_MS of silence: a long tool, then "Second."), then started, "answer", completed.
//   exit-while-held: 1st message: queued, a turn of its own, then the process exits (code 3).
//   report-pending-empty: 1st message: a normal turn with a top-level background agent (task_started), then its
//     task_notification, then an empty result of no model call (num_turns 0), then nothing (the process stays up).
//   race-recorded: replays FAKE_FIXTURE (dispatch-race.jsonl, recorded with Claude Code 2.1.327). The 1st message gets
//     the fixture up to the lifecycle `queued` of the 2nd message (the turn, then the background agent's activity and
//     notifications); the 2nd message gets the rest (queued, Claude Code's own report turn, started, the turn for it,
//     completed). The recorded command uuids are replaced by the uuids the session wrote, in order.
//   rp-one, rp-two, rp-keepalive, rp-fold, rp-queued-own, rp-queued-completed, rp-queued-never: pending reports (see reportScenario below;
//     env FAKE_BG=false makes the launched agents foreground, FAKE_STATUS, FAKE_OWN, FAKE_EXIT, FAKE_BEATS, FAKE_BEAT_MS).
//   Later messages (all scenarios): a normal turn answering "next".
import fs from 'node:fs';
import readline from 'node:readline';

const sid = 'sid-lc';
const scenario = process.env.FAKE_SCENARIO || 'resume-notice';
const slow = Number(process.env.FAKE_SLOW_MS || 300);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const life = (uuid, state) => out({ type: 'command_lifecycle', command_uuid: uuid, state, uuid: 'lc-' + state, session_id: sid });
const text = (t) => {
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }, session_id: sid, parent_tool_use_id: null });
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] }, session_id: sid, parent_tool_use_id: null });
};
const result = (t, turns = 1) => out({ type: 'result', subtype: 'success', is_error: false, result: t, num_turns: turns, session_id: sid });
const init = () => out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-haiku-5-5' });
const notice = () => out({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'stopped', session_id: sid });
const normal = (uuid, reply) => {
  life(uuid, 'queued');
  life(uuid, 'started');
  init();
  text(reply);
  result(reply);
  life(uuid, 'completed');
};

// rp-* scenarios (pending reports). The 1st message is a normal turn that launches agents (task_started, top level);
// "background" is FAKE_BG (default true). Helpers:
const agent = (id, bg = true) => out({ type: 'system', subtype: 'task_started', task_id: id, tool_use_id: 'toolu_' + id, description: 'Job ' + id, subagent_type: 'max', is_backgrounded: bg, task_type: 'local_agent', session_id: sid });
const notify = (id, status = 'completed') => out({ type: 'system', subtype: 'task_notification', task_id: id, tool_use_id: 'toolu_' + id, status, summary: 'done', session_id: sid });
const progress = (id) => out({ type: 'system', subtype: 'task_progress', task_id: id, tool_use_id: 'toolu_' + id, description: 'working', session_id: sid });
const ownTurn = (t) => {
  init();
  text(t);
  result(t);
};
const launch = (uuid, ids) => {
  life(uuid, 'queued');
  life(uuid, 'started');
  init();
  for (const id of ids) agent(id, process.env.FAKE_BG !== 'false');
  text('dispatched.');
  result('dispatched.');
  life(uuid, 'completed');
};
async function reportScenario(sc, uuid, idx) {
  if (idx > 0 && sc !== 'rp-fold' && sc !== 'rp-queued-own' && sc !== 'rp-queued-completed' && sc !== 'rp-queued-never') return normal(uuid, 'next');
  switch (sc) {
    // 1st: launch bg1, then (20 ms later, idle) its notification with FAKE_STATUS (default completed); FAKE_OWN=1: then
    // Claude Code's own report turn; FAKE_EXIT=1: then the process exits (code 3).
    case 'rp-one':
      launch(uuid, ['bg1']);
      await sleep(20);
      notify('bg1', process.env.FAKE_STATUS || 'completed');
      if (process.env.FAKE_OWN === '1') {
        await sleep(20);
        ownTurn('report');
      }
      if (process.env.FAKE_EXIT === '1') {
        await sleep(20);
        process.exit(3);
      }
      return;
    // 1st: launch a and b, both notifications back to back (idle), then two own report turns, 20 ms apart.
    case 'rp-two':
      launch(uuid, ['a', 'b']);
      await sleep(20);
      notify('a');
      notify('b');
      await sleep(20);
      ownTurn('report a');
      await sleep(20);
      ownTurn('report b');
      return;
    // 1st: launch bg1, notification (idle), then FAKE_BEATS task_progress lines FAKE_BEAT_MS apart, then silence.
    case 'rp-keepalive': {
      launch(uuid, ['bg1']);
      await sleep(20);
      notify('bg1');
      for (let i = 0; i < Number(process.env.FAKE_BEATS || 5); i++) {
        await sleep(Number(process.env.FAKE_BEAT_MS || 60));
        progress('bg1');
      }
      return;
    }
    // 1st: launch bg1 and its notification while idle. 2nd (ours): queued, started, answer, completed; no report turn.
    case 'rp-fold':
      if (idx === 0) {
        launch(uuid, ['bg1']);
        await sleep(20);
        notify('bg1');
        return;
      }
      normal(uuid, 'M');
      return;
    // 1st: launch bg1 (no notification). 2nd (ours): queued, the notification (our message waits in Claude Code's queue),
    // Claude Code's own report turn, then started, answer, completed.
    case 'rp-queued-own':
      if (idx === 0) return launch(uuid, ['bg1']);
      life(uuid, 'queued');
      notify('bg1');
      ownTurn('report');
      life(uuid, 'started');
      ownTurn('M');
      life(uuid, 'completed');
      return;
    // 1st: launch bg1. 2nd (ours): queued, the notification, an answer and completed with no `started`; the report turn
    // of its own comes 30 ms after that.
    case 'rp-queued-completed':
      if (idx === 0) return launch(uuid, ['bg1']);
      life(uuid, 'queued');
      notify('bg1');
      ownTurn('M');
      life(uuid, 'completed');
      await sleep(30);
      ownTurn('report');
      return;
    // 1st: launch bg1. Every later message (ours): queued, (2nd only: the notification), an answer and completed with no
    // `started`; the report turn never comes.
    case 'rp-queued-never':
      if (idx === 0) return launch(uuid, ['bg1']);
      life(uuid, 'queued');
      if (idx === 1) notify('bg1');
      ownTurn(idx === 1 ? 'M' : 'N');
      life(uuid, 'completed');
      return;
  }
}

// race-recorded: the fixture split where the 2nd message's `queued` begins.
let raceParts = [[], []];
const raceUuids = [];
if (scenario === 'race-recorded') {
  const lines = fs.readFileSync(process.env.FAKE_FIXTURE, 'utf8').split('\n').filter((l) => l.trim());
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const j = JSON.parse(lines[i]);
    if (j.type !== 'command_lifecycle' || j.state !== 'queued') continue;
    if (!raceUuids.includes(j.command_uuid)) raceUuids.push(j.command_uuid);
    if (raceUuids.length === 2 && cut === lines.length) cut = i;
  }
  raceParts = [lines.slice(0, cut), lines.slice(cut)];
}
const delay = Number(process.env.FAKE_DELAY_MS || 0);

const raceWritten = [];
let n = 0;
let chain = Promise.resolve();
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, line + '\n');
  const uuid = JSON.parse(line).uuid;
  const idx = n++;
  const first = idx === 0;
  chain = chain.then(async () => {
    if (scenario === 'race-recorded' && idx < 2) {
      raceWritten[idx] = uuid;
      for (const l of raceParts[idx]) {
        let m = l;
        raceUuids.forEach((rec, k) => {
          if (raceWritten[k]) m = m.split(rec).join(raceWritten[k]);
        });
        process.stdout.write(m + '\n');
        if (delay) await sleep(delay);
      }
      return;
    }
    if (scenario.startsWith('rp-')) return reportScenario(scenario, uuid, idx);
    if (!first) return normal(uuid, 'next');
    switch (scenario) {
      case 'resume-notice':
        notice();
        life(uuid, 'queued');
        init();
        result('', 0);
        await sleep(20);
        life(uuid, 'started');
        init();
        text('resumed');
        result('resumed');
        life(uuid, 'completed');
        return;
      case 'queued-behind':
        life(uuid, 'queued');
        notice();
        init();
        text('A background agent finished.');
        await sleep(20);
        result('A background agent finished.');
        life(uuid, 'started');
        init();
        text('answer');
        result('answer');
        life(uuid, 'completed');
        return;
      case 'queued-behind-tool':
        life(uuid, 'queued');
        notice();
        init();
        out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-own', name: 'Write', input: { file_path: 'inbox/own.md', content: 'x' } }] }, session_id: sid, parent_tool_use_id: null });
        out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-own', content: 'ok' }] }, session_id: sid, parent_tool_use_id: null });
        text('A background agent wrote a note.');
        await sleep(20);
        result('A background agent wrote a note.');
        life(uuid, 'started');
        init();
        text('answer');
        result('answer');
        life(uuid, 'completed');
        return;
      case 'background-later':
        normal(uuid, 'started');
        await sleep(80);
        notice();
        init();
        text('Max is done.');
        result('Max is done.');
        return;
      case 'completed-after-result':
        life(uuid, 'queued');
        init();
        text('answer');
        result('answer');
        await sleep(20);
        life(uuid, 'completed');
        return;
      case 'queued-never-started':
        life(uuid, 'queued');
        notice();
        init();
        text('Background done.');
        result('Background done.');
        return;
      case 'notice-after-started':
        life(uuid, 'queued');
        life(uuid, 'started');
        init();
        result('', 0);
        await sleep(20);
        text('resumed');
        result('resumed');
        life(uuid, 'completed');
        return;
      case 'no-lifecycle-notice':
        init();
        result('', 0);
        await sleep(20);
        init();
        text('resumed');
        result('resumed');
        return;
      case 'no-lifecycle-local':
        init();
        result('', 0);
        return;
      case 'empty-then-slow':
        life(uuid, 'queued');
        life(uuid, 'started');
        init();
        result('', 0);
        await sleep(slow);
        text('resumed');
        result('resumed');
        life(uuid, 'completed');
        return;
      case 'empty-before-started':
        life(uuid, 'queued');
        init();
        result('', 0);
        life(uuid, 'started');
        init();
        await sleep(slow);
        text('resumed');
        result('resumed');
        life(uuid, 'completed');
        return;
      case 'no-lifecycle-slow':
        init();
        result('', 0);
        out({ type: 'stream_event', event: { type: 'message_start', message: {} }, session_id: sid, parent_tool_use_id: null });
        await sleep(slow);
        text('resumed');
        result('resumed');
        return;
      case 'queued-behind-long':
        life(uuid, 'queued');
        init();
        text('First.');
        result('First.');
        init();
        await sleep(slow);
        text('Second.');
        result('Second.');
        life(uuid, 'started');
        init();
        text('answer');
        result('answer');
        life(uuid, 'completed');
        return;
      case 'exit-while-held':
        life(uuid, 'queued');
        init();
        text('Own turn.');
        result('Own turn.');
        await sleep(20);
        process.exit(3);
        return;
      case 'report-pending-empty':
        life(uuid, 'queued');
        life(uuid, 'started');
        init();
        out({ type: 'system', subtype: 'task_started', task_id: 'bg1', tool_use_id: 'toolu_bg1', description: 'Job', subagent_type: 'max', is_backgrounded: true, task_type: 'local_agent', session_id: sid });
        text('dispatched.');
        result('dispatched.');
        life(uuid, 'completed');
        await sleep(20);
        out({ type: 'system', subtype: 'task_notification', task_id: 'bg1', tool_use_id: 'toolu_bg1', status: 'completed', summary: 'done', session_id: sid });
        await sleep(20);
        init();
        result('', 0);
        return;
      case 'absorbed':
        life(uuid, 'queued');
        life(uuid, 'started');
        init();
        text('one and two');
        life(uuid, 'completed');
        result('one and two', 2);
        return;
    }
  });
});
rl.on('close', () => chain.then(() => process.exit(0)));
