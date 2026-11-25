import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeSession } from '../../src/main/claude/session';
import { Thread } from '../../src/main/org/thread';
import type { RateLimitInfo } from '../../src/shared/usage';
import { waitFor } from './helpers';

const FIX = path.join(__dirname, '..', 'fixtures', 'claude');
const FAKE = path.join(FIX, 'fake-claude.mjs');

let dir: string;
let th: Thread | null = null;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-limit-'));
});
afterEach(async () => {
  await th?.stop();
  th = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

function setup(fixture: string) {
  const usage: RateLimitInfo[] = [];
  th = new Thread({
    orgId: 'o1',
    threadId: 'cos',
    title: 'T',
    speaker: 'Ada',
    logFile: path.join(dir, 'log.jsonl'),
    makeSession: () =>
      new ClaudeSession({ claudePath: 'claude', cwd: dir, args: ['-p'], spawner: (_c, _a, opts) => spawn(process.execPath, [FAKE], { ...opts, env: { ...process.env, FAKE_FIXTURE: path.join(FIX, fixture) } }) }),
    sessions: { get: () => null, set: () => undefined, clear: () => undefined },
    emit: () => undefined,
    now: () => new Date(2026, 10, 18, 10, 0),
    onRateLimit: (i) => usage.push(i),
  });
  return { th, usage };
}

describe('Thread usage limit', () => {
  it('a run stopped by a usage limit says which limit and when it resets, not a generic error', async () => {
    const { th, usage } = setup('rate-limit-rejected.jsonl');
    th.enqueue('hi', 'user', { kind: 'user', author: 'You', text: 'hi' });
    await waitFor(() => !th.busy);
    const err = th.info().entries.filter((e) => e.kind === 'error').map((e) => e.text);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^Usage limit reached \(5-hour window\): this run stopped\. It resets at /);
    expect(usage.map((u) => u.status)).toEqual(['rejected']);
  });

  it('passes plan usage on after a normal turn', async () => {
    const { th, usage } = setup('rate-limit-allowed.jsonl');
    th.enqueue('hi', 'user', { kind: 'user', author: 'You', text: 'hi' });
    await waitFor(() => !th.busy);
    expect(th.info().entries.some((e) => e.kind === 'error')).toBe(false);
    expect(usage[0].windows.map((w) => w.key)).toEqual(['five_hour', 'seven_day']);
  });
});
