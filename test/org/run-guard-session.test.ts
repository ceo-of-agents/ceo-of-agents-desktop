// The run guard over real OrgSessions (fake claude processes): what counts as running, the forced stop and its
// lines in the chief of staff thread, waiting for the work (and the report turn) to end, and two orgs side by side.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeEvent } from '../../src/main/claude/stream';
import { OrgSession, type OrgSessionDeps } from '../../src/main/org/org-session';
import { RunGuard, type GuardChoice, type GuardScope, type RunningItem } from '../../src/main/org/run-guard';
import type { AppEvent } from '../../src/shared/types';
import { fakeFactory, waitFor } from './helpers';

const orgYaml = (name: string, cos: string) => `org:
  id: T
  name: ${name}
cos:
  display_name: "${cos}"
departments:
  - id: engineering
    agent: max
    display_name: Max
`;
const CLAUDE_MD = `# Test

| Agent | Name | Role | Id | Use for |
|---|---|---|---|---|
| max | Max | Engineering | engineering | Code |
`;

let root: string;
const sessions: OrgSession[] = [];
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-guard-'));
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((o) => o.stopAll()));
  fs.rmSync(root, { recursive: true, force: true });
});

interface Rig {
  id: string;
  name: string;
  org: OrgSession;
  events: AppEvent[];
  factory: ReturnType<typeof fakeFactory>;
  settings: { permissionMode: string; effort: string; cosModel: string };
}

const changeHooks: Array<() => void> = [];
function makeOrg(id: string, name: string, cosName: string, env: Parameters<typeof fakeFactory>[1] = {}): Rig {
  const hq = path.join(root, `hq-${id}`);
  fs.mkdirSync(path.join(hq, 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(hq, 'org.yaml'), orgYaml(name, cosName));
  fs.writeFileSync(path.join(hq, 'CLAUDE.md'), CLAUDE_MD);
  const events: AppEvent[] = [];
  const settings = { permissionMode: 'default', effort: 'high', cosModel: 'opus' };
  const deps: OrgSessionDeps = {
    claudePath: () => 'claude',
    settings: () => settings as never,
    broker: { register: () => '{}', unregister: vi.fn() } as never,
    serverScript: 'server.js',
    nodePath: process.execPath,
    canStart: () => null,
    emit: (e) => events.push(e),
    onRunningChange: () => changeHooks.forEach((f) => f()),
  };
  const org = new OrgSession(id, hq, path.join(root, `data-${id}`), deps);
  sessions.push(org);
  const factory = fakeFactory(hq, env);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (org as any).makeSession = (threadId: string, resumeId: string | null) => {
    // What the real makeSession records, so `needsRestart` can tell that the settings changed since this process started.
    const d = (org as any).ruleDetail(null);
    (org as any).runs.set(threadId, { ...(org as any).runFor(null, threadId), rules: { allow: d.allow, deny: d.deny }, locked: d.locked, keptOut: d.keptOut, permissionMode: settings.permissionMode });
    return factory.makeSession(resumeId);
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return { id, name, org, events, factory, settings };
}

const tracker = (o: OrgSession) => (o as any).tracker as { handle(ev: ClaudeEvent): void }; // eslint-disable-line @typescript-eslint/no-explicit-any
const startBackground = (o: OrgSession, id: string, description: string) => {
  tracker(o).handle({ kind: 'tool-use', id, name: 'Agent', input: { subagent_type: 'max', description, run_in_background: true } });
  tracker(o).handle({ kind: 'task-started', toolUseId: id, taskId: `task-${id}`, agent: 'max', description, background: true });
};
const endBackground = (o: OrgSession, id: string) => tracker(o).handle({ kind: 'task-ended', toolUseId: id, taskId: `task-${id}`, status: 'completed', notification: true, topLevel: true, background: true });
const systemLines = (o: OrgSession) => o.cos.info().entries.filter((e) => e.kind === 'system').map((e) => e.text);

function guardOver(rigs: Rig[], choice: { value: GuardChoice }) {
  const asked: Array<{ message: string; scope: GuardScope }> = [];
  const itemsOf = (scope: GuardScope): RunningItem[] => rigs.filter((r) => scope === 'all' || r.id === scope).flatMap((r) => r.org.runningItems(r.name));
  const guard: RunGuard = new RunGuard({
    items: itemsOf,
    ask: async (text, scope) => {
      asked.push({ message: text.message, scope });
      return choice.value;
    },
    forceStop: (orgId, label) => rigs.find((r) => r.id === orgId)!.org.forceStop(label),
    notePending: (orgId, text) => rigs.find((r) => r.id === orgId)!.org.noteInCos(text),
    settleMs: 10,
  });
  changeHooks.length = 0;
  changeHooks.push(() => guard.changed());
  return { guard, asked };
}

describe('OrgSession running work', () => {
  it('lists each running dispatch, and the chief of staff while it replies', async () => {
    const a = makeOrg('a', 'Acme', 'Ada', { FAKE_DELAY_MS: '300' });
    expect(a.org.runningItems('Acme')).toEqual([]);
    startBackground(a.org, 'tu1', 'Fix app issues');
    a.org.send('cos', 'hello');
    await waitFor(() => a.org.cos.busy);
    const items = a.org.runningItems('Acme');
    expect(items.map((i) => [i.kind, i.who, i.what])).toEqual([['dispatch', 'Max', 'Fix app issues'], ['cos-turn', 'Ada', 'replying']]);
    expect(items.every((i) => i.orgId === 'a' && i.orgName === 'Acme')).toBe(true);
    await waitFor(() => !a.org.cos.busy);
    expect(a.org.runningItems('x').map((i) => i.kind)).toEqual(['dispatch']);
    endBackground(a.org, 'tu1');
    expect(a.org.runningItems('x')).toEqual([]);
  });

  it('forceStop: dispatches become stopped, one "was stopped by" line each plus one for the reply, the process ends with the messages not answered', async () => {
    const a = makeOrg('a', 'Acme', 'Ada', { FAKE_DELAY_MS: '300', FAKE_REPLY: 'second answer' });
    startBackground(a.org, 'tu1', 'Fix app issues');
    a.org.send('cos', 'first');
    await waitFor(() => a.org.cos.busy);
    a.org.send('cos', 'second');
    await a.org.forceStop('Update');
    const d = a.org.dispatches()[0];
    expect(d.state).toBe('stopped');
    expect(d.endedAt).not.toBeNull();
    expect(JSON.parse(fs.readFileSync(path.join(root, 'data-a', 'dispatches.json'), 'utf8'))[0].state).toBe('stopped');
    expect(systemLines(a.org)).toEqual(["Max's run 'Fix app issues' was stopped by Update", "Ada's reply was stopped by Update"]);
    expect(a.org.cos.busy).toBe(false);
    expect(a.org.cos.sessionId).toBeNull();
    expect(a.org.runningItems('x')).toEqual([]);
    await new Promise((r) => setTimeout(r, 150));
    expect(a.factory.sessions).toHaveLength(1); // nothing was sent on its own
    expect(a.org.cos.info().entries.filter((e) => e.kind === 'assistant')).toEqual([]);
  });

  it('forceStop with only a background dispatch (the chief of staff idle) writes the dispatch line only', async () => {
    const a = makeOrg('a', 'Acme', 'Ada');
    a.org.send('cos', 'hi');
    await waitFor(() => a.org.cos.info().entries.some((e) => e.kind === 'assistant'));
    startBackground(a.org, 'tu1', '');
    await a.org.forceStop('Quit');
    expect(systemLines(a.org)).toEqual(["Max's run was stopped by Quit"]);
  });
});

describe('department chat dispatches', () => {
  /** Opens a chat with `max`, lets its process start, and returns the thread key and a way to feed its stream. */
  async function openTab(a: Rig) {
    const tab = a.org.startTab('max');
    const key = `tab:${tab.tabId}` as const;
    a.org.send(key, 'hello');
    await waitFor(() => a.factory.sessions.length === 1 && !a.org.thread(key)!.busy && a.org.thread(key)!.info().entries.some((e) => e.kind === 'assistant'));
    const stream = (ev: ClaudeEvent) => a.factory.sessions[0].emit('stream', ev);
    return { tab, key, stream };
  }
  const agentCall = (id: string, agent: string, description: string, background: boolean): ClaudeEvent => ({ kind: 'tool-use', id, name: 'Agent', input: { subagent_type: agent, description, run_in_background: background } });
  const lines = (th: { info(): { entries: Array<{ kind: string; text: string }> } }) => th.info().entries.filter((e) => e.kind === 'system').map((e) => e.text);

  it('the Agent calls of a chat are tracked from its stream, as "Max → worker", and count as running work', async () => {
    const a = makeOrg('a', 'Acme', 'Ada');
    const { stream } = await openTab(a);
    stream(agentCall('w1', 'worker', 'Check the docs', true));
    stream({ kind: 'task-started', toolUseId: 'w1', taskId: 'ag-w1', agent: 'worker', description: 'Check the docs', background: true });
    expect(a.org.dispatches()).toMatchObject([{ id: 'w1', name: 'Max → worker', state: 'running', by: { departmentId: 'engineering', name: 'Max' } }]);
    expect(a.org.runningItems('Acme').map((i) => [i.kind, i.who, i.what])).toEqual([['dispatch', 'Max → worker', 'Check the docs']]);
    stream({ kind: 'task-ended', toolUseId: 'w1', taskId: 'ag-w1', status: 'completed', notification: true, topLevel: true, background: true });
    expect(a.org.dispatches()[0].state).toBe('done');
    expect(a.org.runningItems('x')).toEqual([]);
  });

  it('forceStop stops the sub-agents of a chat, writes the line in the thread of that chat (not the chief of staff thread) and ends its process', async () => {
    const a = makeOrg('a', 'Acme', 'Ada');
    const { key, stream } = await openTab(a);
    stream(agentCall('w1', 'worker', 'Check the docs', true));
    stream(agentCall('w2', 'reader', '', true));
    startBackground(a.org, 'tu1', 'Fix app issues');
    await a.org.forceStop('Update');
    expect(a.org.dispatches().map((d) => [d.id, d.state])).toEqual([['w1', 'stopped'], ['w2', 'stopped'], ['tu1', 'stopped']]);
    expect(lines(a.org.thread(key)!)).toEqual(["Max → worker's run 'Check the docs' was stopped by Update", "Max → reader's run was stopped by Update"]);
    expect(systemLines(a.org)).toEqual(["Max's run 'Fix app issues' was stopped by Update"]);
    expect(a.org.thread(key)!.sessionId).toBeNull();
    expect(a.org.runningItems('x')).toEqual([]);
  });

  it('closing the chat stops its sub-agents and drops them from the list; those of the chief of staff stay', async () => {
    const a = makeOrg('a', 'Acme', 'Ada');
    const { tab, stream } = await openTab(a);
    stream(agentCall('w1', 'worker', 'Check the docs', true));
    startBackground(a.org, 'tu1', 'Fix app issues');
    expect(a.org.dispatches()).toHaveLength(2);
    await a.org.closeTab(tab.tabId, { passNote: false });
    expect(a.org.dispatches().map((d) => d.id)).toEqual(['tu1']);
    // late events of the killed process make nothing
    stream(agentCall('w2', 'worker', 'Late', false));
    expect(a.org.dispatches().map((d) => d.id)).toEqual(['tu1']);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'data-a', 'dispatches.json'), 'utf8')).map((d: { id: string }) => d.id)).toEqual(['tu1']);
  });

  it('the process exit of a chat makes its running sub-agents unknown, not those of the chief of staff', async () => {
    const a = makeOrg('a', 'Acme', 'Ada');
    const { key, stream } = await openTab(a);
    stream(agentCall('w1', 'worker', 'Check the docs', true));
    startBackground(a.org, 'tu1', 'Fix app issues');
    await a.org.thread(key)!.interrupt();
    expect(a.org.dispatches().map((d) => [d.id, d.state])).toEqual([['w1', 'unknown'], ['tu1', 'running']]);
  });

  it('a chat with a background sub-agent keeps its process through a changed effort, like the chief of staff', async () => {
    const a = makeOrg('a', 'Acme', 'Ada');
    const { key, stream } = await openTab(a);
    stream(agentCall('w1', 'worker', 'Check the docs', true));
    a.settings.effort = 'low';
    a.org.send(key, 'again');
    await waitFor(() => a.org.thread(key)!.info().entries.filter((e) => e.kind === 'assistant').length >= 2 && !a.org.thread(key)!.busy);
    expect(a.factory.sessions).toHaveLength(1);
    stream({ kind: 'task-ended', toolUseId: 'w1', taskId: 'ag-w1', status: 'completed', notification: true, topLevel: true, background: true });
    a.org.send(key, 'third');
    await waitFor(() => a.factory.sessions.length === 2);
  });
});

describe('implicit restarts while background work runs', () => {
  it('a changed effort does not replace the chief of staff process until the background dispatch has ended', async () => {
    const a = makeOrg('a', 'Acme', 'Ada');
    const say = async (text: string, n: number) => {
      a.org.send('cos', text);
      await waitFor(() => a.org.cos.info().entries.filter((e) => e.kind === 'assistant').length >= n && !a.org.cos.busy);
    };
    await say('one', 1);
    startBackground(a.org, 'tu1', 'Fix app issues');
    a.settings.effort = 'low';
    await say('two', 2);
    expect(a.factory.sessions).toHaveLength(1);
    expect(a.org.dispatches()[0].state).toBe('running');
    endBackground(a.org, 'tu1');
    await say('three', 3);
    expect(a.factory.sessions).toHaveLength(2);
    expect(a.factory.resumeIds[1]).toBe('sid-1');
  });
});

describe('guarded actions with a running dispatch', () => {
  it('nothing running: no dialog, the action runs at once', async () => {
    const a = makeOrg('a', 'Acme', 'Ada');
    const { guard, asked } = guardOver([a], { value: 'cancel' });
    const fn = vi.fn();
    expect(await guard.run('a', 'Update', fn)).toBe('done');
    expect(asked).toEqual([]);
    expect(fn).toHaveBeenCalled();
  });

  it('wait: queued with a line in the thread; runs once the dispatch has ended and the report turn is over', async () => {
    const a = makeOrg('a', 'Acme', 'Ada', { FAKE_DELAY_MS: '250' });
    startBackground(a.org, 'tu1', 'Fix app issues');
    const { guard, asked } = guardOver([a], { value: 'wait' });
    const fn = vi.fn();
    expect(await guard.run('a', 'Update', fn)).toBe('queued');
    expect(asked[0].message).toBe('Max is still working on: Fix app issues (0 s)');
    expect(systemLines(a.org)).toEqual(['Update will run when this work has finished.']);
    // The dispatch ends and the chief of staff starts its report turn: the action keeps waiting for that turn.
    a.org.send('cos', 'report');
    await waitFor(() => a.org.cos.busy);
    endBackground(a.org, 'tu1');
    await new Promise((r) => setTimeout(r, 100));
    expect(fn).not.toHaveBeenCalled();
    await waitFor(() => !a.org.cos.busy);
    await waitFor(() => fn.mock.calls.length > 0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('wait cannot hang: a report that never comes is given up, then the action runs', async () => {
    const a = makeOrg('a', 'Acme', 'Ada');
    a.org.send('cos', 'hello');
    await waitFor(() => a.org.cos.busy);
    await waitFor(() => !a.org.cos.busy);
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const s = a.factory.sessions[0] as any;
    s.o.reportIdleMs = 150;
    // A background agent's notification with no report turn after it.
    s.handleEvents([{ kind: 'task-ended', toolUseId: 'tu9', taskId: 't9', status: 'completed', notification: true, topLevel: true, background: true }]);
    /* eslint-enable @typescript-eslint/no-explicit-any */
    expect(a.org.cos.awaitingReport).toBe(true);
    const { guard } = guardOver([a], { value: 'wait' });
    const fn = vi.fn();
    expect(await guard.run('a', 'Update', fn)).toBe('queued');
    await waitFor(() => fn.mock.calls.length > 0, 3000);
    expect(a.org.cos.awaitingReport).toBe(false);
  });

  it('stop: dispatch marked stopped, the line written, then the action runs', async () => {
    const a = makeOrg('a', 'Acme', 'Ada');
    startBackground(a.org, 'tu1', 'Fix app issues');
    const { guard } = guardOver([a], { value: 'stop' });
    const seen: string[] = [];
    const fn = vi.fn(() => {
      seen.push(a.org.dispatches()[0].state, ...systemLines(a.org));
    });
    expect(await guard.run('a', 'Apply settings', fn)).toBe('done');
    expect(seen).toEqual(['stopped', "Max's run 'Fix app issues' was stopped by Apply settings"]);
  });

  it('cancel: nothing runs, the dispatch keeps running', async () => {
    const a = makeOrg('a', 'Acme', 'Ada');
    startBackground(a.org, 'tu1', 'Fix app issues');
    const { guard } = guardOver([a], { value: 'cancel' });
    const fn = vi.fn();
    expect(await guard.run('a', 'Update', fn)).toBe('cancelled');
    expect(fn).not.toHaveBeenCalled();
    expect(a.org.dispatches()[0].state).toBe('running');
    expect(systemLines(a.org)).toEqual([]);
  });
});

describe('guarded actions with two orgs running work', () => {
  it('an org-scoped action in A lists only A and leaves B running; quit lists both, grouped', async () => {
    const a = makeOrg('a', 'Acme', 'Ada');
    const b = makeOrg('b', 'Other Org', 'Rita');
    startBackground(a.org, 'tu1', 'Fix app issues');
    startBackground(b.org, 'tu2', 'Write the report');
    const choice: { value: GuardChoice } = { value: 'stop' };
    const { guard, asked } = guardOver([a, b], choice);

    const update = vi.fn();
    await guard.run('a', 'Update', update);
    expect(update).toHaveBeenCalled();
    expect(asked[0].message).toBe('Max is still working on: Fix app issues (0 s)');
    expect(asked[0].message).not.toMatch(/report|Other Org/);
    expect(a.org.dispatches()[0].state).toBe('stopped');
    expect(b.org.dispatches()[0].state).toBe('running');
    expect(systemLines(b.org)).toEqual([]);

    startBackground(a.org, 'tu3', 'Second task');
    choice.value = 'cancel';
    await guard.run('all', 'Quit', vi.fn());
    expect(asked[1].scope).toBe('all');
    expect(asked[1].message.split('\n')).toEqual(['Acme: Max, Second task (0 s)', 'Other Org: Max, Write the report (0 s)']);
  });

  it('quit waits until neither org has work', async () => {
    const a = makeOrg('a', 'Acme', 'Ada');
    const b = makeOrg('b', 'Other Org', 'Rita');
    startBackground(a.org, 'tu1', 'One');
    startBackground(b.org, 'tu2', 'Two');
    const { guard } = guardOver([a, b], { value: 'wait' });
    const quit = vi.fn();
    expect(await guard.run('all', 'Quit', quit, { pendingText: 'The app will quit when this work has finished.' })).toBe('queued');
    expect(systemLines(a.org)).toEqual(['The app will quit when this work has finished.']);
    expect(systemLines(b.org)).toEqual(['The app will quit when this work has finished.']);
    endBackground(a.org, 'tu1');
    await new Promise((r) => setTimeout(r, 100));
    expect(quit).not.toHaveBeenCalled();
    endBackground(b.org, 'tu2');
    await waitFor(() => quit.mock.calls.length > 0);
  });
});
