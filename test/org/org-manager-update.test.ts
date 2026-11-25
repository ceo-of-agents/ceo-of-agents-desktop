import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent, PluginActionState, PluginStatus, PrereqStatus } from '../../src/shared/types';
import type { TurnResult } from '../../src/main/org/thread';

const mocks = vi.hoisted(() => ({ checkPrereqs: vi.fn(), updatePlugin: vi.fn() }));
vi.mock('../../src/main/system/prereqs', () => ({ checkPrereqs: mocks.checkPrereqs }));
vi.mock('../../src/main/system/plugin', async (orig) => ({ ...(await orig<typeof import('../../src/main/system/plugin')>()), updatePlugin: mocks.updatePlugin, fetchLatestRelease: vi.fn() }));

import { OrgManager } from '../../src/main/org/org-manager';

const plugin = (over: Partial<PluginStatus> = {}): PluginStatus => ({
  state: 'ok', installed: '1.2.0', latest: '1.3.0', updateAvailable: true, hqFrameworkVersion: '1.1.0', orgUpdateAvailable: false, belowMinimum: false, minimum: '1.0.0', latestCheckFailed: false, dev: false, ...over,
});
const prereq = (p: PluginStatus | null): PrereqStatus => ({ claude: { found: true, path: 'claude', version: '2.0.0', supported: true, range: '>=2' }, signedIn: true, git: { found: true }, plugin: p }) as unknown as PrereqStatus;

/** A stand-in for the CoS Thread: records tagged messages and lets the test end turns. */
class FakeCos {
  speaker = 'Ada';
  listeners: Array<(r: TurnResult) => void> = [];
  tags: Array<string | undefined> = [];
  onTurnEnd(fn: (r: TurnResult) => void) { this.listeners.push(fn); }
  offTurnEnd(fn: (r: TurnResult) => void) { this.listeners = this.listeners.filter((l) => l !== fn); }
  hasTag(tag: string) { return this.tags.includes(tag); }
  /** One turn end answering one message per tag (several when Claude Code absorbed them into one turn). */
  end(...tags: Array<string | undefined>) {
    this.tags = this.tags.filter((t) => !tags.includes(t));
    for (const l of [...this.listeners]) l({ text: '', isError: false, resultText: '', tools: [], subTools: [], sent: tags.map((tag) => ({ text: 'x', kind: 'user' as const, tag })) });
  }
}

let root: string;
let hqDir: string;
let events: AppEvent[];
let cos: FakeCos;
let sends: Array<{ text: string; tag?: string }>;
let restarts: number;
let setCalls: unknown[];
let stateEmits: number;
let manager: OrgManager;
let orgId: string;
let statuses: Array<PluginStatus | null>;

const actions = (): PluginActionState[] => events.filter((e): e is Extract<AppEvent, { type: 'plugin-action' }> => e.type === 'plugin-action').map((e) => e.state);
const finals = () => actions().filter((a) => !a.running);

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-upd-'));
  hqDir = path.join(root, 'hq');
  fs.mkdirSync(hqDir);
  events = [];
  cos = new FakeCos();
  sends = [];
  restarts = 0;
  setCalls = [];
  stateEmits = 0;
  statuses = [];
  let i = 0;
  mocks.checkPrereqs.mockReset().mockImplementation(async () => prereq(statuses[Math.min(i++, statuses.length - 1)] ?? null));
  mocks.updatePlugin.mockReset().mockResolvedValue({ ok: true, error: null });
  manager = new OrgManager({ dataDir: path.join(root, 'data'), settings: { set: (_o: string, _h: string, p: unknown) => { setCalls.push(p); return { ...(p as object) } as never; } } as never, broker: {} as never, serverScript: 's', nodePath: 'node', emit: (e) => events.push(e), cosPollMs: 20, updateRecheckMs: 5 });
  orgId = manager.registry.add(hqDir).id;
  const fakeSession = {
    cos,
    send: (_id: string, text: string, tag?: string) => {
      sends.push({ text, tag });
      cos.tags.push(tag);
    },
    emitThreadStates: () => {
      stateEmits++;
    },
    restartSessions: async () => {
      restarts++;
    },
  };
  vi.spyOn(manager, 'session').mockReturnValue(fakeSession as never);
  (manager as unknown as { runtime(id: string): { session: unknown } }).runtime(orgId).session = fakeSession;
  statuses = [plugin()];
  await manager.refreshPrereqs(null); // finds claude
  events = [];
  i = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

describe('OrgManager.updateOrg', () => {
  it('two concurrent calls run the plugin update once, and a call during the CoS wait is a no-op', async () => {
    statuses = [plugin(), plugin({ installed: '1.3.0', updateAvailable: false, orgUpdateAvailable: true }), plugin({ installed: '1.3.0', updateAvailable: false, hqFrameworkVersion: '1.3.0' })];
    const a = manager.updateOrg(orgId);
    const b = manager.updateOrg(orgId);
    await tick();
    expect(sends).toHaveLength(1);
    await manager.updateOrg(orgId); // held during the wait for the CoS
    cos.end(sends[0].tag);
    await Promise.all([a, b]);
    expect(mocks.updatePlugin).toHaveBeenCalledTimes(1);
    expect(restarts).toBe(1);
    expect(finals()).toEqual([{ running: false, action: 'update', error: null, step: null, done: true }]);
    expect(cos.listeners).toHaveLength(0);
    // the guard is released: a new run goes ahead
    statuses = [plugin({ updateAvailable: false })];
    await manager.updateOrg(orgId);
    expect(finals()).toHaveLength(2);
  });

  it('plugin update failure: one final emit with an error', async () => {
    mocks.updatePlugin.mockResolvedValue({ ok: false, error: 'boom' });
    statuses = [plugin()];
    await manager.updateOrg(orgId);
    expect(finals()).toEqual([{ running: false, action: 'update', error: 'The plugin update failed: boom. The hq update was not started.', step: null }]);
    expect(restarts).toBe(0);
  });

  it('a throw from the plugin update still emits running false with an error, and releases the guard', async () => {
    mocks.updatePlugin.mockRejectedValue(new Error('spawn failed'));
    statuses = [plugin()];
    await manager.updateOrg(orgId);
    expect(finals()).toEqual([{ running: false, action: 'update', error: 'The update stopped: spawn failed.', step: null }]);
    mocks.updatePlugin.mockResolvedValue({ ok: true, error: null });
    statuses = [plugin({ updateAvailable: false })];
    await manager.updateOrg(orgId);
    expect(finals()).toHaveLength(2);
  });

  it('status unreadable: an error, no stuck button', async () => {
    statuses = [null];
    await manager.updateOrg(orgId);
    expect(finals()).toEqual([{ running: false, action: 'update', error: 'Could not read the plugin status.', step: null }]);
  });

  it('version not applied after the plugin update: an error', async () => {
    statuses = [plugin(), plugin()];
    await manager.updateOrg(orgId);
    expect(finals()[0].error).toBe('The plugin is still at v1.2.0 after the update.');
    expect(sends).toHaveLength(0);
  });

  it('the org removed while waiting: rejects, reports it, removes the listener', async () => {
    statuses = [plugin({ updateAvailable: false, orgUpdateAvailable: true })];
    const run = manager.updateOrg(orgId);
    await tick();
    vi.spyOn(manager.registry, 'get').mockReturnValue(undefined);
    await run;
    expect(finals()).toEqual([{ running: false, action: 'update', error: 'The update stopped: The org is no longer available.', step: null }]);
    expect(cos.listeners).toHaveLength(0);
  });

  it('waitForCos ignores the end of an earlier CoS turn and resolves on the end of the tagged one', async () => {
    cos.tags.push(undefined); // the CoS is busy with an earlier turn
    statuses = [plugin({ updateAvailable: false, orgUpdateAvailable: true }), plugin({ updateAvailable: false, hqFrameworkVersion: '1.3.0' })];
    const run = manager.updateOrg(orgId);
    await tick();
    expect(sends).toHaveLength(1);
    cos.end(undefined); // the earlier turn ends first
    await tick();
    expect(finals()).toEqual([]);
    expect(actions().at(-1)?.step).toBe('cos');
    cos.end(sends[0].tag);
    await run;
    expect(finals()).toEqual([{ running: false, action: 'update', error: null, step: null, done: true }]);
    expect(cos.listeners).toHaveLength(0);
  });

  it('waitForCos resolves when the tagged message was answered in a batch with another one (absorbed into one turn)', async () => {
    cos.tags.push(undefined); // the CoS is busy with an earlier message, which absorbs the tagged one
    statuses = [plugin({ updateAvailable: false, orgUpdateAvailable: true }), plugin({ updateAvailable: false, hqFrameworkVersion: '1.3.0' })];
    const run = manager.updateOrg(orgId);
    await tick();
    cos.end(undefined, sends[0].tag);
    await run;
    expect(finals()).toEqual([{ running: false, action: 'update', error: null, step: null, done: true }]);
    expect(cos.listeners).toHaveLength(0);
  });

  it('hq still behind after the tagged turn: an error', async () => {
    statuses = [plugin({ updateAvailable: false, orgUpdateAvailable: true })];
    const run = manager.updateOrg(orgId);
    await tick();
    cos.end(sends[0].tag);
    await run;
    expect(finals()[0].error).toBe("The hq is still at v1.1.0: see Ada's reply in the thread.");
  });

  it('resolves without a turn end when a status refresh shows the hq current', async () => {
    statuses = [plugin({ updateAvailable: false, orgUpdateAvailable: true }), plugin({ updateAvailable: false, hqFrameworkVersion: '1.3.0' })];
    const run = manager.updateOrg(orgId);
    await tick();
    await manager.refreshPrereqs(orgId); // the hq watcher's refresh
    await run;
    expect(finals()[0]).toMatchObject({ error: null, done: true });
    expect(cos.listeners).toHaveLength(0);
  });

  it('a dropped message (thread stopped) is reported', async () => {
    statuses = [plugin({ updateAvailable: false, orgUpdateAvailable: true })];
    const run = manager.updateOrg(orgId);
    await tick();
    cos.tags = [];
    await run;
    expect(finals()[0].error).toBe('The update stopped: The message to Ada was dropped.');
  });
});

describe('OrgManager.setSettings permission mode', () => {
  it('writes the org setting and refreshes the state of every chat; other keys do not', () => {
    manager.setSettings(orgId, { permissionMode: 'plan' });
    expect(setCalls).toEqual([{ permissionMode: 'plan' }]);
    expect(stateEmits).toBe(1);
    manager.setSettings(orgId, { effort: 'low' });
    expect(stateEmits).toBe(1);
  });
});
