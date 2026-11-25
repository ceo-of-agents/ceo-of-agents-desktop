import { describe, expect, it } from 'vitest';
import { runOrgUpdate, type UpdateOrgDeps } from '../../src/main/org/update-org';
import type { PluginActionState, PluginStatus } from '../../src/shared/types';

const plugin = (over: Partial<PluginStatus> = {}): PluginStatus => ({
  state: 'ok', installed: '1.2.0', latest: '1.3.0', updateAvailable: true, hqFrameworkVersion: '1.1.0', orgUpdateAvailable: false, belowMinimum: false, minimum: '1.0.0', latestCheckFailed: false, dev: false, ...over,
});
const current = (over: Partial<PluginStatus> = {}) => plugin({ installed: '1.3.0', updateAvailable: false, hqFrameworkVersion: '1.3.0', orgUpdateAvailable: false, ...over });

type Throws = Partial<Record<'status' | 'updatePlugin' | 'restart' | 'sendToCos' | 'waitForCos', Error>>;

/** Fakes only: no runner, no claude, no session process. `statuses` are returned by successive status() calls. */
function setup(statuses: Array<PluginStatus | null>, update: { ok: boolean; error: string | null } = { ok: true, error: null }, throws: Throws = {}) {
  const calls: string[] = [];
  const events: PluginActionState[] = [];
  let i = 0;
  const deps: UpdateOrgDeps = {
    status: async () => {
      calls.push('status');
      if (throws.status) throw throws.status;
      return statuses[Math.min(i++, statuses.length - 1)];
    },
    updatePlugin: async () => {
      calls.push('update');
      if (throws.updatePlugin) throw throws.updatePlugin;
      return update;
    },
    restart: async () => {
      calls.push('restart');
      if (throws.restart) throw throws.restart;
    },
    sendToCos: (text) => {
      calls.push(`send:${text}`);
      if (throws.sendToCos) throw throws.sendToCos;
    },
    waitForCos: async () => {
      calls.push('wait');
      if (throws.waitForCos) throw throws.waitForCos;
    },
    emit: (s) => events.push(s),
    message: 'APPLY',
    cosName: 'Ada',
    recheckMs: 0,
  };
  return { deps, calls, events };
}

const finals = (events: PluginActionState[]) => events.filter((e) => !e.running);
const steps = (events: PluginActionState[]) => events.filter((e) => e.running).map((e) => e.step);

describe('runOrgUpdate', () => {
  it('plugin behind and hq behind: update, restart, status, message, wait, status; steps in order; one final emit', async () => {
    const s = setup([plugin({ orgUpdateAvailable: true }), plugin({ installed: '1.3.0', updateAvailable: false, orgUpdateAvailable: true }), current()]);
    expect(await runOrgUpdate(s.deps)).toBe('asked-cos');
    expect(s.calls).toEqual(['status', 'update', 'restart', 'status', 'send:APPLY', 'wait', 'status']);
    expect(steps(s.events)).toEqual(['checking', 'plugin', 'restart', 'cos']);
    expect(finals(s.events)).toEqual([{ running: false, action: 'update', error: null, step: null, done: true }]);
    expect(s.events.at(-1)?.running).toBe(false);
  });
  it('only the hq behind: no plugin command, no restart, message and wait', async () => {
    const s = setup([plugin({ updateAvailable: false, orgUpdateAvailable: true }), current()]);
    expect(await runOrgUpdate(s.deps)).toBe('asked-cos');
    expect(s.calls).toEqual(['status', 'send:APPLY', 'wait', 'status']);
    expect(steps(s.events)).toEqual(['checking', 'cos']);
    expect(finals(s.events)).toHaveLength(1);
  });
  it('hq current after the plugin update: no CoS message, success', async () => {
    const s = setup([plugin({ hqFrameworkVersion: '1.2.0' }), current()]);
    expect(await runOrgUpdate(s.deps)).toBe('hq-current');
    expect(s.calls).toEqual(['status', 'update', 'restart', 'status']);
    expect(finals(s.events)[0]).toMatchObject({ error: null, done: true });
  });
  it('nothing to do: success with done', async () => {
    const s = setup([current()]);
    expect(await runOrgUpdate(s.deps)).toBe('nothing-to-do');
    expect(s.calls).toEqual(['status']);
    expect(finals(s.events)).toEqual([{ running: false, action: 'update', error: null, step: null, done: true }]);
  });
  it('update failure: stops, tells the hq update was not started, no restart, no message', async () => {
    const s = setup([plugin({ orgUpdateAvailable: true })], { ok: false, error: 'Could not update the plugin.\nboom' });
    expect(await runOrgUpdate(s.deps)).toBe('plugin-failed');
    expect(s.calls).toEqual(['status', 'update']);
    expect(finals(s.events)).toEqual([{ running: false, action: 'update', error: 'The plugin update failed: Could not update the plugin. boom. The hq update was not started.', step: null }]);
  });
  it('dev folder: skips the plugin step, still asks for the hq when it is behind', async () => {
    const s = setup([plugin({ dev: true, updateAvailable: false, orgUpdateAvailable: true }), current({ dev: true })]);
    expect(await runOrgUpdate(s.deps)).toBe('asked-cos');
    expect(s.calls).toEqual(['status', 'send:APPLY', 'wait', 'status']);
  });
  it('dev folder with updateAvailable true: no plugin command', async () => {
    const s = setup([plugin({ dev: true })]);
    expect(await runOrgUpdate(s.deps)).toBe('nothing-to-do');
    expect(s.calls).toEqual(['status']);
  });
  it('status null: error, no further step', async () => {
    const s = setup([null]);
    expect(await runOrgUpdate(s.deps)).toBe('status-failed');
    expect(s.calls).toEqual(['status']);
    expect(finals(s.events)).toEqual([{ running: false, action: 'update', error: 'Could not read the plugin status.', step: null }]);
  });
  it('status not ok (plugin missing): error', async () => {
    const s = setup([plugin({ state: 'missing', installed: null, updateAvailable: false })]);
    expect(await runOrgUpdate(s.deps)).toBe('status-failed');
    expect(finals(s.events)).toHaveLength(1);
    expect(finals(s.events)[0].error).toBe('Could not read the plugin status.');
  });
  it('status null after the restart: error', async () => {
    const s = setup([plugin(), null]);
    expect(await runOrgUpdate(s.deps)).toBe('status-failed');
    expect(s.calls).toEqual(['status', 'update', 'restart', 'status']);
    expect(finals(s.events)).toHaveLength(1);
  });
  it('status null after the CoS turn: error', async () => {
    const s = setup([plugin({ updateAvailable: false, orgUpdateAvailable: true }), null]);
    expect(await runOrgUpdate(s.deps)).toBe('status-failed');
    expect(finals(s.events)).toHaveLength(1);
  });
  it('plugin still behind after the update: error with the installed version, no message', async () => {
    const s = setup([plugin({ orgUpdateAvailable: true }), plugin({ orgUpdateAvailable: true })]);
    expect(await runOrgUpdate(s.deps)).toBe('plugin-not-applied');
    expect(s.calls).toEqual(['status', 'update', 'restart', 'status']);
    expect(finals(s.events)).toEqual([{ running: false, action: 'update', error: 'The plugin is still at v1.2.0 after the update.', step: null }]);
  });
  it('hq still behind right after the CoS turn but current at the re-check: success, no error', async () => {
    const s = setup([plugin({ updateAvailable: false, orgUpdateAvailable: true }), plugin({ updateAvailable: false, orgUpdateAvailable: true }), current()]);
    expect(await runOrgUpdate(s.deps)).toBe('asked-cos');
    expect(s.calls).toEqual(['status', 'send:APPLY', 'wait', 'status', 'status']);
    expect(finals(s.events)).toEqual([{ running: false, action: 'update', error: null, step: null, done: true }]);
  });
  it('hq current right after the CoS turn: no re-check', async () => {
    const s = setup([plugin({ updateAvailable: false, orgUpdateAvailable: true }), current()]);
    await runOrgUpdate(s.deps);
    expect(s.calls.filter((c) => c === 'status')).toHaveLength(2);
  });
  it('hq still behind after the CoS turn: error naming the CoS', async () => {
    const s = setup([plugin({ updateAvailable: false, orgUpdateAvailable: true }), plugin({ updateAvailable: false, orgUpdateAvailable: true })]);
    expect(await runOrgUpdate(s.deps)).toBe('hq-not-applied');
    expect(s.calls).toEqual(['status', 'send:APPLY', 'wait', 'status', 'status']);
    expect(finals(s.events)).toEqual([{ running: false, action: 'update', error: "The hq is still at v1.1.0: see Ada's reply in the thread.", step: null }]);
  });

  describe('a throw ends with exactly one final emit and the message', () => {
    const cases: Array<[string, Throws, Array<PluginStatus | null>]> = [
      ['status', { status: new Error('org removed') }, [plugin()]],
      ['updatePlugin', { updatePlugin: new Error('org removed') }, [plugin()]],
      ['restart', { restart: new Error('org removed') }, [plugin()]],
      ['sendToCos', { sendToCos: new Error('org removed') }, [plugin({ updateAvailable: false, orgUpdateAvailable: true })]],
      ['waitForCos', { waitForCos: new Error('org removed') }, [plugin({ updateAvailable: false, orgUpdateAvailable: true })]],
    ];
    for (const [name, throws, statuses] of cases) {
      it(name, async () => {
        const s = setup(statuses, { ok: true, error: null }, throws);
        expect(await runOrgUpdate(s.deps)).toBe('failed');
        expect(finals(s.events)).toEqual([{ running: false, action: 'update', error: 'The update stopped: org removed.', step: null }]);
        expect(s.events.at(-1)?.running).toBe(false);
      });
    }
  });
});
