// A fake `claude -p --input-format stream-json` for tests: replays one recorded turn per stdin user message.
// Env: FAKE_FIXTURE (jsonl path), FAKE_DELAY_MS (between lines), FAKE_EXIT_MID_TURN=1 (exit after the first
// half of a turn, no result), FAKE_NOISE=1 (print a non-JSON line first), FAKE_LOG (file: append each stdin line).
// Turns that Claude Code starts on its own, with lifecycle events: see fake-claude-lifecycle.mjs.
import fs from 'node:fs';
import readline from 'node:readline';

const lines = fs.readFileSync(process.env.FAKE_FIXTURE, 'utf8').split('\n').filter((l) => l.trim());
const turns = [];
let cur = [];
for (const l of lines) {
  cur.push(l);
  if (JSON.parse(l).type === 'result') {
    turns.push(cur);
    cur = [];
  }
}
const delay = Number(process.env.FAKE_DELAY_MS || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
let chain = Promise.resolve();

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, line + '\n');
  chain = chain.then(async () => {
    const turn = turns[Math.min(n, turns.length - 1)];
    n++;
    if (process.env.FAKE_NOISE === '1') process.stdout.write('Warning: something harmless\n');
    const crash = process.env.FAKE_EXIT_MID_TURN === '1';
    const upto = crash ? Math.ceil(turn.length / 2) : turn.length;
    for (let i = 0; i < upto; i++) {
      process.stdout.write(turn[i] + '\n');
      if (delay) await sleep(delay);
    }
    if (crash) process.exit(3);
  });
});
rl.on('close', () => chain.then(() => process.exit(0)));
