import { describe, expect, it, vi } from 'vitest';
import { QuitCoordinator } from '../src/main/quit';
import { RunGuard, type GuardChoice, type GuardScope, type RunningItem } from '../src/main/org/run-guard';
import { waitFor } from './org/helpers';

const item = (orgId: string, who: string): RunningItem => ({ orgId, orgName: orgId.toUpperCase(), who, what: 'a task', startedAt: new Date(0).toISOString(), kind: 'dispatch' });
const MAX = item('a', 'Max');
const ZED = item('b', 'Zed');
const settle = () => new Promise((r) => setTimeout(r, 30));

/**
 * A real RunGuard over a world of running items, and a coordinator over fakes. `calls` records the order of the
 * steps. `handover` and `choices` are scripts: the next value is used, the last one repeats.
 */
function setup(o: { items?: RunningItem[]; handover?: boolean[]; choices?: GuardChoice[] } = {}) {
  let items = [...(o.items ?? [])];
  const calls: string[] = [];
  const handoverScript = o.handover ?? [true];
  const choiceScript = o.choices ?? ['cancel'];
  let handoverN = 0;
  let askN = 0;
  const asked: GuardScope[] = [];
  const notes: Array<[string, string]> = [];
  const guard: RunGuard = new RunGuard({
    items: (scope) => items.filter((i) => scope === 'all' || i.orgId === scope),
    ask: async (_text, scope) => {
      calls.push('ask');
      asked.push(scope);
      return choiceScript[Math.min(askN++, choiceScript.length - 1)];
    },
    forceStop: async (orgId, label) => {
      calls.push(`forceStop:${orgId}:${label}`);
      items = items.filter((i) => i.orgId !== orgId);
    },
    notePending: (orgId, text) => notes.push([orgId, text]),
    settleMs: 0,
  });
  const shutdown = vi.fn(async () => {
    calls.push('shutdown');
  });
  const exit = vi.fn(() => {
    calls.push('exit');
  });
  const forceStopAll = vi.fn(async () => {
    calls.push('forceStopAll');
  });
  const handoverCheck = vi.fn(async () => {
    calls.push('handover');
    return handoverScript[Math.min(handoverN++, handoverScript.length - 1)];
  });
  const quit = new QuitCoordinator({ handoverCheck, guard, label: 'Quit', pendingText: 'The app will quit when this work has finished.', forceStopAll, shutdown, exit });
  return {
    quit,
    guard,
    calls,
    asked,
    notes,
    shutdown,
    exit,
    forceStopAll,
    handoverCheck,
    end: (orgId: string) => {
      items = items.filter((i) => i.orgId !== orgId);
      guard.changed();
    },
  };
}

describe('QuitCoordinator', () => {
  it('nothing running, handover check ok: shutdown once, exit once, allowQuit true; a second request does nothing', async () => {
    const s = setup();
    expect(s.quit.allowQuit).toBe(false);
    expect(await s.quit.request()).toBe(true);
    expect(s.calls).toEqual(['handover', 'shutdown', 'exit']);
    expect(s.quit.allowQuit).toBe(true);
    expect(await s.quit.request()).toBe(true);
    expect(s.handoverCheck).toHaveBeenCalledTimes(1);
    expect(s.shutdown).toHaveBeenCalledTimes(1);
    expect(s.exit).toHaveBeenCalledTimes(1);
  });

  it('a failing shutdown is logged and the app still exits', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const s = setup();
    s.shutdown.mockRejectedValueOnce(new Error('boom'));
    await s.quit.request();
    expect(spy).toHaveBeenCalled();
    expect(s.exit).toHaveBeenCalledTimes(1);
    expect(s.quit.allowQuit).toBe(true);
    spy.mockRestore();
  });

  it('handover check cancelled: no guard, no shutdown; the next request asks the handover check again', async () => {
    const s = setup({ handover: [false, true] });
    expect(await s.quit.request()).toBe(false);
    expect(s.calls).toEqual(['handover']);
    expect(s.quit.allowQuit).toBe(false);
    expect(s.shutdown).not.toHaveBeenCalled();
    expect(s.exit).not.toHaveBeenCalled();
    await s.quit.request();
    expect(s.handoverCheck).toHaveBeenCalledTimes(2);
    expect(s.calls).toEqual(['handover', 'handover', 'shutdown', 'exit']);
    expect(s.quit.allowQuit).toBe(true);
  });

  it('guard cancel: no shutdown; the next request runs the handover check and the guard again', async () => {
    const s = setup({ items: [MAX], choices: ['cancel', 'stop'] });
    expect(await s.quit.request()).toBe(false);
    expect(s.calls).toEqual(['handover', 'ask']);
    expect(s.shutdown).not.toHaveBeenCalled();
    expect(s.quit.allowQuit).toBe(false);
    expect(s.guard.pending()).toEqual([]);
    await s.quit.request();
    expect(s.handoverCheck).toHaveBeenCalledTimes(2);
    expect(s.asked).toEqual(['all', 'all']);
    expect(s.calls).toEqual(['handover', 'ask', 'handover', 'ask', 'forceStop:a:Quit', 'shutdown', 'exit']);
  });

  it('guard wait: queued; when the work ends the whole sequence runs again (handover check twice), then shutdown and exit', async () => {
    const s = setup({ items: [MAX], choices: ['wait'] });
    expect(await s.quit.request()).toBe(false);
    expect(s.calls).toEqual(['handover', 'ask']);
    expect(s.guard.pending()).toEqual([{ scope: 'all', label: 'Quit' }]);
    expect(s.notes).toEqual([['a', 'The app will quit when this work has finished.']]);
    expect(s.shutdown).not.toHaveBeenCalled();
    expect(s.quit.allowQuit).toBe(false);
    s.end('a');
    await waitFor(() => s.exit.mock.calls.length > 0);
    expect(s.handoverCheck).toHaveBeenCalledTimes(2);
    expect(s.calls).toEqual(['handover', 'ask', 'handover', 'shutdown', 'exit']);
    expect(s.shutdown).toHaveBeenCalledTimes(1);
    expect(s.quit.allowQuit).toBe(true);
    expect(s.guard.pending()).toEqual([]);
  });

  it('guard wait: if the second pass is cancelled in the handover check, nothing quits and the queue is empty', async () => {
    const s = setup({ items: [MAX], choices: ['wait'], handover: [true, false] });
    await s.quit.request();
    s.end('a');
    await waitFor(() => s.handoverCheck.mock.calls.length === 2);
    await settle();
    expect(s.shutdown).not.toHaveBeenCalled();
    expect(s.exit).not.toHaveBeenCalled();
    expect(s.guard.pending()).toEqual([]);
    expect(s.quit.allowQuit).toBe(false);
  });

  it('guard wait: Quit wins over a queued org action, which never runs', async () => {
    const s = setup({ items: [MAX], choices: ['wait'] });
    const update = vi.fn();
    expect(await s.guard.run('a', 'Update', update)).toBe('queued');
    await s.quit.request();
    expect(s.guard.pending()).toHaveLength(2);
    s.end('a');
    await waitFor(() => s.exit.mock.calls.length > 0);
    await settle();
    expect(update).not.toHaveBeenCalled();
    expect(s.shutdown).toHaveBeenCalledTimes(1);
    expect(s.guard.pending()).toEqual([]);
  });

  it('guard wait: with two orgs, Quit stays queued until both have finished', async () => {
    const s = setup({ items: [MAX, ZED], choices: ['wait'] });
    await s.quit.request();
    s.end('a');
    await settle();
    expect(s.handoverCheck).toHaveBeenCalledTimes(1);
    expect(s.exit).not.toHaveBeenCalled();
    s.end('b');
    await waitFor(() => s.exit.mock.calls.length > 0);
    expect(s.handoverCheck).toHaveBeenCalledTimes(2);
  });

  it('guard stop: force-stops the orgs with work, then shutdown and exit', async () => {
    const s = setup({ items: [MAX, ZED], choices: ['stop'] });
    await s.quit.request();
    expect(s.calls).toEqual(['handover', 'ask', 'forceStop:a:Quit', 'forceStop:b:Quit', 'shutdown', 'exit']);
    expect(s.quit.allowQuit).toBe(true);
    expect(s.exit).toHaveBeenCalledTimes(1);
  });

  it('requests while one is in progress (the handover dialog is open) are ignored', async () => {
    const s = setup();
    let answer: (ok: boolean) => void = () => undefined;
    s.handoverCheck.mockImplementation(() => {
      s.calls.push('handover');
      return new Promise<boolean>((r) => (answer = r));
    });
    const first = s.quit.request();
    await s.quit.request();
    await s.quit.request();
    expect(s.handoverCheck).toHaveBeenCalledTimes(1);
    answer(true);
    await first;
    expect(s.calls).toEqual(['handover', 'shutdown', 'exit']);
    expect(s.exit).toHaveBeenCalledTimes(1);
  });

  it('requests while the run guard dialog is open are ignored (no second dialog)', async () => {
    const s = setup({ items: [MAX] });
    let choose: (c: GuardChoice) => void = () => undefined;
    (s.guard as unknown as { d: { ask: unknown } }).d.ask = () => new Promise<GuardChoice>((r) => (choose = r));
    const first = s.quit.request();
    await waitFor(() => s.handoverCheck.mock.calls.length === 1);
    await settle();
    await s.quit.request();
    expect(s.handoverCheck).toHaveBeenCalledTimes(1);
    choose('cancel');
    await first;
    expect(s.shutdown).not.toHaveBeenCalled();
    // the next request starts over
    const second = s.quit.request();
    await waitFor(() => s.handoverCheck.mock.calls.length === 2);
    await settle();
    choose('cancel');
    await second;
  });

  it('system shutdown: no handover check, no dialog; forceStopAll, then shutdown, then exit', async () => {
    const s = setup({ items: [MAX, ZED], choices: ['cancel'] });
    s.quit.systemShutdown();
    await s.quit.request();
    expect(s.handoverCheck).not.toHaveBeenCalled();
    expect(s.asked).toEqual([]);
    expect(s.calls).toEqual(['forceStopAll', 'shutdown', 'exit']);
    expect(s.quit.allowQuit).toBe(true);
    await s.quit.request();
    expect(s.shutdown).toHaveBeenCalledTimes(1);
    expect(s.exit).toHaveBeenCalledTimes(1);
  });
});

describe('QuitCoordinator: a queued Quit that becomes ready during another request', () => {
  it('is that same quit: the open request decides, and nothing reopens after its Cancel', async () => {
    let releaseCheck: (v: boolean) => void = () => undefined;
    let checks = 0;
    const calls: string[] = [];
    const q = new QuitCoordinator({
      handoverCheck: () => {
        checks++;
        return new Promise<boolean>((r) => (releaseCheck = r));
      },
      guard: { run: async (_s, _l, fn) => { await fn(); return 'done'; }, dropAll: () => calls.push('dropAll'), changed: () => calls.push('changed'), requeue: () => calls.push('requeue') },
      label: 'Quit',
      pendingText: 'later',
      forceStopAll: async () => undefined,
      shutdown: async () => { calls.push('shutdown'); },
      exit: () => calls.push('exit'),
    });
    const first = q.request();
    await q.request(); // the queued Quit's whenReady
    releaseCheck(false);
    await first;
    await new Promise((r) => setTimeout(r, 0));
    expect(checks).toBe(1);
    expect(calls).toEqual(['changed']); // the other queued actions are told to look again, none dropped
    const second = q.request();
    releaseCheck(true);
    await second;
    expect(calls).toEqual(['changed', 'dropAll', 'shutdown', 'exit']);
  });
});

describe('QuitCoordinator: a queued Quit that becomes ready while a request is open and then cancelled', () => {
  it('stays queued and waits for the next trigger, then runs the whole sequence', async () => {
    const s = setup({ items: [MAX], choices: ['wait'] });
    await s.quit.request();
    expect(s.guard.pending()).toEqual([{ scope: 'all', label: 'Quit' }]);
    let release: (v: boolean) => void = () => undefined;
    s.handoverCheck.mockImplementationOnce(() => {
      s.calls.push('handover');
      return new Promise<boolean>((r) => (release = r));
    });
    const open = s.quit.request();
    s.end('a'); // the work ends while the handover dialog of the second request is open
    await settle();
    release(false);
    await open;
    await settle();
    // Not lost, and not run right after the Cancel.
    expect(s.guard.pending()).toEqual([{ scope: 'all', label: 'Quit' }]);
    expect(s.calls).toEqual(['handover', 'ask', 'handover']);
    s.guard.changed(); // the next trigger
    await waitFor(() => s.exit.mock.calls.length > 0);
    expect(s.calls).toEqual(['handover', 'ask', 'handover', 'handover', 'shutdown', 'exit']);
  });
});

describe('QuitCoordinator: follow-ups', () => {
  it('a cancelled Quit keeps the other queued actions; they run when their work ends', async () => {
    const s = setup({ items: [MAX], choices: ['wait', 'cancel'] });
    const update = vi.fn();
    expect(await s.guard.run('a', 'Update', update)).toBe('queued');
    s.handoverCheck.mockImplementationOnce(async () => false);
    await s.quit.request();
    expect(s.guard.pending()).toEqual([{ scope: 'a', label: 'Update' }]);
    // Quit waits, then its second pass is cancelled at the handover check: Update is still there and runs.
    const s2 = setup({ items: [MAX], choices: ['wait'], handover: [true, false] });
    const update2 = vi.fn();
    expect(await s2.guard.run('a', 'Update', update2)).toBe('queued');
    await s2.quit.request();
    s2.end('a');
    await waitFor(() => s2.handoverCheck.mock.calls.length === 2);
    await waitFor(() => update2.mock.calls.length > 0);
    expect(s2.shutdown).not.toHaveBeenCalled();
    expect(s2.guard.pending()).toEqual([]);
  });

  it('system shutdown while the handover dialog is open: finish runs at once (force stop, shutdown, exit)', async () => {
    const s = setup({ items: [MAX] });
    s.handoverCheck.mockImplementation(() => new Promise<boolean>(() => undefined)); // the dialog never answers
    void s.quit.request();
    await waitFor(() => s.handoverCheck.mock.calls.length === 1);
    s.quit.systemShutdown();
    await waitFor(() => s.exit.mock.calls.length > 0);
    expect(s.calls).toEqual(['forceStopAll', 'shutdown', 'exit']);
    expect(s.quit.allowQuit).toBe(true);
  });

  it('system shutdown while the run guard dialog is open: finish runs at once', async () => {
    const s = setup({ items: [MAX] });
    (s.guard as unknown as { d: { ask: unknown } }).d.ask = () => new Promise<GuardChoice>(() => undefined);
    void s.quit.request();
    await waitFor(() => s.handoverCheck.mock.calls.length === 1);
    await settle();
    s.quit.systemShutdown();
    await waitFor(() => s.exit.mock.calls.length > 0);
    expect(s.shutdown).toHaveBeenCalledTimes(1);
  });

  it('a failing handover check or force stop never blocks the quit sequence', async () => {
    const s = setup();
    s.handoverCheck.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    await s.quit.request();
    expect(s.shutdown).not.toHaveBeenCalled();
    const t = setup();
    t.forceStopAll.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    t.quit.systemShutdown();
    await t.quit.request();
    expect(t.exit).toHaveBeenCalledTimes(1);
  });
});
