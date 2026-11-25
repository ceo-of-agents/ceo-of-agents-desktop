// The IPC handlers that restart an org's chats go through the run guard: with work running in that org the user is
// asked (and only about that org); with nothing running the action runs at once. Electron is replaced by a stub.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => new Map<string, (...a: unknown[]) => unknown>());
vi.mock('electron', () => ({
  BrowserWindow: class {},
  dialog: {},
  shell: {},
  ipcMain: { handle: (name: string, fn: (...a: unknown[]) => unknown) => handlers.set(name, fn) },
}));

import { registerIpc } from '../src/main/ipc';
import { RunGuard, type GuardChoice, type RunningItem } from '../src/main/org/run-guard';
import { waitFor } from './org/helpers';

const item = (orgId: string, orgName: string, who: string, what: string): RunningItem => ({ orgId, orgName, who, what, startedAt: new Date().toISOString(), kind: 'dispatch' });
const call = (name: string, ...args: unknown[]) => handlers.get(name)!({}, ...args) as Promise<void>;

let items: RunningItem[];
let choice: GuardChoice;
let asked: string[];
let stopped: Array<[string, string]>;
let orgs: { updateOrg: ReturnType<typeof vi.fn>; applySettings: ReturnType<typeof vi.fn>; installPlugin: ReturnType<typeof vi.fn> };
let guard: RunGuard;

beforeEach(() => {
  handlers.clear();
  items = [item('o1', 'First', 'Max', 'Fix it'), item('o2', 'Second', 'Zed', 'Other work')];
  choice = 'wait';
  asked = [];
  stopped = [];
  orgs = { updateOrg: vi.fn(), applySettings: vi.fn(), installPlugin: vi.fn() };
  guard = new RunGuard({
    items: (scope) => items.filter((i) => scope === 'all' || i.orgId === scope),
    ask: async (text) => {
      asked.push(text.message);
      return choice;
    },
    forceStop: async (orgId, label) => {
      stopped.push([orgId, label]);
      items = items.filter((i) => i.orgId !== orgId);
    },
    notePending: () => undefined,
    settleMs: 0,
  });
  registerIpc({ win: () => null, orgs: orgs as never, broker: {} as never, emit: () => undefined, guard, setup: {} as never, appUpdate: {} as never });
});

const PATHS: Array<[string, keyof typeof orgs, string]> = [
  ['updateOrg', 'updateOrg', 'Update'],
  ['applySettings', 'applySettings', 'Apply settings'],
  ['installPlugin', 'installPlugin', 'Install plugin'],
];

describe.each(PATHS)('%s', (handler, method, label) => {
  it('nothing running in that org: no dialog, runs at once (work in another org is not asked about)', async () => {
    items = items.filter((i) => i.orgId === 'o2');
    await call(handler, 'o1');
    expect(asked).toEqual([]);
    expect(orgs[method]).toHaveBeenCalledWith('o1');
  });

  it('work running: asks about this org only; cancel runs nothing', async () => {
    choice = 'cancel';
    await call(handler, 'o1');
    expect(asked).toEqual(['Max is still working on: Fix it (0 s)']);
    expect(orgs[method]).not.toHaveBeenCalled();
  });

  it('wait: queued, runs once the org has no work left', async () => {
    await call(handler, 'o1');
    expect(orgs[method]).not.toHaveBeenCalled();
    items = items.filter((i) => i.orgId !== 'o1');
    guard.changed();
    await waitFor(() => orgs[method].mock.calls.length > 0);
    expect(orgs[method]).toHaveBeenCalledWith('o1');
  });

  it('stop: stops that org with the action label, then runs; the other org keeps running', async () => {
    choice = 'stop';
    await call(handler, 'o1');
    expect(stopped).toEqual([['o1', label]]);
    expect(orgs[method]).toHaveBeenCalledWith('o1');
    expect(items.map((i) => i.orgId)).toEqual(['o2']);
  });
});
