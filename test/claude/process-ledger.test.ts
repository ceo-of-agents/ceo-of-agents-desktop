// The ledger of the `claude -p` processes the app started (stop them all at the end, find an earlier run's leftovers).
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeSession, type TurnEnd } from '../../src/main/claude/session';
import { installSignalHandlers, parseEtime, parsePs, ProcessLedger, trackedSpawner, type LedgerEntry } from '../../src/main/claude/process-ledger';
import { run, type RunResult, type Runner, type Spawner } from '../../src/main/system/exec';
import { FAKE_ORG, waitFor } from '../org/helpers';

vi.setConfig({ testTimeout: 30_000 });

const SIG = '--permission-prompt-tool mcp__coa__permission_prompt';
const NOW = 1_800_000_000_000;

let dir: string;
let file: string;
const spawned: number[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-ledger-'));
  file = path.join(dir, 'claude-processes.json');
});
afterEach(() => {
  // Only pids this test file spawned itself.
  for (const pid of spawned.splice(0)) {
    if (!Number.isInteger(pid) || pid <= 1) continue; // never a group of ours or of everyone
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A child that only looks like one: a pid and the events the ledger listens to. */
function fakeChild(pid: number): ChildProcess {
  const c = new EventEmitter() as unknown as ChildProcess;
  Object.assign(c, { pid, exitCode: null, signalCode: null });
  return c;
}

const entries = (): LedgerEntry[] => (fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as { entries: LedgerEntry[] }).entries : []);
const writeEntries = (list: LedgerEntry[]) => fs.writeFileSync(file, JSON.stringify({ version: 1, entries: list }));
const entry = (pid: number, over: Partial<LedgerEntry> = {}): LedgerEntry => ({ pid, orgId: 'o1', hqPath: '/hq/one', appPid: 111, spawnedAt: NOW - 300_000, ...over });
const ps = (...rows: Array<[number, string, string]>): RunResult => ({ code: 0, stdout: rows.map(([pid, etime, cmd]) => `${String(pid).padStart(6)} ${etime.padStart(11)} ${cmd}`).join('\n') + '\n', stderr: '', error: null });
const CLAUDE = `/opt/bin/claude -p --input-format stream-json ${SIG} --mcp-config {"mcpServers":{"coa":{"env":{"TOKEN":"secret-token"}}}} --setting-sources project,local`;
const orgs = [{ id: 'o1', path: '/hq/one' }, { id: 'o2', path: '/hq/two' }];

function ledgerWith(runner: Runner, over: Partial<ConstructorParameters<typeof ProcessLedger>[0]> = {}) {
  // By default no other app instance is running (the pids in the entries are made up and may exist on this machine).
  return new ProcessLedger({ file, appPid: 222, runner, now: () => NOW, appAlive: () => false, ...over });
}

describe('ps parsing', () => {
  it('reads etime in all three forms', () => {
    expect(parseEtime('05:03')).toBe(303_000);
    expect(parseEtime('2:05:03')).toBe(7_503_000);
    expect(parseEtime('3-02:05:03')).toBe(((3 * 24 + 2) * 3600 + 5 * 60 + 3) * 1000);
    expect(parseEtime('nope')).toBeNull();
  });
  it('tests the command line for the signature and keeps nothing else of it', () => {
    const rows = parsePs(ps([10, '05:00', CLAUDE], [11, '05:00', '/opt/bin/claude -p --model x'], [12, '05:00', `/bin/node server.js ${SIG}`], [13, '05:00', `/opt/bin/claude ${SIG}`]).stdout);
    expect(rows.get(10)?.ours).toBe(true);
    expect(rows.get(11)?.ours).toBe(false); // no permission prompt tool
    expect(rows.get(12)?.ours).toBe(false); // not claude
    expect(rows.get(13)?.ours).toBe(false); // not print mode
    expect(JSON.stringify([...rows.values()])).not.toContain('secret-token');
  });
});

describe('ProcessLedger', () => {
  it('records a child when it starts and drops the record when it exits; the file holds no arguments or environment', () => {
    const ledger = ledgerWith(vi.fn());
    const child = fakeChild(4001);
    ledger.track(child, { orgId: 'o1', hqPath: '/hq/one' });
    expect(entries()).toEqual([{ pid: 4001, orgId: 'o1', hqPath: '/hq/one', appPid: 222, spawnedAt: NOW }]);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toContain('permission');
    expect(text).not.toContain('mcp');
    expect(Object.keys(entries()[0]).sort()).toEqual(['appPid', 'hqPath', 'orgId', 'pid', 'spawnedAt']);
    child.emit('exit', 0, null);
    expect(entries()).toEqual([]);
    expect(ledger.liveCount).toBe(0);
  });

  it('a closed ledger refuses to start a process', () => {
    const ledger = ledgerWith(vi.fn());
    const base = vi.fn(() => fakeChild(4002)) as unknown as Spawner;
    const spawner = trackedSpawner(ledger, base, { orgId: 'o1', hqPath: '/hq/one' });
    spawner('claude', [], {});
    expect(base).toHaveBeenCalledTimes(1);
    ledger.close();
    expect(() => spawner('claude', [], {})).toThrow(/closing/);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it('killAllSync signals the group of the children of this run that are still alive, and only those', () => {
    const kill = vi.fn();
    const ledger = ledgerWith(vi.fn(), { kill });
    const a = fakeChild(4010);
    const b = fakeChild(4011);
    ledger.track(a, { orgId: 'o1', hqPath: '/hq/one' });
    ledger.track(b, { orgId: 'o1', hqPath: '/hq/one' });
    writeEntries([...entries(), entry(4012)]); // an earlier run's line: never signalled by killAllSync
    a.emit('exit', 0, null);
    ledger.killAllSync('SIGKILL');
    expect(kill.mock.calls).toEqual([[-4011, 'SIGKILL']]);
  });

  it('killAllSync falls back to the pid when there is no group, and never throws', () => {
    const kill = vi.fn((pid: number) => {
      if (pid < 0) throw Object.assign(new Error('x'), { code: 'ESRCH' });
      throw Object.assign(new Error('y'), { code: 'ESRCH' });
    });
    const ledger = ledgerWith(vi.fn(), { kill });
    ledger.track(fakeChild(4020), { orgId: 'o1', hqPath: '/hq/one' });
    expect(() => ledger.killAllSync('SIGTERM')).not.toThrow();
    expect(kill.mock.calls.map((c) => c[0])).toEqual([-4020, 4020]);
  });
});

describe('findLeftovers', () => {
  it('splits the leftovers per org and ignores entries of this run', async () => {
    const runner = vi.fn(async () => ps([4101, '05:00', CLAUDE], [4102, '05:01', CLAUDE], [4103, '05:00', CLAUDE]));
    const ledger = ledgerWith(runner);
    ledger.track(fakeChild(4103), { orgId: 'o1', hqPath: '/hq/one' }); // this run's own child
    writeEntries([...entries(), entry(4101), entry(4102, { orgId: 'o2', hqPath: '/hq/two' })]);
    const found = await ledger.findLeftovers(orgs);
    expect(found.get('o1')).toEqual([{ pid: 4101, startedAt: NOW - 300_000 }]);
    expect(found.get('o2')).toEqual([{ pid: 4102, startedAt: NOW - 301_000 }]);
    // ps is asked only about the earlier run's pids, with no shell in between.
    expect(runner).toHaveBeenCalledWith('ps', ['-ww', '-o', 'pid=,etime=,command=', '-p', '4101,4102'], expect.anything());
  });

  it('rejects and prunes a reused pid (start time far from the recorded one)', async () => {
    const ledger = ledgerWith(async () => ps([4201, '00:20', CLAUDE]));
    writeEntries([entry(4201)]);
    expect((await ledger.findLeftovers(orgs)).size).toBe(0);
    expect(entries()).toEqual([]);
  });

  it('rejects and prunes a command line without the signature, and a pid that is gone', async () => {
    const ledger = ledgerWith(async () => ps([4301, '05:00', '/opt/bin/claude -p --model sonnet'], [4302, '05:00', '/usr/bin/vim notes.txt']));
    writeEntries([entry(4301), entry(4302), entry(4303)]);
    expect((await ledger.findLeftovers(orgs)).size).toBe(0);
    expect(entries()).toEqual([]);
  });

  it('keeps the line of an org that is not registered (or moved) but does not report it', async () => {
    const ledger = ledgerWith(async () => ps([4401, '05:00', CLAUDE], [4402, '05:00', CLAUDE]));
    writeEntries([entry(4401, { orgId: 'gone' }), entry(4402, { hqPath: '/hq/elsewhere' })]);
    expect((await ledger.findLeftovers(orgs)).size).toBe(0);
    expect(entries().map((e) => e.pid)).toEqual([4401, 4402]);
  });

  it('reports and prunes nothing when ps cannot run', async () => {
    const ledger = ledgerWith(async () => ({ code: null, stdout: '', stderr: '', error: 'spawn ps ENOENT' }));
    writeEntries([entry(4501)]);
    expect((await ledger.findLeftovers(orgs)).size).toBe(0);
    expect(entries()).toHaveLength(1);
  });

  it('skips an entry owned by another app pid that is still running (a second instance): not a leftover, not pruned, no ps', async () => {
    const runner = vi.fn(async () => ps([4701, '05:00', CLAUDE]));
    const appAlive = vi.fn((pid: number) => pid === 111);
    const ledger = ledgerWith(runner, { appAlive });
    writeEntries([entry(4701, { appPid: 111 })]);
    expect(ledger.hasForeign()).toBe(false);
    expect((await ledger.findLeftovers(orgs)).size).toBe(0);
    expect(runner).not.toHaveBeenCalled();
    expect(entries().map((e) => e.pid)).toEqual([4701]);
    expect(appAlive).toHaveBeenCalledWith(111);
  });

  it('an entry owned by a dead app pid is still a leftover, next to a live other instance\'s entry that is skipped', async () => {
    const runner = vi.fn(async () => ps([4801, '05:00', CLAUDE]));
    const ledger = ledgerWith(runner, { appAlive: (pid) => pid === 333 });
    writeEntries([entry(4801, { appPid: 111 }), entry(4802, { appPid: 333 })]);
    expect(ledger.hasForeign()).toBe(true);
    expect((await ledger.findLeftovers(orgs)).get('o1')).toEqual([{ pid: 4801, startedAt: NOW - 300_000 }]);
    expect(runner).toHaveBeenCalledWith('ps', ['-ww', '-o', 'pid=,etime=,command=', '-p', '4801'], expect.anything());
    expect(entries().map((e) => e.pid)).toEqual([4801, 4802]);
  });

  it('the default app check treats a running pid as alive and a gone one as dead', async () => {
    const runner = vi.fn(async () => ps());
    const base = { file, appPid: 222, runner, now: () => NOW };
    writeEntries([entry(4901, { appPid: process.pid })]);
    expect(new ProcessLedger(base).hasForeign()).toBe(false); // this very test process is a live other "app"
    const gone = spawn(process.execPath, ['-e', '0']);
    await new Promise((r) => gone.once('exit', r));
    writeEntries([entry(4901, { appPid: gone.pid as number })]);
    expect(new ProcessLedger(base).hasForeign()).toBe(true);
  });

  it('does not run ps when the file has no line of an earlier run', async () => {
    const runner = vi.fn();
    const ledger = ledgerWith(runner);
    expect(ledger.hasForeign()).toBe(false);
    ledger.track(fakeChild(4601), { orgId: 'o1', hqPath: '/hq/one' });
    expect(ledger.hasForeign()).toBe(false);
    await ledger.findLeftovers(orgs);
    expect(runner).not.toHaveBeenCalled();
  });
});

describe('stopLeftover', () => {
  /** A simulated process table: `kill` ends a pid on the signals in `diesOn`; time advances with sleep. */
  function table(diesOn: string[]) {
    let now = NOW;
    const up = new Set([4701]);
    const calls: Array<[number, string | number]> = [];
    const kill = (pid: number, sig: NodeJS.Signals | 0) => {
      calls.push([pid, sig]);
      const p = Math.abs(pid);
      if (!up.has(p)) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      if (sig !== 0 && diesOn.includes(sig)) up.delete(p);
    };
    const ledger = ledgerWith(async () => ps(...[...up].map((p) => [p, '05:00', CLAUDE] as [number, string, string])), {
      kill,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    return { ledger, calls, up, advance: (ms: number) => (now += ms) };
  }

  it('SIGTERM to the group, then the record goes', async () => {
    const { ledger, calls, up } = table(['SIGTERM', 'SIGKILL']);
    writeEntries([entry(4701, { spawnedAt: NOW - 300_000 })]);
    expect(await ledger.stopLeftover('o1', 4701, orgs)).toBe(true);
    expect(calls.filter((c) => c[1] === 'SIGTERM')).toEqual([[-4701, 'SIGTERM']]);
    expect(calls.some((c) => c[1] === 'SIGKILL')).toBe(false);
    expect(up.size).toBe(0);
    expect(entries()).toEqual([]);
  });

  it('SIGKILL after the grace time when the process ignores SIGTERM', async () => {
    const { ledger, calls } = table(['SIGKILL']);
    writeEntries([entry(4701)]);
    expect(await ledger.stopLeftover('o1', 4701, orgs)).toBe(true);
    expect(calls.filter((c) => c[1] === 'SIGTERM' || c[1] === 'SIGKILL')).toEqual([[-4701, 'SIGTERM'], [-4701, 'SIGKILL']]);
    expect(entries()).toEqual([]);
  });

  it('refuses a pid that is not a leftover of that org, and signals nothing', async () => {
    const { ledger, calls } = table(['SIGTERM', 'SIGKILL']);
    writeEntries([entry(4701)]);
    expect(await ledger.stopLeftover('o2', 4701, orgs)).toBe(false); // another org
    expect(await ledger.stopLeftover('o1', 4999, orgs)).toBe(false); // not in the ledger
    expect(await ledger.stopLeftover('o1', 1, orgs)).toBe(false);
    expect(await ledger.stopLeftover('o1', -4701, orgs)).toBe(false);
    expect(calls).toEqual([]);
    expect(entries()).toHaveLength(1);
  });
});

describe('a crash leaves a child that the next run finds and stops', () => {
  it('real child: found as a leftover of its org by another run over the same file, then stopped', async () => {
    const hq = path.join(dir, 'hq');
    fs.mkdirSync(hq);
    // Run A starts a fake claude through the tracked spawner and "crashes": nothing stops the child.
    const ledgerA = new ProcessLedger({ file, appPid: 111 });
    const spawner = trackedSpawner(ledgerA, (_cmd, args, opts) => spawn(process.execPath, [FAKE_ORG, ...args], opts), { orgId: 'o1', hqPath: hq });
    const child = spawner('claude', ['-p', '--permission-prompt-tool', 'mcp__coa__permission_prompt'], { cwd: hq, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const pid = child.pid!;
    spawned.push(pid);
    expect(entries().map((e) => e.pid)).toEqual([pid]);
    expect(alive(pid)).toBe(true);

    // Run B (another app pid, the real ps) finds it for org o1 only.
    const ledgerB = new ProcessLedger({ file, appPid: 222, termGraceMs: 2000 });
    const other = path.join(dir, 'other');
    const found = await ledgerB.findLeftovers([{ id: 'o1', path: hq }, { id: 'o2', path: other }]);
    expect(found.get('o1')?.map((l) => l.pid)).toEqual([pid]);
    expect(found.has('o2')).toBe(false);
    expect(Math.abs(found.get('o1')![0].startedAt - Date.now())).toBeLessThan(15_000);

    expect(await ledgerB.stopLeftover('o1', pid, [{ id: 'o1', path: hq }])).toBe(true);
    await waitFor(() => !alive(pid));
    expect(entries()).toEqual([]);
    expect(ledgerB.hasForeign()).toBe(false);
  });

  it('a pid that is not ours is never stopped: a real process the ledger did not start is not listed', async () => {
    // A process with the signature but no ledger line: nothing to find, nothing to stop.
    const stray = spawn(process.execPath, [FAKE_ORG, '-p', '--permission-prompt-tool', 'mcp__coa__permission_prompt'], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    spawned.push(stray.pid!);
    const ledger = new ProcessLedger({ file, appPid: 222 });
    expect((await ledger.findLeftovers([{ id: 'o1', path: dir }])).size).toBe(0);
    expect(await ledger.stopLeftover('o1', stray.pid!, [{ id: 'o1', path: dir }])).toBe(false);
    expect(alive(stray.pid!)).toBe(true);
  });
});

describe('quit and signals leave no child', () => {
  it('after close(), stop and killAllSync no tracked child is alive and a new turn cannot start one', async () => {
    const ledger = new ProcessLedger({ file });
    const spawner = trackedSpawner(ledger, (_c, args, opts) => spawn(process.execPath, [FAKE_ORG, ...args], opts), { orgId: 'o1', hqPath: dir });
    const s = new ClaudeSession({ claudePath: 'claude', cwd: dir, args: ['-p', '--permission-prompt-tool', 'mcp__coa__permission_prompt'], spawner });
    const ends: TurnEnd[] = [];
    s.on('turn-end', (e: TurnEnd) => ends.push(e));
    s.send('hello');
    await waitFor(() => ends.length === 1);
    expect(entries()).toHaveLength(1);
    const pid = entries()[0].pid;
    spawned.push(pid);
    expect(alive(pid)).toBe(true);

    ledger.close(); // OrgManager.shutdown: first, so nothing new starts
    await s.stop();
    ledger.killAllSync('SIGKILL'); // then whatever is left
    expect(alive(pid)).toBe(false);
    expect(ledger.liveCount).toBe(0);
    expect(entries()).toEqual([]);

    s.send('too late'); // a pump that was mid-start when the quit began
    await waitFor(() => ends.length === 2);
    expect(ends[1].isError).toBe(true);
    expect(ledger.liveCount).toBe(0);
    expect(entries()).toEqual([]);
  });

  it('killAllSync ends a child that ignores the polite stop', async () => {
    const ledger = new ProcessLedger({ file });
    const child = trackedSpawner(ledger, (_c, args, opts) => spawn(process.execPath, [FAKE_ORG, ...args], opts), { orgId: 'o1', hqPath: dir })('claude', ['-p'], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    spawned.push(child.pid!);
    ledger.killAllSync('SIGKILL');
    await waitFor(() => !alive(child.pid!));
    await waitFor(() => entries().length === 0);
  });

  it('SIGTERM, SIGINT and SIGHUP close the ledger, stop the children and exit', () => {
    const kill = vi.fn();
    const ledger = new ProcessLedger({ file, kill });
    ledger.track(fakeChild(4801), { orgId: 'o1', hqPath: '/hq/one' });
    const proc = new EventEmitter();
    const exit = vi.fn();
    installSignalHandlers(ledger, exit, proc as unknown as NodeJS.Process);
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
      kill.mockClear();
      exit.mockClear();
      proc.emit(sig);
      expect(ledger.closed).toBe(true);
      expect(kill).toHaveBeenCalledWith(-4801, 'SIGTERM');
      expect(exit).toHaveBeenCalledWith(0);
    }
  });
});

describe('the real ps', () => {
  it('the runner and ps agree on a live fake child (etime parse on this machine)', async () => {
    const child = spawn(process.execPath, [FAKE_ORG, '-p', '--permission-prompt-tool', 'mcp__coa__permission_prompt'], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    spawned.push(child.pid!);
    const res = await run('ps', ['-ww', '-o', 'pid=,etime=,command=', '-p', String(child.pid)]);
    const row = parsePs(res.stdout).get(child.pid!);
    expect(row?.ours).toBe(true);
    expect(row!.elapsedMs).toBeLessThan(10_000);
  });
});
