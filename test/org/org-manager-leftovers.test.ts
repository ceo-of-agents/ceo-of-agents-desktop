// Leftovers of an earlier run show in the org's hq health (per org), the Stop button goes through the ledger, shutdown closes it first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent, HealthStatus } from '../../src/shared/types';

vi.mock('../../src/main/system/prereqs', () => ({ checkPrereqs: vi.fn(async () => ({ claude: { state: 'missing', path: null, version: null }, plugin: null })) }));
const green: HealthStatus = { color: 'green', sentence: 'hq OK', hasRemote: true, ahead: 0, behind: 0, lastSyncAt: null, autoPushFailing: false, syncing: false, pushError: null };
vi.mock('../../src/main/git/health', () => ({ checkHealth: vi.fn(async () => green), pullOnOpen: vi.fn(), sync: vi.fn() }));

import { OrgManager } from '../../src/main/org/org-manager';
import { ProcessLedger } from '../../src/main/claude/process-ledger';
import type { Runner } from '../../src/main/system/exec';

const SIG = '--permission-prompt-tool mcp__coa__permission_prompt';
let root: string;
let hq1: string;
let hq2: string;
let file: string;
let events: AppEvent[];

function mkHq(name: string, id: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'org.yaml'), `org:\n  id: ${id}\n`);
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# T\n');
  return dir;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coa-left-')));
  hq1 = mkHq('hq1', 'ONE');
  hq2 = mkHq('hq2', 'TWO');
  file = path.join(root, 'claude-processes.json');
  events = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function setup(alive: Set<number>) {
  const runner: Runner = async (_c, args) => {
    const pids = args[args.length - 1].split(',').map(Number).filter((p) => alive.has(p));
    return { code: 0, error: null, stderr: '', stdout: pids.map((p) => `${p} 05:00 /bin/claude -p ${SIG}\n`).join('') };
  };
  const kill = vi.fn((pid: number, sig: NodeJS.Signals | 0) => {
    if (sig !== 0) alive.delete(Math.abs(pid));
    else if (!alive.has(Math.abs(pid))) throw Object.assign(new Error('x'), { code: 'ESRCH' });
  });
  const ledger = new ProcessLedger({ file, appPid: 9, runner, kill, sleep: async () => undefined });
  const manager = new OrgManager({ dataDir: path.join(root, 'data'), settings: { migrateLegacy: () => undefined } as never, broker: {} as never, serverScript: 's', nodePath: 'node', emit: (e) => events.push(e), ledger });
  return { ledger, manager, kill };
}

describe('leftover processes in the hq health', () => {
  it('shows them for their org only, turns a green indicator yellow, and Stop clears them', async () => {
    const alive = new Set([5001, 5002]);
    const { manager, ledger } = setup(alive);
    const o1 = manager.registry.add(hq1).id;
    const o2 = manager.registry.add(hq2).id;
    const now = Date.now();
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [{ pid: 5001, orgId: o1, hqPath: hq1, appPid: 111, spawnedAt: now - 300_000 }, { pid: 5002, orgId: o2, hqPath: hq2, appPid: 111, spawnedAt: now - 300_000 }] }));
    await manager.init();
    const h1 = await manager.refreshHealth(o1, false);
    const h2 = await manager.refreshHealth(o2, false);
    expect(h1?.leftoverProcesses?.map((p) => p.pid)).toEqual([5001]);
    expect(h2?.leftoverProcesses?.map((p) => p.pid)).toEqual([5002]);
    expect(h1?.color).toBe('yellow');
    expect(h1?.sentence).toMatch(/earlier app run/);

    // Not another org's process, not a process that is not in the ledger.
    expect(await manager.stopLeftoverProcess(o1, 5002)).toBe(false);
    expect(await manager.stopLeftoverProcess(o1, 4242)).toBe(false);
    expect(alive.has(5002)).toBe(true);

    expect(await manager.stopLeftoverProcess(o1, 5001)).toBe(true);
    expect(alive.has(5001)).toBe(false);
    const after = events.filter((e): e is Extract<AppEvent, { type: 'health' }> => e.type === 'health' && e.orgId === o1).pop();
    expect(after?.status.leftoverProcesses).toBeUndefined();
    expect(after?.status.color).toBe('green');
    expect((await manager.refreshHealth(o2, false))?.leftoverProcesses).toHaveLength(1);
    expect(ledger.hasForeign()).toBe(true); // o2's is still there
    await manager.shutdown();
  });

  it('a stale line (the process is gone) shows nothing and leaves the ledger clean', async () => {
    const { manager, ledger } = setup(new Set());
    const o1 = manager.registry.add(hq1).id;
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [{ pid: 5101, orgId: o1, hqPath: hq1, appPid: 111, spawnedAt: Date.now() - 300_000 }] }));
    await manager.init();
    const h = await manager.refreshHealth(o1, false);
    expect(h?.leftoverProcesses).toBeUndefined();
    expect(h?.color).toBe('green');
    expect(ledger.hasForeign()).toBe(false);
    await manager.shutdown();
  });
});

describe('OrgManager.shutdown', () => {
  it('closes the ledger first, so no chat can start a new process, and kills what is left at the end', async () => {
    const { manager, ledger, kill } = setup(new Set());
    const order: string[] = [];
    vi.spyOn(ledger, 'close').mockImplementation(() => void order.push('close'));
    vi.spyOn(ledger, 'killAllSync').mockImplementation((sig) => void order.push(`kill ${sig}`));
    await manager.shutdown();
    expect(order).toEqual(['close', 'kill SIGKILL']);
    expect(kill).not.toHaveBeenCalled();
  });
});
