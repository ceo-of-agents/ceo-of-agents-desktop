import { describe, expect, it, vi } from 'vitest';
import { RunGuard, choiceAt, confirmText, guardButtons, type GuardChoice, type GuardScope, type RunningItem } from '../../src/main/org/run-guard';
import { waitFor } from './helpers';

const NOW = Date.UTC(2026, 10, 18, 10, 0, 0);
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const dispatch = (orgId: string, orgName: string, who: string, what: string, minAgo: number): RunningItem => ({ orgId, orgName, who, what, startedAt: at(minAgo), kind: 'dispatch' });

/** A world of running items per org; `end` removes an org's items and tells the guard. */
function world(initial: RunningItem[], choice: GuardChoice = 'wait') {
  let items = [...initial];
  const asked: Array<{ message: string; detail: string; scope: GuardScope }> = [];
  const forceStops: Array<[string, string]> = [];
  const pending: Array<[string, string]> = [];
  const after: string[] = [];
  const ref: { choice: GuardChoice } = { choice };
  const guard: RunGuard = new RunGuard({
    items: (scope) => items.filter((i) => scope === 'all' || i.orgId === scope),
    ask: async (text, scope) => {
      asked.push({ ...text, scope });
      return ref.choice;
    },
    forceStop: async (orgId, label) => {
      forceStops.push([orgId, label]);
      items = items.filter((i) => i.orgId !== orgId);
      guard.changed();
    },
    notePending: (orgId, text) => pending.push([orgId, text]),
    afterStop: (orgId) => after.push(orgId),
    now: () => NOW,
    settleMs: 0,
  });
  const end = (orgId: string) => {
    items = items.filter((i) => i.orgId !== orgId);
    guard.changed();
  };
  return { guard, asked, forceStops, pending, after, ref, end, add: (i: RunningItem) => items.push(i) };
}

const MAX = dispatch('a', 'Acme', 'Max', 'Fix app issues #38 and #39', 12);
const OTHER = dispatch('b', 'Other Org', 'Zed', 'Write the report', 3);

describe('confirmText', () => {
  it('one line per item: who is still working on what, with the elapsed time', () => {
    const cos: RunningItem = { orgId: 'a', orgName: 'Acme', who: 'Ada', what: 'replying', startedAt: at(0.5), kind: 'cos-turn' };
    const bare = dispatch('a', 'Acme', 'Nora', '', 1);
    const r = confirmText([MAX, cos, bare], 'a', NOW);
    expect(r.message.split('\n')).toEqual(['Max is still working on: Fix app issues #38 and #39 (12 min 0 s)', 'Ada is still replying (30 s)', 'Nora is still working (1 min 0 s)']);
    expect(r.detail).toMatch(/Stopping ends their runs now/);
  });

  it('every org with work in more than one: lines start with the org name and are grouped by org', () => {
    const second = dispatch('a', 'Acme', 'Nora', 'Logo', 2);
    const r = confirmText([MAX, OTHER, second], 'all', NOW);
    expect(r.message.split('\n')).toEqual(['Acme: Max, Fix app issues #38 and #39 (12 min 0 s)', 'Acme: Nora, Logo (2 min 0 s)', 'Other Org: Zed, Write the report (3 min 0 s)']);
  });

  it('every org, work in only one: plain lines, no org name', () => {
    expect(confirmText([MAX], 'all', NOW).message).toBe('Max is still working on: Fix app issues #38 and #39 (12 min 0 s)');
  });
});

describe('dialog choices', () => {
  it('three buttons: wait, stop, cancel; unknown index is cancel', () => {
    expect(guardButtons()).toEqual(['Wait and do it when they finish', 'Stop them and continue', 'Cancel']);
    expect([0, 1, 2, 7, -1].map(choiceAt)).toEqual(['wait', 'stop', 'cancel', 'cancel', 'cancel']);
  });
});

describe('RunGuard', () => {
  it('nothing running: no dialog, the action runs at once', async () => {
    const w = world([]);
    const fn = vi.fn();
    expect(await w.guard.run('a', 'Update', fn)).toBe('done');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(w.asked).toEqual([]);
  });

  it('cancel: nothing runs, nothing stops', async () => {
    const w = world([MAX], 'cancel');
    const fn = vi.fn();
    expect(await w.guard.run('a', 'Update', fn)).toBe('cancelled');
    expect(fn).not.toHaveBeenCalled();
    expect(w.forceStops).toEqual([]);
    expect(w.guard.pending()).toEqual([]);
  });

  it('stop: force-stops the org with work (with the action label), runs the action, then afterStop', async () => {
    const w = world([MAX, OTHER], 'stop');
    const fn = vi.fn();
    expect(await w.guard.run('a', 'Update', fn)).toBe('done');
    expect(w.forceStops).toEqual([['a', 'Update']]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(w.after).toEqual(['a']);
  });

  it('wait: queues, tells the org, runs once when the work has ended', async () => {
    const w = world([MAX], 'wait');
    const fn = vi.fn();
    expect(await w.guard.run('a', 'Update', fn)).toBe('queued');
    expect(fn).not.toHaveBeenCalled();
    expect(w.pending).toEqual([['a', 'Update will run when this work has finished.']]);
    expect(w.guard.pending()).toEqual([{ scope: 'a', label: 'Update' }]);
    w.end('a');
    await waitFor(() => fn.mock.calls.length > 0);
    w.end('a');
    await new Promise((r) => setTimeout(r, 30));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(w.guard.pending()).toEqual([]);
  });

  it('wait: a new item that appears right after the last one ended (the report turn) holds the action', async () => {
    const w = world([MAX], 'wait');
    const fn = vi.fn();
    await w.guard.run('a', 'Update', fn);
    w.end('a');
    w.add({ orgId: 'a', orgName: 'Acme', who: 'Ada', what: 'replying', startedAt: at(0), kind: 'cos-turn' });
    await new Promise((r) => setTimeout(r, 30));
    expect(fn).not.toHaveBeenCalled();
    w.end('a');
    await waitFor(() => fn.mock.calls.length > 0);
  });

  it('wait with a pending text of its own (quit)', async () => {
    const w = world([MAX], 'wait');
    await w.guard.run('all', 'Quit', vi.fn(), { pendingText: 'The app will quit when this work has finished.' });
    expect(w.pending).toEqual([['a', 'The app will quit when this work has finished.']]);
  });

  it('asking again for a queued action: stop runs it now and drops the queued one; cancel drops it', async () => {
    const w = world([MAX], 'wait');
    const first = vi.fn();
    await w.guard.run('a', 'Update', first);
    w.ref.choice = 'stop';
    const second = vi.fn();
    expect(await w.guard.run('a', 'Update', second)).toBe('done');
    expect(second).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(first).not.toHaveBeenCalled();

    const w2 = world([MAX], 'wait');
    const queued = vi.fn();
    await w2.guard.run('a', 'Update', queued);
    w2.ref.choice = 'cancel';
    expect(await w2.guard.run('a', 'Update', vi.fn())).toBe('cancelled');
    expect(w2.guard.pending()).toEqual([]);
    w2.end('a');
    await new Promise((r) => setTimeout(r, 30));
    expect(queued).not.toHaveBeenCalled();
  });

  it('waiting twice for the same action keeps one queued run and one note', async () => {
    const w = world([MAX], 'wait');
    const a = vi.fn();
    const b = vi.fn();
    await w.guard.run('a', 'Update', a);
    await w.guard.run('a', 'Update', b);
    expect(w.pending).toHaveLength(1);
    w.end('a');
    await waitFor(() => a.mock.calls.length + b.mock.calls.length > 0);
    await new Promise((r) => setTimeout(r, 30));
    expect(a.mock.calls.length + b.mock.calls.length).toBe(1);
  });

  it('while a dialog is open a second request for the SAME scope is cancelled, not asked', async () => {
    const w = world([MAX], 'cancel');
    let release: (c: GuardChoice) => void = () => undefined;
    let asks = 0;
    (w.guard as unknown as { d: { ask: unknown } }).d.ask = () => {
      asks++;
      return new Promise<GuardChoice>((r) => (release = r));
    };
    const first = w.guard.run('a', 'Update', vi.fn());
    const fn = vi.fn();
    expect(await w.guard.run('a', 'Apply settings', fn)).toBe('cancelled');
    expect(asks).toBe(1);
    expect(fn).not.toHaveBeenCalled();
    release('cancel');
    expect(await first).toBe('cancelled');
    // once the dialog is closed the scope asks again
    const again = w.guard.run('a', 'Update', vi.fn());
    expect(asks).toBe(2);
    release('cancel');
    expect(await again).toBe('cancelled');
  });

  it('while a dialog is open a request for a DIFFERENT scope still asks (Quit while an org asks)', async () => {
    const w = world([MAX, OTHER], 'cancel');
    const releases: Array<(c: GuardChoice) => void> = [];
    const scopes: GuardScope[] = [];
    (w.guard as unknown as { d: { ask: unknown } }).d.ask = (_t: unknown, scope: GuardScope) => {
      scopes.push(scope);
      return new Promise<GuardChoice>((r) => releases.push(r));
    };
    const first = w.guard.run('a', 'Update', vi.fn());
    const quit = vi.fn();
    const second = w.guard.run('all', 'Quit', quit);
    expect(scopes).toEqual(['a', 'all']);
    releases[1]('stop');
    expect(await second).toBe('done');
    expect(quit).toHaveBeenCalledTimes(1);
    releases[0]('cancel');
    expect(await first).toBe('cancelled');
  });

  it('work that ended while the dialog was open: the action runs at once', async () => {
    const w = world([MAX], 'wait');
    const fn = vi.fn();
    (w.guard as unknown as { d: { ask: unknown } }).d.ask = async () => {
      w.end('a');
      return 'wait';
    };
    expect(await w.guard.run('a', 'Update', fn)).toBe('done');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a failing queued action is logged, not thrown', async () => {
    const w = world([MAX], 'wait');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await w.guard.run('a', 'Update', () => {
      throw new Error('boom');
    });
    w.end('a');
    await waitFor(() => spy.mock.calls.length > 0);
    spy.mockRestore();
  });
});

describe('RunGuard with two orgs', () => {
  it('an org-scoped action in A shows only A and stops only A; B keeps running', async () => {
    const w = world([MAX, OTHER], 'stop');
    const fn = vi.fn();
    await w.guard.run('a', 'Apply settings', fn);
    expect(w.asked).toHaveLength(1);
    expect(w.asked[0].message).not.toMatch(/Zed|Other Org|Write the report/);
    expect(w.asked[0].message).toMatch(/Max/);
    expect(w.forceStops).toEqual([['a', 'Apply settings']]);
    // B has work and nothing was asked about it: still there
    expect(w.guard.hasItems('b')).toBe(true);
    // an action in B asks about B only
    w.ref.choice = 'cancel';
    await w.guard.run('b', 'Update', fn);
    expect(w.asked[1].message).toBe('Zed is still working on: Write the report (3 min 0 s)');
  });

  it('quit (all) shows both orgs grouped, "stop" force-stops both, "wait" waits for both', async () => {
    const w = world([MAX, OTHER], 'wait');
    const quit = vi.fn();
    expect(await w.guard.run('all', 'Quit', quit)).toBe('queued');
    expect(w.asked[0].message.split('\n')).toEqual(['Acme: Max, Fix app issues #38 and #39 (12 min 0 s)', 'Other Org: Zed, Write the report (3 min 0 s)']);
    expect(w.pending.map((p) => p[0])).toEqual(['a', 'b']);
    w.end('a');
    await new Promise((r) => setTimeout(r, 30));
    expect(quit).not.toHaveBeenCalled(); // B still runs
    w.end('b');
    await waitFor(() => quit.mock.calls.length > 0);

    const s = world([MAX, OTHER], 'stop');
    const quit2 = vi.fn();
    await s.guard.run('all', 'Quit', quit2);
    expect(s.forceStops).toEqual([['a', 'Quit'], ['b', 'Quit']]);
    expect(quit2).toHaveBeenCalledTimes(1);
  });
});

describe('RunGuard queue options', () => {
  it('whenReady runs instead of fn when the queued action becomes ready', async () => {
    const w = world([MAX], 'wait');
    const fn = vi.fn();
    const whenReady = vi.fn();
    expect(await w.guard.run('a', 'Update', fn, { whenReady })).toBe('queued');
    w.end('a');
    await waitFor(() => whenReady.mock.calls.length > 0);
    await new Promise((r) => setTimeout(r, 30));
    expect(whenReady).toHaveBeenCalledTimes(1);
    expect(fn).not.toHaveBeenCalled();
    expect(w.guard.pending()).toEqual([]);
  });

  it('whenReady is not used when the action runs at once (stop, or nothing running)', async () => {
    const s = world([MAX], 'stop');
    const fn = vi.fn();
    const whenReady = vi.fn();
    await s.guard.run('a', 'Update', fn, { whenReady });
    expect(fn).toHaveBeenCalledTimes(1);
    const idle = world([]);
    const fn2 = vi.fn();
    await idle.guard.run('a', 'Update', fn2, { whenReady });
    expect(fn2).toHaveBeenCalledTimes(1);
    expect(whenReady).not.toHaveBeenCalled();
  });

  it('wins: with an org Update and a Quit queued, when everything is clear only Quit runs; the others stay until dropAll', async () => {
    const w = world([MAX, OTHER], 'wait');
    const update = vi.fn();
    const quit = vi.fn();
    expect(await w.guard.run('a', 'Update', update)).toBe('queued');
    expect(await w.guard.run('all', 'Quit', quit, { wins: true })).toBe('queued');
    expect(w.guard.pending()).toEqual([
      { scope: 'a', label: 'Update' },
      { scope: 'all', label: 'Quit' },
    ]);
    // both orgs end at once: both actions are ready, Quit wins
    w.guard.runReady();
    expect(quit).not.toHaveBeenCalled();
    w.end('a');
    w.end('b');
    await waitFor(() => quit.mock.calls.length > 0);
    await new Promise((r) => setTimeout(r, 30));
    expect(quit).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    // Quit drops them only when it really ends the app (a Quit cancelled at its own dialog leaves them queued).
    expect(w.guard.pending()).toEqual([{ scope: 'a', label: 'Update' }]);
    w.guard.dropAll();
    expect(w.guard.pending()).toEqual([]);
  });

  it('wins: when only the org scope clears first, the Update runs and Quit stays queued', async () => {
    const w = world([MAX, OTHER], 'wait');
    const update = vi.fn();
    const quit = vi.fn();
    await w.guard.run('a', 'Update', update);
    await w.guard.run('all', 'Quit', quit, { wins: true });
    w.end('a'); // B still runs: 'all' is not clear
    await waitFor(() => update.mock.calls.length > 0);
    await new Promise((r) => setTimeout(r, 30));
    expect(update).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
    expect(w.guard.pending()).toEqual([{ scope: 'all', label: 'Quit' }]);
    w.end('b');
    await waitFor(() => quit.mock.calls.length > 0);
    expect(w.guard.pending()).toEqual([]);
  });
});
