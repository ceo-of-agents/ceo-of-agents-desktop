// A fake `claude -p` that replays one live capture (test/fixtures/claude/midturn-*.jsonl, Claude Code 2.1.328) of
// messages written while a turn runs. Env: FAKE_FIXTURE (the .jsonl; its .writes.json sidecar says after which line each
// message was written). A line is printed only once the messages written before it have arrived on stdin, and the
// captured command uuids ("uuid-A", "uuid-B", ...) are replaced by the uuids the session wrote, in order.
import fs from 'node:fs';
import readline from 'node:readline';

const file = process.env.FAKE_FIXTURE;
const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
const writes = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.writes.json'), 'utf8'));
const received = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => received.push(JSON.parse(line).uuid));

async function run() {
  while (received.length === 0) await sleep(5);
  for (let i = 0; i < lines.length; i++) {
    const needed = writes.filter((w) => w.afterLine < i).length;
    while (received.length < needed) await sleep(5);
    let out = lines[i];
    writes.forEach((w, k) => {
      out = out.split(`uuid-${w.label}`).join(received[k] ?? `uuid-${w.label}`);
    });
    process.stdout.write(out + '\n');
    await sleep(2);
  }
  // FAKE_KEEP_OPEN=1: stay up after the last line (a process that goes on running), until stdin closes.
  if (process.env.FAKE_KEEP_OPEN !== '1') rl.close();
}
void run();
rl.on('close', () => setTimeout(() => process.exit(0), 50));
