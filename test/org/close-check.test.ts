import { describe, expect, it, vi } from 'vitest';
import { closeCheck, closeDialogFor, pendingChats, progressDialogFor, safeCloseCheck, type ChatRef, type CloseCheckDeps } from '../../src/main/org/close-check';
import type { TabInfo } from '../../src/shared/types';

const tab = (tabId: string, o: Partial<TabInfo> = {}): TabInfo => ({
  tabId, orgId: 'o1', agent: 'max', persona: 'Max', role: 'Engineering', status: 'open', openedAt: '', closedAt: null, notePath: null, pendingWork: !o.notePath, ...o,
});
const chat = (tabId: string, o: Partial<TabInfo> = {}, org: Partial<ChatRef> = {}): ChatRef => ({ orgId: 'o1', orgName: 'ACME', cosName: 'Ada', tab: tab(tabId, o), ...org });

/** A fake session layer: `chats` is mutable, handOver/closeQuiet change it the way the real ones do. */
function setup(initial: ChatRef[], choice: number, opts: { failHandOver?: string[] } = {}) {
  const chats = initial;
  const find = (orgId: string, tabId: string) => chats.find((c) => c.orgId === orgId && c.tab.tabId === tabId)!;
  const deps = {
    chats: () => chats.map((c) => ({ ...c, tab: { ...c.tab } })),
    ask: vi.fn().mockResolvedValue(choice),
    handOver: vi.fn(async (orgId: string, tabId: string) => {
      find(orgId, tabId).tab.status = 'handing-over';
      // the hand-over ends a little later: closed with its note, or back to open when it fails
      setTimeout(() => {
        const c = find(orgId, tabId);
        if (opts.failHandOver?.includes(tabId)) c.tab.status = 'open';
        else Object.assign(c.tab, { status: 'closed', notePath: 'inbox/x.md' });
      }, 20);
    }),
    closeQuiet: vi.fn(async (orgId: string, tabId: string) => {
      find(orgId, tabId).tab.status = 'closed';
    }),
    failed: vi.fn(),
    pollMs: 5,
    maxWaitMs: 2000,
  } satisfies CloseCheckDeps;
  return { deps, chats };
}

describe('pendingChats', () => {
  it('open with pending work, and handing over; not an open chat without work, not closed', () => {
    const all = [chat('1'), chat('2', { notePath: 'inbox/a.md' }), chat('3', { status: 'handing-over' }), chat('4', { status: 'closed' }), chat('5', { pendingWork: false }), chat('6', { pendingWork: true, notePath: 'inbox/b.md' })];
    expect(pendingChats(all).map((c) => c.tab.tabId)).toEqual(['1', '3', '6']);
  });
  it('a busy open chat counts (its first tool turn has not set the flag yet); an idle one with no work does not', () => {
    const all = [chat('1', { pendingWork: false }, { busy: true }), chat('2', { pendingWork: false }, { busy: false }), chat('3', { pendingWork: false }), chat('4', { status: 'closed', pendingWork: false }, { busy: true })];
    expect(pendingChats(all).map((c) => c.tab.tabId)).toEqual(['1']);
  });
});

describe('closeDialogFor', () => {
  it('one org: names the chief of staff, lists "Persona (Role)", Hand over is the default and Cancel the escape', () => {
    const d = closeDialogFor([chat('1'), chat('2', { persona: 'Bea', role: 'Design and brand' })]);
    expect(d.message).toBe('Some department chats have not handed over');
    expect(d.detail).toContain('Max (Engineering)\nBea (Design and brand)');
    expect(d.detail).toContain('Notes already written stay in the inbox for Ada.');
    expect(d.detail).not.toContain('ACME');
    expect(d.buttons).toEqual(['Hand over to Ada', 'Quit without handover', 'Cancel']);
    expect([d.defaultId, d.cancelId]).toEqual([0, 2]);
  });
  it('several orgs: the org name on each line and a general hand-over button', () => {
    const d = closeDialogFor([chat('1'), chat('2', {}, { orgId: 'o2', orgName: 'BOLT', cosName: 'Zed' })]);
    expect(d.detail).toContain('Max (Engineering), ACME');
    expect(d.detail).toContain('Max (Engineering), BOLT');
    expect(d.buttons[0]).toBe('Hand over to the chiefs of staff');
    expect(d.detail).toContain('Notes already written stay in the inbox for the chiefs of staff.');
  });
});

describe('progressDialogFor', () => {
  it('names the chief of staff and says notes stay in the inbox; several orgs: the chiefs of staff', () => {
    const d = progressDialogFor([chat('1')]);
    expect(d.message).toBe('Handing over…');
    expect(d.detail).toBe('The app quits when every chat has handed over. Notes already written stay in the inbox for Ada.');
    expect(d.cancel).toBe('Cancel quit');
    expect(progressDialogFor([chat('1'), chat('2', {}, { orgId: 'o2', cosName: 'Zed' })]).detail).toContain('for the chiefs of staff.');
  });
});

describe('closeCheck', () => {
  it('nothing pending: proceeds without asking', async () => {
    const { deps } = setup([chat('1', { notePath: 'inbox/a.md' }), chat('2', { status: 'closed' })], 0);
    expect(await closeCheck(deps)).toBe('proceed');
    expect(deps.ask).not.toHaveBeenCalled();
  });

  it('nothing pending: a noted open chat is closed quietly (the note stays in the inbox, nothing is passed to the chief of staff) before the quit', async () => {
    const { deps, chats } = setup([chat('1', { notePath: 'inbox/a.md' }), chat('2', { status: 'closed' })], 0);
    expect(await closeCheck(deps)).toBe('proceed');
    expect(deps.closeQuiet.mock.calls).toEqual([['o1', '1']]);
    expect(chats[0].tab.status).toBe('closed');
  });

  it('Cancel leaves noted chats alone too', async () => {
    const { deps, chats } = setup([chat('1'), chat('2', { agent: 'bea', notePath: 'inbox/a.md' })], 2);
    expect(await closeCheck(deps)).toBe('stay');
    expect(deps.closeQuiet).not.toHaveBeenCalled();
    expect(chats[1].tab.status).toBe('open');
  });

  it('Hand over: hands over every open pending tab, waits until all are closed, then proceeds', async () => {
    const { deps, chats } = setup([chat('1'), chat('2', { agent: 'bea' }), chat('3', { notePath: 'inbox/a.md' })], 0);
    expect(await closeCheck(deps)).toBe('proceed');
    expect(deps.handOver.mock.calls).toEqual([['o1', '1'], ['o1', '2']]);
    expect(deps.closeQuiet.mock.calls).toEqual([['o1', '3']]); // the noted chat is closed quietly after the hand-overs: no CoS turn from the quit's own clean-up
    expect(chats.map((c) => c.tab.status)).toEqual(['closed', 'closed', 'closed']);
    expect(deps.failed).not.toHaveBeenCalled();
  });

  it('Hand over: a tab already handing over is waited for, not handed over again', async () => {
    const { deps, chats } = setup([chat('1', { status: 'handing-over' })], 0);
    setTimeout(() => Object.assign(chats[0].tab, { status: 'closed' }), 30);
    expect(await closeCheck(deps)).toBe('proceed');
    expect(deps.handOver).not.toHaveBeenCalled();
  });

  it('Hand over: a failed hand-over aborts the quit and names the chat', async () => {
    const { deps } = setup([chat('1'), chat('2', { agent: 'bea', persona: 'Bea' })], 0, { failHandOver: ['2'] });
    expect(await closeCheck(deps)).toBe('stay');
    expect(deps.failed).toHaveBeenCalledTimes(1);
    expect(deps.failed).toHaveBeenCalledWith('o1', 'ACME: Bea could not hand over, so the app did not quit. Check that chat.');
  });

  it('Hand over: a handOver call that throws aborts the quit', async () => {
    const { deps } = setup([chat('1')], 0);
    deps.handOver.mockRejectedValueOnce(new Error('not open'));
    expect(await closeCheck(deps)).toBe('stay');
    expect(deps.failed).toHaveBeenCalledTimes(1);
  });

  it('Hand over: gives up after the maximum wait', async () => {
    const { deps } = setup([chat('1')], 0);
    deps.handOver.mockImplementation(async () => undefined);
    deps.chats = () => [chat('1', { status: 'handing-over' })];
    deps.maxWaitMs = 30;
    expect(await closeCheck(deps)).toBe('stay');
    expect(deps.failed).toHaveBeenCalledTimes(1);
  });

  it('Quit without handover: closes each open pending tab, then proceeds; no hand-over', async () => {
    const { deps, chats } = setup([chat('1'), chat('2', { agent: 'bea' }), chat('3', { notePath: 'inbox/a.md' })], 1);
    expect(await closeCheck(deps)).toBe('proceed');
    expect(deps.closeQuiet.mock.calls).toEqual([['o1', '1'], ['o1', '2'], ['o1', '3']]);
    expect(deps.handOver).not.toHaveBeenCalled();
    expect(chats.map((c) => c.tab.status)).toEqual(['closed', 'closed', 'closed']);
  });

  it('Cancel: nothing happens, the app stays', async () => {
    const { deps, chats } = setup([chat('1')], 2);
    expect(await closeCheck(deps)).toBe('stay');
    expect(deps.handOver).not.toHaveBeenCalled();
    expect(deps.closeQuiet).not.toHaveBeenCalled();
    expect(deps.failed).not.toHaveBeenCalled();
    expect(chats[0].tab.status).toBe('open');
  });

  it('works across orgs', async () => {
    const { deps } = setup([chat('1'), chat('2', {}, { orgId: 'o2', orgName: 'BOLT', cosName: 'Zed' })], 1);
    expect(await closeCheck(deps)).toBe('proceed');
    expect(deps.closeQuiet.mock.calls).toEqual([['o1', '1'], ['o2', '2']]);
  });
});

describe('closeCheck progress box', () => {
  it('shows the progress box during the wait and aborts its signal when the wait is over', async () => {
    const { deps } = setup([chat('1')], 0);
    let signal: AbortSignal | undefined;
    const progress = vi.fn((_d: unknown, sig: AbortSignal) => {
      signal = sig;
      return new Promise<'cancel'>((resolve) => sig.addEventListener('abort', () => resolve('cancel')));
    });
    expect(await closeCheck({ ...deps, progress })).toBe('proceed');
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress.mock.calls[0][0]).toMatchObject({ message: 'Handing over…', cancel: 'Cancel quit' });
    expect(signal?.aborted).toBe(true);
    expect(deps.failed).not.toHaveBeenCalled();
  });

  it('Cancel quit stops the wait and stays, with no failure notice; the running hand-overs are not touched', async () => {
    const { deps, chats } = setup([chat('1')], 0);
    deps.handOver.mockImplementation(async (_o: string, tabId: string) => {
      chats.find((c) => c.tab.tabId === tabId)!.tab.status = 'handing-over';
    });
    let cancel!: () => void;
    const progress = (_d: unknown, sig: AbortSignal) =>
      new Promise<'cancel'>((resolve) => {
        cancel = () => resolve('cancel');
        sig.addEventListener('abort', () => resolve('cancel'));
      });
    const run = closeCheck({ ...deps, progress });
    await new Promise((r) => setTimeout(r, 30));
    cancel();
    expect(await run).toBe('stay');
    expect(deps.failed).not.toHaveBeenCalled();
    expect(deps.closeQuiet).not.toHaveBeenCalled();
    expect(chats[0].tab.status).toBe('handing-over'); // still running: nothing was killed or reset
  });

  it('a failed hand-over still reports and aborts the box', async () => {
    const { deps } = setup([chat('1')], 0, { failHandOver: ['1'] });
    let aborted = false;
    const progress = (_d: unknown, sig: AbortSignal) => new Promise<'cancel'>((resolve) => sig.addEventListener('abort', () => ((aborted = true), resolve('cancel'))));
    expect(await closeCheck({ ...deps, progress })).toBe('stay');
    expect(deps.failed).toHaveBeenCalledTimes(1);
    expect(aborted).toBe(true);
  });
});

describe('safeCloseCheck', () => {
  it('an error in the check (or its dialog) means proceed: the app can always quit', async () => {
    const { deps } = setup([chat('1')], 0);
    deps.ask.mockRejectedValue(new Error('dialog failed'));
    const log = vi.fn();
    expect(await safeCloseCheck(deps, log)).toBe('proceed');
    expect(log).toHaveBeenCalled();
    const boom = { ...deps, chats: () => { throw new Error('no sessions'); } };
    expect(await safeCloseCheck(boom, log)).toBe('proceed');
  });

  it('passes the result of a normal check through', async () => {
    const { deps } = setup([chat('1')], 2);
    expect(await safeCloseCheck(deps, vi.fn())).toBe('stay');
  });
});
