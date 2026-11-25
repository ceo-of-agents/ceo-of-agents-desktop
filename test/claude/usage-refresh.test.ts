import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readUsageCommand, UsageRefresher, USAGE_ARGS, USAGE_STALE_MS, type UsageRefreshDeps } from '../../src/main/claude/usage-refresh';
import type { RunResult, Runner } from '../../src/main/system/exec';
import type { PlanUsage, RateLimitInfo } from '../../src/shared/usage';

const fixture = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'claude', 'usage-command.json'), 'utf8');
const now = new Date('2026-11-18T19:00:00Z');

function setup(over: Partial<UsageRefreshDeps> & { stdout?: string; result?: Partial<RunResult> } = {}) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const updates: RateLimitInfo[] = [];
  const runner: Runner = (cmd, args) => {
    calls.push({ cmd, args });
    return Promise.resolve({ code: 0, stdout: over.stdout ?? fixture, stderr: '', error: null, ...over.result });
  };
  const r = new UsageRefresher({
    claudePath: () => '/bin/claude',
    claudeVersion: () => '2.1.327',
    last: () => null,
    update: (i) => updates.push(i),
    busy: () => false,
    runner,
    now: () => now,
    ...over,
  });
  return { r, calls, updates };
}

describe('readUsageCommand', () => {
  it('reads the window lines of a recorded /usage result and nothing else', () => {
    const info = readUsageCommand(fixture, now);
    expect(info).not.toBe('model-call');
    if (!info || info === 'model-call') throw new Error('no info');
    expect(info.windows.map((w) => [w.key, w.utilization, w.resetsAt])).toEqual([
      ['five_hour', 0.27, '2026-11-18T23:00:00.000Z'],
      ['seven_day', 0.9, '2026-11-19T05:00:00.000Z'],
      ['seven_day_fable', 0.23, '2026-11-19T05:00:00.000Z'],
    ]);
    expect(JSON.stringify(info)).not.toMatch(/example|requests|sessions/);
  });
  it('treats a result that called the model as a model call', () => {
    const o = JSON.parse(fixture) as Record<string, unknown>;
    expect(readUsageCommand(JSON.stringify({ ...o, num_turns: 1 }), now)).toBe('model-call');
    expect(readUsageCommand(JSON.stringify({ ...o, local_command: undefined }), now)).toBe('model-call');
    expect(readUsageCommand(JSON.stringify({ ...o, duration_api_ms: 812 }), now)).toBe('model-call');
    expect(readUsageCommand(JSON.stringify({ ...o, modelUsage: { haiku: {} } }), now)).toBe('model-call');
  });
  it('null for anything else', () => {
    expect(readUsageCommand('', now)).toBeNull();
    expect(readUsageCommand('not json', now)).toBeNull();
    const o = JSON.parse(fixture) as Record<string, unknown>;
    expect(readUsageCommand(JSON.stringify({ ...o, result: 'No usage data' }), now)).toBeNull();
    expect(readUsageCommand(JSON.stringify({ ...o, is_error: true }), now)).toBeNull();
  });
});

describe('UsageRefresher', () => {
  it('runs the local command with no settings, servers, tools or session file', async () => {
    const { r, calls, updates } = setup();
    expect(await r.refresh()).toBe('ok');
    expect(calls).toEqual([{ cmd: '/bin/claude', args: USAGE_ARGS }]);
    expect(USAGE_ARGS.slice(0, 2)).toEqual(['-p', '/usage']);
    expect(USAGE_ARGS).toContain('--no-session-persistence');
    expect(updates).toHaveLength(1);
  });
  it('does nothing when Claude Code is not ready or older than the checked version', async () => {
    expect(await setup({ claudePath: () => null }).r.refresh()).toBe('unavailable');
    const old = setup({ claudeVersion: () => '2.1.326' });
    expect(await old.r.refresh()).toBe('unavailable');
    expect(old.calls).toHaveLength(0);
  });
  it('the timer skips while a chat runs or the reading is recent', async () => {
    expect(await setup({ busy: () => true }).r.tick()).toBe('skipped');
    const fresh: PlanUsage = { status: 'allowed', limitType: null, resetsAt: null, windows: [], at: new Date(now.getTime() - USAGE_STALE_MS + 1000).toISOString() };
    const s = setup({ last: () => fresh });
    expect(await s.r.tick()).toBe('skipped');
    expect(s.calls).toHaveLength(0);
    const old = setup({ last: () => ({ ...fresh, at: new Date(now.getTime() - USAGE_STALE_MS - 1000).toISOString() }) });
    expect(await old.r.tick()).toBe('ok');
  });
  it('turns itself off for the app run after a result that called the model', async () => {
    const o = JSON.parse(fixture) as Record<string, unknown>;
    const s = setup({ stdout: JSON.stringify({ ...o, num_turns: 1 }) });
    expect(await s.r.refresh()).toBe('off');
    expect(await s.r.refresh()).toBe('off');
    expect(s.calls).toHaveLength(1);
    expect(s.updates).toHaveLength(0);
  });
  it('a failed run changes nothing', async () => {
    const s = setup({ result: { code: 1, error: null } });
    expect(await s.r.refresh()).toBe('failed');
    expect(s.updates).toHaveLength(0);
  });
  it('one run at a time', async () => {
    const s = setup();
    const [a, b] = await Promise.all([s.r.refresh(), s.r.refresh()]);
    expect([a, b]).toEqual(['ok', 'ok']);
    expect(s.calls).toHaveLength(1);
  });
});
