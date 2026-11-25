import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrgSession, type OrgSessionDeps } from '../../src/main/org/org-session';
import type { AppEvent, TabInfo } from '../../src/shared/types';
import { SessionStore } from '../../src/main/claude/session-store';
import { fakeFactory, waitFor } from './helpers';
import { attachment, imageBytes, sha256 } from '../helpers-images';
import { lastUserText } from '../../src/renderer/thread-logic';

const ORG_YAML = `org:
  id: T
  name: Test Org
cos:
  display_name: "Ada"
departments:
  - id: engineering
    agent: max
    display_name: Max
  - id: design-brand
    agent: bea
    display_name: Bea
`;
const CLAUDE_MD = `# Test

| Agent | Name | Role | Id | Use for |
|---|---|---|---|---|
| max | Max | Engineering | engineering | Code |
| bea | Bea | Design and brand | design-brand | Identity |
`;

let root: string;
let hq: string;
let data: string;
const orgs: OrgSession[] = [];
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-org-'));
  hq = path.join(root, 'hq');
  data = path.join(root, 'data');
  fs.mkdirSync(path.join(hq, 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(hq, 'org.yaml'), ORG_YAML);
  fs.writeFileSync(path.join(hq, 'CLAUDE.md'), CLAUDE_MD);
});
afterEach(async () => {
  await Promise.all(orgs.splice(0).map((o) => o.stopAll()));
  fs.rmSync(root, { recursive: true, force: true });
});

function setup(env: Parameters<typeof fakeFactory>[1] = {}) {
  const events: AppEvent[] = [];
  const unregister = vi.fn();
  const onHandoff = vi.fn();
  const deps: OrgSessionDeps = {
    claudePath: () => 'claude',
    settings: () => ({ permissionMode: 'default', effort: 'high', cosModel: 'opus' }) as never,
    broker: { register: () => '{}', unregister } as never,
    serverScript: 'server.js',
    nodePath: process.execPath,
    canStart: () => null,
    emit: (e) => events.push(e),
    onHandoff,
  };
  const org = new OrgSession('o1', hq, data, deps);
  orgs.push(org);
  // Tool results are on by default: only a tool call with a successful result counts for a handoff note.
  const withResults = (e: Record<string, string>) => ({ FAKE_TOOL_RESULTS: '1', ...e });
  const factory = fakeFactory(hq, typeof env === 'function' ? (n: number, r: string | null) => withResults(env(n, r)) : withResults(env));
  // Replace the private process factory: the fake claude instead of the real binary.
  (org as any).makeSession = (_threadId: string, resumeId: string | null) => factory.makeSession(resumeId); // eslint-disable-line @typescript-eslint/no-explicit-any
  return { org, events, unregister, onHandoff, factory };
}

const readTabs = (): TabInfo[] => JSON.parse(fs.readFileSync(path.join(data, 'tabs.json'), 'utf8'));
const NOTE = 'inbox/2026-01-01-x-to-cos-y.md';
const NOTE_TEXT = '---\nfrom: max\n---\n# Heading\n\n## Ask or finding\n\nPlease merge PR 7\n';
const NOTE_BEA = NOTE_TEXT.replace('from: max', 'from: bea');
/** Writes an inbox note that is older than any chat opened now (an hour), so it is not "written since the chat opened". */
const writeOldNote = (file: string, text: string): void => {
  fs.writeFileSync(path.join(hq, file), text);
  const old = new Date(Date.now() - 3_600_000);
  fs.utimesSync(path.join(hq, file), old, old);
};

describe('OrgSession tabs', () => {
  it('startTab records persona and role from the hq and persists tabs.json', () => {
    const { org, events } = setup();
    const rec = org.startTab('max');
    expect(rec).toMatchObject({ orgId: 'o1', agent: 'max', persona: 'Max', role: 'Engineering', status: 'open', closedAt: null, notePath: null });
    expect(rec.tabId).toMatch(/^[0-9a-f]{12}$/);
    expect(Number.isNaN(Date.parse(rec.openedAt))).toBe(false);
    expect(readTabs()).toEqual([rec]);
    expect(org.listTabs()).toEqual([rec]);
    const bea = org.startTab('bea');
    expect(bea.role).toBe('Design and brand');
    expect(org.listTabs().map((t) => t.agent)).toEqual(['max', 'bea']);
    expect(org.getThread(`tab:${rec.tabId}`)?.title).toBe('Max (Engineering)');
    expect(events).toEqual([]);
  });

  it('listTabs returns copies; tabs reload from tabs.json', () => {
    const { org } = setup();
    const rec = org.startTab('max');
    org.listTabs()[0].status = 'closed';
    expect(org.listTabs()[0].status).toBe('open');
    const again = new OrgSession('o1', hq, data, (org as any).deps); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(again.listTabs()).toEqual([rec]);
  });

  it('an unknown agent throws', () => {
    const { org } = setup();
    expect(() => org.startTab('nobody')).toThrow(/No department with agent "nobody"/);
    expect(org.listTabs()).toEqual([]);
  });

  it('getThread: cos title, unknown thread is null', () => {
    const { org } = setup();
    expect(org.getThread('cos')?.title).toBe('Ada (Chief of Staff)');
    expect(org.getThread('cos')?.speaker).toBe('Ada');
    expect(org.getThread('tab:nope')).toBeNull();
  });

  it('send routes a user message to the thread and gets a reply', async () => {
    const { org } = setup({ FAKE_REPLY: 'pong' });
    org.send('cos', 'ping');
    await waitFor(() => org.cos.info().entries.some((e) => e.kind === 'assistant'));
    expect(org.cos.info().entries.map((e) => [e.kind, e.text])).toEqual([['session', ''], ['user', 'ping'], ['assistant', 'pong']]);
    expect(() => org.send('tab:nope', 'x')).toThrow(/Unknown conversation/);
  });

  it('the chief of staff starts a new session in a new app run, even with an id stored for today; a tab resumes its stored id', async () => {
    const first = setup({ FAKE_SID: 'S-COS' });
    first.org.send('cos', 'one');
    await waitFor(() => first.org.cos.info().entries.some((e) => e.kind === 'assistant'));
    expect(first.factory.resumeIds).toEqual([null]);
    await first.org.stopAll();
    const second = setup({ FAKE_SID: 'S-COS-2' });
    second.org.send('cos', 'two');
    await waitFor(() => second.org.cos.info().entries.filter((e) => e.kind === 'assistant').length === 2);
    expect(second.factory.resumeIds).toEqual([null]);
    expect(second.org.cos.info().entries.filter((e) => e.kind === 'session')).toHaveLength(2);
    const tab = second.org.startTab('max');
    new SessionStore(path.join(data, 'sessions.json')).set(`tab:${tab.tabId}`, 'S-TAB', '2020-01-01');
    second.org.send(`tab:${tab.tabId}`, 'hi');
    await waitFor(() => second.factory.resumeIds.length === 2);
    expect(second.factory.resumeIds).toEqual([null, 'S-TAB']);
  });

  it('newCosSession asks the chief of staff for a new session once', async () => {
    const { org } = setup({ FAKE_SID: 'S-COS' });
    org.send('cos', 'one');
    await waitFor(() => org.cos.info().entries.some((e) => e.kind === 'assistant'));
    expect(org.newCosSession()).toBe(true);
    expect(org.newCosSession()).toBe(false);
    expect(org.cos.info().entries.at(-1)).toMatchObject({ kind: 'system', text: 'Your next message starts a new session: Ada reads the hq again.' });
  });

  it('the chief of staff holdRestart holds a new session while a report on a background agent is to come', async () => {
    const { org, factory } = setup({ FAKE_SID: 'S-COS' });
    org.send('cos', 'one');
    await waitFor(() => org.cos.info().entries.some((e) => e.kind === 'assistant'));
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const s = factory.sessions[0] as any;
    s.o.reportIdleMs = 400;
    // A background agent's notification with no report turn after it yet.
    s.handleEvents([{ kind: 'task-ended', toolUseId: 'tu9', taskId: 't9', status: 'completed', notification: true, topLevel: true, background: true }]);
    /* eslint-enable @typescript-eslint/no-explicit-any */
    expect(org.cos.awaitingReport).toBe(true);
    expect(org.newCosSession()).toBe(true);
    org.send('cos', 'two');
    await waitFor(() => org.cos.info().entries.filter((e) => e.kind === 'assistant').length === 2);
    expect(factory.sessions).toHaveLength(1);
    expect(org.cos.info().entries.filter((e) => e.kind === 'session')).toHaveLength(1);
    expect(org.cos.info().entries.some((e) => e.kind === 'system' && e.text.startsWith('Work is still running'))).toBe(true);
    // the report never comes and is given up: the next message starts the new session
    await waitFor(() => !org.cos.awaitingReport, 3000);
    org.send('cos', 'three');
    await waitFor(() => org.cos.info().entries.filter((e) => e.kind === 'assistant').length === 3);
    expect(factory.resumeIds).toEqual([null, null]);
    expect(org.cos.info().entries.filter((e) => e.kind === 'session')).toHaveLength(2);
  });
});

describe('OrgSession hand-over', () => {
  it('handing-over, then closed with the note, a handoff card for the CoS, unregister and onHandoff', async () => {
    const tools = [{ name: 'Write', input: { file_path: path.join(hq, NOTE) }, write: NOTE_TEXT }];
    const { org, unregister, onHandoff } = setup((n) => ({ FAKE_TOOLS: JSON.stringify(n === 0 ? tools : []), FAKE_REPLY: n === 0 ? NOTE : 'processed', FAKE_SID: `S${n}` }));
    const rec = org.startTab('max');
    await org.handOver(rec.tabId);
    expect(org.listTabs()[0].status).toBe('handing-over');
    expect(readTabs()[0].status).toBe('handing-over');
    await waitFor(() => org.listTabs()[0].status === 'closed' && org.cos.info().entries.some((e) => e.kind === 'assistant'));

    const closed = org.listTabs()[0];
    expect(closed.notePath).toBe(NOTE);
    expect(closed.closedAt).not.toBeNull();
    expect(readTabs()[0]).toMatchObject({ status: 'closed', notePath: NOTE });
    expect(unregister).toHaveBeenCalledWith(`o1|tab:${rec.tabId}`);
    expect(onHandoff).toHaveBeenCalledWith('o1', 'Max');

    const cos = org.cos.info().entries;
    const card = cos.find((e) => e.kind === 'handoff');
    expect(card).toMatchObject({ author: 'Max', text: 'Max handed over: Please merge PR 7' });

    // the chat is over: no live thread of any kind, nothing to read or write
    expect(org.thread(`tab:${rec.tabId}`)).toBeNull();
    expect(org.getThread(`tab:${rec.tabId}`)).toBeNull();
    expect(() => org.send(`tab:${rec.tabId}`, 'late')).toThrow(/Unknown conversation/);
  });

  it('completeHandoff ends the chat like a close: process killed, session cleared, nothing left alive', async () => {
    const tools = [{ name: 'Write', input: { file_path: path.join(hq, NOTE) }, write: NOTE_TEXT }];
    const { org, factory } = setup((n) => ({ FAKE_TOOLS: JSON.stringify(n === 0 ? tools : []), FAKE_REPLY: n === 0 ? NOTE : 'processed', FAKE_SID: `S${n}` }));
    const rec = org.startTab('max');
    await org.handOver(rec.tabId);
    await waitFor(() => org.listTabs()[0].status === 'closed');
    await waitFor(() => !factory.sessions[0].running);
    expect(() => process.kill(factory.pids[0], 0)).toThrow();
    expect(new SessionStore(path.join(data, 'sessions.json')).get(`tab:${rec.tabId}`)).toBeNull();
    expect((org as any).tabs.has(rec.tabId)).toBe(false); // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  it('sends the note text to the CoS', async () => {
    const logFile = path.join(root, 'fake.log');
    const tools = [{ name: 'Write', input: { file_path: path.join(hq, NOTE) }, write: NOTE_TEXT }];
    // call 0 is the tab session, call 1 the CoS session
    const { org } = setup((n) => ({ FAKE_LOG: logFile, FAKE_TOOLS: JSON.stringify(n === 0 ? tools : []), FAKE_SID: `S${n}` }));
    const rec = org.startTab('bea');
    await org.handOver(rec.tabId);
    await waitFor(() => org.cos.info().entries.some((e) => e.kind === 'assistant'));
    const sent = fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l).message.content as string);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatch(/Write your handoff note to Ada/);
    expect(sent[0]).toMatch(/or update the one you already wrote in this chat/);
    expect(sent[0]).toMatch(/following inbox\/README\.md \(its `from` is your department id\)/);
    expect(sent[1]).toContain(`Bea (Design and brand) handed over: ${NOTE}`);
    expect(sent[1]).toContain('Please merge PR 7');
  });

  it('no note found: status returns to open and an error entry is logged', async () => {
    const { org, unregister, onHandoff } = setup({ FAKE_REPLY: 'I have nothing' });
    const rec = org.startTab('max');
    await org.handOver(rec.tabId);
    expect(org.listTabs()[0].status).toBe('handing-over');
    const th = org.thread(`tab:${rec.tabId}`)!;
    await waitFor(() => th.info().entries.some((e) => e.kind === 'error'));
    expect(org.listTabs()[0].status).toBe('open');
    expect(readTabs()[0].status).toBe('open');
    expect(th.info().entries.find((e) => e.kind === 'error')?.text).toMatch(/No handoff note/);
    expect(unregister).not.toHaveBeenCalled();
    expect(onHandoff).not.toHaveBeenCalled();
    expect(org.cos.info().entries).toEqual([]);
  });

  describe('the note is found however the department wrote it', () => {
    const NOTE_ENG = '---\nfrom: engineering\n---\n# Heading\n\n## Ask or finding\n\nPlease merge PR 7\n';
    const endState = async (org: OrgSession, tabId: string) => {
      await waitFor(() => org.listTabs()[0].status !== 'handing-over');
      return org.listTabs().find((r) => r.tabId === tabId)!;
    };

    it('a foreground worker (sub-agent tool calls only) wrote it', async () => {
      const sub = [{ name: 'Write', input: { file_path: path.join(hq, NOTE) }, write: NOTE_ENG }];
      const { org } = setup((n) => ({ FAKE_SUB_TOOLS: n === 0 ? JSON.stringify(sub) : '[]', FAKE_REPLY: n === 0 ? NOTE : 'processed', FAKE_SID: `S${n}` }));
      const rec = org.startTab('max');
      await org.handOver(rec.tabId);
      expect(await endState(org, rec.tabId)).toMatchObject({ status: 'closed', notePath: NOTE });
    });

    it('a background worker writes it after the turn ended (Claude Code reports with a turn of its own)', async () => {
      const bg = { path: path.join(hq, NOTE), content: NOTE_ENG, delayMs: 400 };
      const { org } = setup((n) => ({ FAKE_BG_WRITE: n === 0 ? JSON.stringify(bg) : '', FAKE_REPLY: n === 0 ? 'The worker writes it' : 'processed', FAKE_SID: `S${n}` }));
      const rec = org.startTab('max');
      await org.handOver(rec.tabId);
      expect(await endState(org, rec.tabId)).toMatchObject({ status: 'closed', notePath: NOTE });
    });

    it('it was written with Bash (not a Write tool)', async () => {
      const tools = [{ name: 'Bash', input: { command: `cat > ${NOTE}` }, writePath: path.join(hq, NOTE), write: NOTE_ENG }];
      const { org } = setup((n) => ({ FAKE_TOOLS: n === 0 ? JSON.stringify(tools) : '[]', FAKE_REPLY: n === 0 ? NOTE : 'processed', FAKE_SID: `S${n}` }));
      const rec = org.startTab('max');
      await org.handOver(rec.tabId);
      expect(await endState(org, rec.tabId)).toMatchObject({ status: 'closed', notePath: NOTE });
    });

    it('it was written earlier in this chat (the hand-over turn writes nothing)', async () => {
      const { org } = setup((n) => ({ FAKE_REPLY: n === 0 ? NOTE : 'processed', FAKE_SID: `S${n}` }));
      const rec = org.startTab('max');
      fs.writeFileSync(path.join(hq, NOTE), NOTE_ENG); // after the chat opened
      await org.handOver(rec.tabId);
      expect(await endState(org, rec.tabId)).toMatchObject({ status: 'closed', notePath: NOTE });
    });

    it('the handoff card says "earlier note" when the note was written before the hand-over turn', async () => {
      const early = setup((n) => ({ FAKE_REPLY: n === 0 ? NOTE : 'processed', FAKE_SID: `S${n}` }));
      const rec = early.org.startTab('max');
      fs.writeFileSync(path.join(hq, NOTE), NOTE_ENG);
      await early.org.handOver(rec.tabId);
      await endState(early.org, rec.tabId);
      await waitFor(() => early.org.cos.info().entries.some((e) => e.kind === 'handoff'));
      expect(early.org.cos.info().entries.find((e) => e.kind === 'handoff')?.earlierNote).toBe(true);
    });

    it('the handoff card has no "earlier note" flag when the hand-over turn wrote the note', async () => {
      const w = [{ name: 'Write', input: { file_path: path.join(hq, NOTE) }, write: NOTE_ENG }];
      const now = setup((n) => ({ FAKE_TOOLS: n === 0 ? JSON.stringify(w) : '[]', FAKE_REPLY: n === 0 ? NOTE : 'processed', FAKE_SID: `S${n}` }));
      const rec2 = now.org.startTab('max');
      await now.org.handOver(rec2.tabId);
      await endState(now.org, rec2.tabId);
      await waitFor(() => now.org.cos.info().entries.some((e) => e.kind === 'handoff'));
      expect(now.org.cos.info().entries.find((e) => e.kind === 'handoff')?.earlierNote).toBeFalsy();
    });

    it('background work that never writes the note: the wait ends, the tab is open again and the error offers "ask for the note"', async () => {
      const bg = { path: path.join(hq, NOTE), content: NOTE_ENG, delayMs: 20_000 };
      const { org } = setup({ FAKE_BG_WRITE: JSON.stringify(bg), FAKE_REPLY: 'The worker writes it' });
      (org as any).deps.handoverWaitMs = 300; // eslint-disable-line @typescript-eslint/no-explicit-any
      (org as any).deps.handoverPollMs = 40; // eslint-disable-line @typescript-eslint/no-explicit-any
      const rec = org.startTab('max');
      await org.handOver(rec.tabId);
      const th = org.thread(`tab:${rec.tabId}`)!;
      await waitFor(() => th.info().entries.some((e) => e.kind === 'system' && /background work/.test(e.text)));
      expect(org.listTabs()[0].status).toBe('handing-over');
      await waitFor(() => org.listTabs()[0].status === 'open');
      const entries = th.info().entries;
      expect(entries.filter((e) => e.kind === 'system' && /background work/.test(e.text))).toHaveLength(1);
      const err = entries.filter((e) => e.kind === 'error').at(-1);
      expect(err).toMatchObject({ action: 'askNote' });
      expect(err?.text).toMatch(/No handoff note from Max/);
      expect(org.listTabs()[0].notePath).toBeNull();
      expect(org.cos.info().entries).toEqual([]);
      expect((org as any).handoverTimers.size).toBe(0); // eslint-disable-line @typescript-eslint/no-explicit-any
    });

    it('a hand-over with no note and no work running fails at once, with the "ask for the note" action', async () => {
      const { org } = setup({ FAKE_REPLY: 'nothing' });
      const rec = org.startTab('max');
      await org.handOver(rec.tabId);
      const th = org.thread(`tab:${rec.tabId}`)!;
      await waitFor(() => th.info().entries.some((e) => e.kind === 'error'));
      expect(th.info().entries.find((e) => e.kind === 'error')).toMatchObject({ action: 'askNote' });
      expect(th.info().entries.some((e) => /background work/.test(e.text))).toBe(false);
    });

    it('closing the chat during the wait stops the poll timer', async () => {
      const bg = { path: path.join(hq, NOTE), content: NOTE_ENG, delayMs: 20_000 };
      const { org } = setup({ FAKE_BG_WRITE: JSON.stringify(bg), FAKE_REPLY: 'wait' });
      (org as any).deps.handoverPollMs = 40; // eslint-disable-line @typescript-eslint/no-explicit-any
      const rec = org.startTab('max');
      await org.handOver(rec.tabId);
      await waitFor(() => (org as any).handoverTimers.size === 1); // eslint-disable-line @typescript-eslint/no-explicit-any
      await org.stopAll();
      expect((org as any).handoverTimers.size).toBe(0); // eslint-disable-line @typescript-eslint/no-explicit-any
    });

    it('a note another chat already handed over (its notePath) is never taken', async () => {
      const { org } = setup({ FAKE_REPLY: 'done' });
      const bea = org.startTab('bea');
      const max = org.startTab('max');
      fs.writeFileSync(path.join(hq, NOTE), NOTE_ENG);
      (org as any).records.find((r: TabInfo) => r.tabId === bea.tabId).notePath = NOTE; // eslint-disable-line @typescript-eslint/no-explicit-any
      await org.handOver(max.tabId);
      const th = org.thread(`tab:${max.tabId}`)!;
      await waitFor(() => th.info().entries.some((e) => e.kind === 'error'));
      expect(org.listTabs().find((r) => r.tabId === max.tabId)).toMatchObject({ status: 'open', notePath: null });
    });

    it('a note of another department is never taken', async () => {
      const { org } = setup({ FAKE_REPLY: 'done' });
      const rec = org.startTab('max');
      fs.writeFileSync(path.join(hq, NOTE), NOTE_BEA);
      await org.handOver(rec.tabId);
      expect(await endState(org, rec.tabId)).toMatchObject({ status: 'open', notePath: null });
    });

    it('a note older than the chat is never taken', async () => {
      writeOldNote(NOTE, NOTE_ENG);
      const { org } = setup({ FAKE_REPLY: 'done' });
      const rec = org.startTab('max');
      await org.handOver(rec.tabId);
      expect(await endState(org, rec.tabId)).toMatchObject({ status: 'open', notePath: null });
    });
  });

  it('handOver on a tab that is not open throws', async () => {
    const { org } = setup();
    await expect(org.handOver('nope')).rejects.toThrow(/not open/);
  });
});

describe('OrgSession one open chat per department', () => {
  it('a second startTab for the same agent returns the same tab and starts no second thread', () => {
    const { org } = setup();
    const a = org.startTab('max');
    const b = org.startTab('max');
    expect(b).toEqual(a);
    expect(org.listTabs()).toHaveLength(1);
    expect(readTabs()).toHaveLength(1);
    expect((org as any).tabs.size).toBe(1); // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  it('a chat that is handing over is returned too', () => {
    const { org } = setup();
    const a = org.startTab('max');
    (org as any).records[0].status = 'handing-over'; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(org.startTab('max').tabId).toBe(a.tabId);
    expect(org.listTabs()).toHaveLength(1);
  });

  it('different departments can be open together', () => {
    const { org } = setup();
    const a = org.startTab('max');
    const b = org.startTab('bea');
    expect(a.tabId).not.toBe(b.tabId);
    expect(org.listTabs().map((t) => [t.agent, t.status])).toEqual([['max', 'open'], ['bea', 'open']]);
  });

  it('after a close, startTab opens a fresh chat: new tab, no resume id', async () => {
    const { org, factory } = setup({ FAKE_SID: 'S5' });
    const first = org.startTab('max');
    org.send(`tab:${first.tabId}`, 'one');
    await waitFor(() => org.getThread(`tab:${first.tabId}`)!.entries.some((e) => e.kind === 'assistant'));
    await org.closeTab(first.tabId);
    const second = org.startTab('max');
    expect(second.tabId).not.toBe(first.tabId);
    org.send(`tab:${second.tabId}`, 'two');
    await waitFor(() => factory.resumeIds.length === 2);
    expect(factory.resumeIds).toEqual([null, null]);
    expect(org.listTabs().map((t) => t.status)).toEqual(['closed', 'open']);
  });
});

describe('OrgSession closeTab', () => {
  const key = (id: string) => `o1|tab:${id}`;

  it('kills the process of a busy tab, unregisters it, forgets the session and removes the thread', async () => {
    const { org, events, unregister, factory } = setup({ FAKE_DELAY_MS: '60000', FAKE_SID: 'S9' });
    const rec = org.startTab('max');
    org.send(`tab:${rec.tabId}`, 'work');
    await waitFor(() => factory.sessions.length === 1 && factory.sessions[0].running);
    const session = factory.sessions[0];
    // the session id of the live process is stored once the init message arrived
    await waitFor(() => new SessionStore(path.join(data, 'sessions.json')).get(`tab:${rec.tabId}`)?.sessionId === 'S9');
    await org.closeTab(rec.tabId);
    expect(session.running).toBe(false);
    expect(() => process.kill(factory.pids[0], 0)).toThrow(); // no orphan: the OS process is gone
    expect(unregister).toHaveBeenCalledWith(key(rec.tabId));
    expect(new SessionStore(path.join(data, 'sessions.json')).get(`tab:${rec.tabId}`)).toBeNull();
    expect(org.listTabs()[0]).toMatchObject({ status: 'closed' });
    expect(org.listTabs()[0].closedAt).not.toBeNull();
    expect(org.listTabs()[0]).not.toHaveProperty('hidden');
    expect(readTabs()[0]).toMatchObject({ status: 'closed' });
    expect(events.filter((e) => e.type === 'tabs').length).toBeGreaterThan(0);
    // unreachable: no live thread, nothing to read or write, and no reopen
    expect(org.getThread(`tab:${rec.tabId}`)).toBeNull();
    expect(org.thread(`tab:${rec.tabId}`)).toBeNull();
    expect(() => org.send(`tab:${rec.tabId}`, 'x')).toThrow(/Unknown conversation/);
    expect('reopenTab' in org).toBe(false);
    await expect(org.closeTab(rec.tabId)).rejects.toThrow(/not open/);
  });

  it('an idle tab closes too; the thread log stays on disk', async () => {
    const { org } = setup();
    const rec = org.startTab('max');
    org.send(`tab:${rec.tabId}`, 'hi');
    await waitFor(() => org.getThread(`tab:${rec.tabId}`)!.entries.some((e) => e.kind === 'assistant'));
    await org.closeTab(rec.tabId);
    expect(fs.existsSync(path.join(data, 'tabs', `${rec.tabId}.jsonl`))).toBe(true);
  });

  it('refuses the CoS, unknown tabs and tabs that are handing over', async () => {
    const { org } = setup();
    await expect(org.closeTab('cos')).rejects.toThrow();
    await expect(org.closeTab('nope')).rejects.toThrow();
    const rec = org.startTab('max');
    (org as any).records[0].status = 'handing-over'; // eslint-disable-line @typescript-eslint/no-explicit-any
    await expect(org.closeTab(rec.tabId)).rejects.toThrow(/handing over/);
    expect(org.listTabs()[0].status).toBe('handing-over');
  });

  it('closing without a note tells the chief of staff nothing', async () => {
    const { org, onHandoff } = setup();
    const rec = org.startTab('max');
    await org.closeTab(rec.tabId);
    expect(onHandoff).not.toHaveBeenCalled();
    expect(org.cos.info().entries).toEqual([]);
  });

  it('the broker denies and removes the pending requests of the closed thread (real broker)', async () => {
    const { PermissionBroker } = await import('../../src/main/claude/permissions');
    const broker = new PermissionBroker();
    const resolved: string[] = [];
    broker.on('resolved', (id: string) => resolved.push(id));
    const { org } = setup();
    (org as any).deps.broker = broker; // eslint-disable-line @typescript-eslint/no-explicit-any
    const rec = org.startTab('max');
    const reply = vi.fn();
    broker.register(key(rec.tabId), { serverScript: 's', nodePath: 'n', cwd: hq });
    (broker as any).pendingById.set('r1', { requestId: 'r1', threadKey: key(rec.tabId), toolName: 'Bash', input: {}, summary: '', rule: '', cwd: hq, reply }); // eslint-disable-line @typescript-eslint/no-explicit-any
    await org.closeTab(rec.tabId);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'deny' }));
    expect(broker.pending(key(rec.tabId))).toEqual([]);
    expect(resolved).toEqual(['r1']);
  });
});

describe('OrgSession images', () => {
  it('stores each image once, keeps only ids in the log, and sends content blocks to Claude Code', async () => {
    const logFile = path.join(root, 'stdin.log');
    const { org } = setup({ FAKE_LOG: logFile });
    const img = attachment('image/png');
    org.send('cos', 'what is this?', undefined, [img, img]);
    const entry = org.getThread('cos')!.entries.find((e) => e.kind === 'user')!;
    expect(entry.text).toBe('what is this?');
    expect(entry.images).toEqual([
      { id: sha256(imageBytes('image/png')), mediaType: 'image/png' },
      { id: sha256(imageBytes('image/png')), mediaType: 'image/png' },
    ]);
    // The append-only log has no base64 and the image is stored once.
    expect(fs.readFileSync(path.join(data, 'cos.jsonl'), 'utf8')).not.toContain(img.data);
    expect(fs.readdirSync(path.join(data, 'images'))).toEqual([`${entry.images![0].id}.png`]);
    expect(org.getImage(entry.images![0].id)).toBe(`data:image/png;base64,${img.data}`);
    await org.cos.idle();
    const line = fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))[0];
    expect(line.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: img.data } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: img.data } },
      { type: 'text', text: 'what is this?' },
    ]);
  });

  it('images only: an entry with empty text, no text block', async () => {
    const logFile = path.join(root, 'stdin.log');
    const { org } = setup({ FAKE_LOG: logFile });
    org.send('cos', '', undefined, [attachment('image/gif')]);
    expect(org.getThread('cos')!.entries.find((e) => e.kind === 'user')).toMatchObject({ text: '', images: [{ mediaType: 'image/gif' }] });
    await org.cos.idle();
    const line = fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))[0];
    expect(line.message.content.map((b: { type: string }) => b.type)).toEqual(['image']);
  });

  it('a text-only message has no images field and a plain string content', async () => {
    const logFile = path.join(root, 'stdin.log');
    const { org } = setup({ FAKE_LOG: logFile });
    org.send('cos', 'hi');
    expect(org.getThread('cos')!.entries.find((e) => e.kind === 'user')).not.toHaveProperty('images');
    await org.cos.idle();
    const line = fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))[0];
    expect(line.message.content).toBe('hi');
  });

  it('getImage refuses ids that are not 64 hex characters', () => {
    const { org } = setup();
    expect(org.getImage('../x')).toBeNull();
    expect(org.getImage('a'.repeat(64))).toBeNull();
  });
});

describe('OrgSession files', () => {
  const pdf = { name: 'report.pdf', mediaType: 'application/pdf', data: new Uint8Array(Buffer.from('%PDF-1.4 test')) };
  const clip = { name: 'clip.mp4', mediaType: 'video/mp4', data: new Uint8Array(Buffer.from('not really a video')) };

  it('stores files once, keeps only refs in the log, and gives Claude Code the text with the paths', async () => {
    const logFile = path.join(root, 'stdin.log');
    const { org } = setup({ FAKE_LOG: logFile });
    org.send('cos', 'look at these', undefined, [], [pdf, clip]);
    const entry = org.getThread('cos')!.entries.find((e) => e.kind === 'user')!;
    expect(entry.text).toBe('look at these');
    expect(entry.files).toMatchObject([{ name: 'report.pdf', kind: 'pdf', size: pdf.data.length }, { name: 'clip.mp4', kind: 'video' }]);
    const stored = path.join(data, 'files', entry.files![0].id, 'report.pdf');
    expect(fs.readFileSync(stored, 'utf8')).toBe('%PDF-1.4 test');
    expect(fs.readFileSync(path.join(data, 'cos.jsonl'), 'utf8')).not.toContain('%PDF');
    await org.cos.idle();
    const line = fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))[0];
    expect(typeof line.message.content).toBe('string');
    expect(line.message.content.startsWith('look at these\n\n[The user attached 2 files')).toBe(true);
    expect(line.message.content).toContain(`- report.pdf (pdf, ${pdf.data.length} B): ${stored}`);
    expect(line.message.content).toContain('video: you cannot watch it directly');
  });

  it('a small PDF with a page count also goes as a document block; the note says so; the log holds no bytes', async () => {
    const logFile = path.join(root, 'stdin.log');
    const { org } = setup({ FAKE_LOG: logFile });
    const bytes = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Pages /Count 1 >>\n2 0 obj << /Type /Page >>\n%%EOF');
    org.send('cos', 'summarise', undefined, [], [{ name: 'doc.pdf', mediaType: 'application/pdf', data: new Uint8Array(bytes) }, pdf]);
    const entry = org.getThread('cos')!.entries.find((e) => e.kind === 'user')!;
    expect(fs.readFileSync(path.join(data, 'cos.jsonl'), 'utf8')).not.toContain(bytes.toString('base64'));
    await org.cos.idle();
    const line = fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))[0];
    expect(line.message.content[0]).toEqual({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') }, title: 'doc.pdf' });
    expect(line.message.content).toHaveLength(2);
    const text = line.message.content[1].text as string;
    expect(text.startsWith('summarise\n\n[The user attached 2 files')).toBe(true);
    expect(text).toContain('also attached to this message as a document');
    expect(text).toContain('without the pages parameter');
    expect(entry.text).toBe('summarise');
    expect(entry.files).toHaveLength(2);
  });

  it('files only: an entry with empty text; the retry button is not offered for it', () => {
    const { org } = setup();
    org.send('cos', '', undefined, [], [pdf]);
    const entry = org.getThread('cos')!.entries.find((e) => e.kind === 'user')!;
    expect(entry).toMatchObject({ text: '', files: [{ name: 'report.pdf' }] });
    expect(lastUserText([entry])).toBeNull();
  });

  it('the chats may read the attachment folder without a card, and nothing else outside the hq', () => {
    const { org } = setup();
    const allow = (org as any).ruleDetail(null).allow as string[]; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(allow).toContain(`Read(/${path.join(data, 'files')}/**)`);
    expect(allow.filter((r) => r.startsWith('Read('))).toHaveLength(1);
  });

  it('a file folder no visible thread references is swept after the grace period, a referenced one stays', async () => {
    const { org } = setup();
    (org as any).deps.imageGraceMs = 0; // eslint-disable-line @typescript-eslint/no-explicit-any
    const rec = org.startTab('max');
    org.send(`tab:${rec.tabId}`, 'x', undefined, [], [pdf]);
    org.send('cos', 'y', undefined, [], [clip]);
    const dirs = () => fs.readdirSync(path.join(data, 'files'));
    expect(dirs()).toHaveLength(2);
    await org.closeTab(rec.tabId);
    await org.cleanImages();
    expect(dirs()).toHaveLength(1);
    expect(fs.existsSync(path.join(data, 'files', dirs()[0], 'clip.mp4'))).toBe(true);
  });
});

describe('OrgSession image clean-up', () => {
  const files = () => fs.readdirSync(path.join(data, 'images')).sort();

  it('after a department chat ends, its images no other visible thread uses are removed; one also in the CoS thread stays', async () => {
    const { org } = setup();
    (org as any).deps.imageGraceMs = 0; // eslint-disable-line @typescript-eslint/no-explicit-any
    const only = attachment('image/png', 8, 1);
    const shared = attachment('image/gif', 8, 2);
    const rec = org.startTab('max');
    org.send(`tab:${rec.tabId}`, 'look', undefined, [only, shared]);
    org.send('cos', 'and this', undefined, [shared]);
    expect(files()).toHaveLength(2);
    await org.closeTab(rec.tabId);
    await org.cleanImages();
    expect(files()).toEqual([`${sha256(imageBytes('image/gif', 8, 2))}.gif`]);
    // The closed chat's log stays as it is.
    expect(fs.existsSync(path.join(data, 'tabs', `${rec.tabId}.jsonl`))).toBe(true);
  });

  it('an image of an open chat stays; nothing is deleted inside the grace period', async () => {
    const { org } = setup();
    const rec = org.startTab('max');
    org.send(`tab:${rec.tabId}`, 'look', undefined, [attachment('image/png', 8, 3)]);
    await org.cleanImages();
    expect(files()).toHaveLength(1);
    (org as any).deps.imageGraceMs = 0; // eslint-disable-line @typescript-eslint/no-explicit-any
    await org.cleanImages();
    expect(files()).toHaveLength(1); // the open chat still references it
  });

  it('sweeps when the session is created: an old image no log references is removed, a referenced one stays', async () => {
    const { org } = setup();
    org.send('cos', 'hi', undefined, [attachment('image/png', 8, 4)]);
    await org.cos.idle();
    await org.stopAll();
    const dir = path.join(data, 'images');
    const stale = path.join(dir, `${'e'.repeat(64)}.png`);
    fs.writeFileSync(stale, 'x');
    const old = new Date(2020, 1, 1);
    fs.utimesSync(stale, old, old);
    for (const f of fs.readdirSync(dir)) if (f !== path.basename(stale)) fs.utimesSync(path.join(dir, f), old, old);
    const again = setup().org;
    await again.cleanImages();
    expect(files()).toEqual([`${sha256(imageBytes('image/png', 8, 4))}.png`]);
  });
});

describe('OrgSession tabs.json migration', () => {
  it('an open record the old behaviour hid becomes closed (hidden dropped, saved); other records stay as they are', () => {
    const base = { orgId: 'o1', persona: 'Max', role: 'Engineering', openedAt: '2026-01-01T00:00:00.000Z', closedAt: null, notePath: null };
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(
      path.join(data, 'tabs.json'),
      JSON.stringify([
        { ...base, tabId: 'a', agent: 'max', status: 'open', hidden: true },
        { ...base, tabId: 'b', agent: 'bea', status: 'open' },
        { ...base, tabId: 'c', agent: 'bea', status: 'closed', closedAt: '2026-01-02T00:00:00.000Z', notePath: NOTE },
      ]),
    );
    const { org } = setup();
    const tabs = org.listTabs();
    expect(tabs[0]).toMatchObject({ tabId: 'a', status: 'closed' });
    expect(tabs[0].closedAt).not.toBeNull();
    expect(tabs[0]).not.toHaveProperty('hidden');
    expect(tabs[1]).toMatchObject({ tabId: 'b', status: 'open', closedAt: null });
    expect(tabs[2]).toMatchObject({ tabId: 'c', status: 'closed', closedAt: '2026-01-02T00:00:00.000Z', notePath: NOTE });
    expect(readTabs()[0]).toMatchObject({ status: 'closed' });
    expect(readTabs()[0]).not.toHaveProperty('hidden');
    expect(org.getThread('tab:a')).toBeNull();
    expect(org.getThread('tab:b')).not.toBeNull();
  });
});

describe('OrgSession hand-over fallbacks are gone', () => {
  const noteStatusAfterHandOver = async (env: Parameters<typeof setup>[0], other?: (() => void)) => {
    const { org, unregister, onHandoff } = setup(env);
    const rec = org.startTab('max');
    await org.handOver(rec.tabId);
    other?.();
    const th = org.thread(`tab:${rec.tabId}`)!;
    await waitFor(() => th.info().entries.some((e) => e.kind === 'error'));
    expect(org.listTabs()[0]).toMatchObject({ status: 'open', notePath: null });
    expect(readTabs()[0]).toMatchObject({ status: 'open', notePath: null });
    expect(th.info().entries.find((e) => e.kind === 'error')?.text).toMatch(/No handoff note/);
    expect(unregister).not.toHaveBeenCalled();
    expect(onHandoff).not.toHaveBeenCalled();
    expect(org.cos.info().entries).toEqual([]);
  };

  it('a note of another department written in the inbox during the hand-over turn is not taken', async () => {
    await noteStatusAfterHandOver({ FAKE_DELAY_MS: '150', FAKE_REPLY: 'done' }, () => fs.writeFileSync(path.join(hq, NOTE), NOTE_BEA));
  });

  it('an inbox note older than the chat is not taken, whatever the reply says (no reply-text fallback)', async () => {
    writeOldNote(NOTE, NOTE_TEXT);
    await noteStatusAfterHandOver({ FAKE_REPLY: `Written to ${NOTE}` });
  });

  it('a failed Write of the note does not hand over', async () => {
    await noteStatusAfterHandOver({ FAKE_TOOLS: JSON.stringify([{ name: 'Write', input: { file_path: path.join(hq, NOTE) }, write: NOTE_TEXT, error: true }]) });
    expect(fs.existsSync(path.join(hq, NOTE))).toBe(false);
  });

  it('an Edit that did not change an older note does not hand over', async () => {
    writeOldNote(NOTE, NOTE_TEXT);
    await noteStatusAfterHandOver({ FAKE_TOOLS: JSON.stringify([{ name: 'Edit', input: { file_path: path.join(hq, NOTE) } }]) });
  });

  it('a hand-over whose turn cannot start (canStart reason) returns the tab to open with an error line', async () => {
    const { org, unregister } = setup();
    let reason: string | null = null;
    (org as any).deps.canStart = () => reason; // eslint-disable-line @typescript-eslint/no-explicit-any
    // tabThread reads deps.canStart at creation: create the thread after the reason is set
    reason = 'Claude Code is not supported';
    const rec = org.startTab('max');
    await org.handOver(rec.tabId);
    const th = org.thread(`tab:${rec.tabId}`)!;
    await waitFor(() => org.listTabs()[0].status === 'open');
    expect(readTabs()[0].status).toBe('open');
    const errors = th.info().entries.filter((e) => e.kind === 'error').map((e) => e.text);
    expect(errors[0]).toBe('Claude Code is not supported');
    expect(errors.some((e) => /No handoff note/.test(e))).toBe(true);
    expect(unregister).not.toHaveBeenCalled();
    // the chat can be closed again (it is not stuck in handing-over)
    await org.closeTab(rec.tabId);
    expect(org.listTabs()[0].status).toBe('closed');
  });

  it('a hand-over whose process cannot be made returns the tab to open', async () => {
    const { org } = setup();
    (org as any).makeSession = () => { // eslint-disable-line @typescript-eslint/no-explicit-any
      throw new Error('claude is missing');
    };
    const rec = org.startTab('max');
    await org.handOver(rec.tabId);
    await waitFor(() => org.listTabs()[0].status === 'open');
    const errors = org.thread(`tab:${rec.tabId}`)!.info().entries.filter((e) => e.kind === 'error').map((e) => e.text);
    expect(errors[0]).toBe('claude is missing');
    await org.closeTab(rec.tabId);
  });
});

describe('OrgSession note written by the chat itself', () => {
  const noteTool = (extra: Record<string, unknown> = {}, file = NOTE) => ({ name: 'Write', input: { file_path: path.join(hq, file) }, write: NOTE_TEXT, ...extra });
  const tools = (...t: unknown[]) => JSON.stringify(t);
  const turn = async (org: OrgSession, tabId: string, text = 'go') => {
    const th = org.getThread(`tab:${tabId}`)!;
    const n = th.entries.filter((e) => e.kind === 'assistant' || e.kind === 'system').length;
    org.send(`tab:${tabId}`, text);
    await waitFor(() => {
      const i = org.getThread(`tab:${tabId}`)!;
      return !i.busy && i.entries.filter((e) => e.kind === 'assistant' || e.kind === 'system').length > n;
    });
  };

  it('a turn whose successful Write created an inbox note marks the tab as handed over (saved, tabs event)', async () => {
    const { org, events } = setup({ FAKE_TOOLS: tools(noteTool()), FAKE_REPLY: 'wrote it' });
    const rec = org.startTab('max');
    org.send(`tab:${rec.tabId}`, 'write your note');
    await waitFor(() => org.listTabs()[0].notePath === NOTE);
    expect(readTabs()[0].notePath).toBe(NOTE);
    expect(org.listTabs()[0].status).toBe('open');
    expect(events.some((e) => e.type === 'tabs' && e.tabs[0]?.notePath === NOTE)).toBe(true);
  });

  it('a failed (denied) Write to an inbox path does not mark the tab', async () => {
    const { org } = setup({ FAKE_TOOLS: tools(noteTool({ error: true })) });
    const rec = org.startTab('max');
    await turn(org, rec.tabId);
    expect(org.listTabs()[0].notePath).toBeNull();
    expect(readTabs()[0].notePath).toBeNull();
  });

  it('a Write without any tool result does not mark the tab when the note is another department\'s', async () => {
    const { org } = setup({ FAKE_TOOLS: tools(noteTool({ write: NOTE_BEA })), FAKE_TOOL_RESULTS: '0' });
    const rec = org.startTab('max');
    await turn(org, rec.tabId);
    expect(org.listTabs()[0].notePath).toBeNull();
  });

  it('a Write without any tool result is not certain, but a new note from this department in inbox/ marks the tab', async () => {
    const { org } = setup({ FAKE_TOOLS: tools(noteTool()), FAKE_TOOL_RESULTS: '0' });
    const rec = org.startTab('max');
    await turn(org, rec.tabId);
    expect(org.listTabs()[0].notePath).toBe(NOTE);
  });

  it('an Edit that did not change an existing note (another chat\'s) does not mark the tab', async () => {
    fs.writeFileSync(path.join(hq, NOTE), NOTE_TEXT);
    const { org } = setup({ FAKE_TOOLS: tools({ name: 'Edit', input: { file_path: path.join(hq, NOTE) } }) });
    const rec = org.startTab('max');
    await turn(org, rec.tabId);
    expect(org.listTabs()[0].notePath).toBeNull();
  });

  it('an Edit that did change an existing note marks the tab', async () => {
    fs.writeFileSync(path.join(hq, NOTE), 'old');
    const { org } = setup({ FAKE_TOOLS: tools({ name: 'Edit', input: { file_path: path.join(hq, NOTE) }, write: NOTE_TEXT }) });
    const rec = org.startTab('max');
    await turn(org, rec.tabId);
    expect(org.listTabs()[0].notePath).toBe(NOTE);
  });

  it('a later turn without a note clears it: the chat counts as not handed over again, and closing passes nothing', async () => {
    const logFile = path.join(root, 'fake.log');
    // the first turn writes the note, the second does nothing (FAKE_TOOLS is read once per process: the second turn restarts the fake via a new env)
    const { org, onHandoff, factory } = setup((n) => ({ FAKE_LOG: logFile, FAKE_TOOLS: n === 0 ? tools(noteTool()) : '[]', FAKE_SID: `S${n}` }));
    const rec = org.startTab('max');
    await turn(org, rec.tabId, 'write your note');
    expect(org.listTabs()[0].notePath).toBe(NOTE);
    // force a new process (a new env) for the next turn
    await org.thread(`tab:${rec.tabId}`)!.restart();
    const tabEvents: Array<string | null> = [];
    (org as any).deps.emit = (e: AppEvent) => e.type === 'tabs' && tabEvents.push(e.tabs[0].notePath); // eslint-disable-line @typescript-eslint/no-explicit-any
    await turn(org, rec.tabId, 'now something else');
    expect(factory.resumeIds).toHaveLength(2);
    expect(org.listTabs()[0].notePath).toBeNull();
    expect(readTabs()[0].notePath).toBeNull();
    expect(tabEvents).toContain(null);
    await org.closeTab(rec.tabId);
    expect(onHandoff).not.toHaveBeenCalled();
    expect(org.cos.info().entries).toEqual([]);
  });

  it('the note is cleared as soon as a later turn starts, not only when it ends', async () => {
    const { org } = setup((n) => ({ FAKE_TOOLS: n === 0 ? tools(noteTool()) : '[]', FAKE_DELAY_MS: n === 0 ? '0' : '300' }));
    const rec = org.startTab('max');
    await turn(org, rec.tabId, 'write your note');
    expect(org.listTabs()[0].notePath).toBe(NOTE);
    await org.thread(`tab:${rec.tabId}`)!.restart();
    org.send(`tab:${rec.tabId}`, 'more work');
    await waitFor(() => org.getThread(`tab:${rec.tabId}`)!.busy);
    expect(org.listTabs()[0].notePath).toBeNull();
    await waitFor(() => !org.getThread(`tab:${rec.tabId}`)!.busy);
  });

  it('a reply that only mentions an inbox path does not', async () => {
    fs.writeFileSync(path.join(hq, NOTE), NOTE_TEXT);
    const { org } = setup({ FAKE_REPLY: `see ${NOTE}` });
    const rec = org.startTab('max');
    await turn(org, rec.tabId, 'hi');
    expect(org.listTabs()[0].notePath).toBeNull();
  });

  it('a note of another department written to inbox/ in the meantime does not mark this tab', async () => {
    const { org } = setup({ FAKE_REPLY: 'nothing written', FAKE_DELAY_MS: '100' });
    const rec = org.startTab('max');
    org.send(`tab:${rec.tabId}`, 'hi');
    fs.writeFileSync(path.join(hq, NOTE), NOTE_BEA); // someone else
    await waitFor(() => org.getThread(`tab:${rec.tabId}`)!.entries.some((e) => e.kind === 'assistant'));
    expect(org.listTabs()[0].notePath).toBeNull();
  });

  it('a note of the same department that another run wrote during the turn does not mark the tab', async () => {
    const { org } = setup({ FAKE_REPLY: 'nothing written', FAKE_DELAY_MS: '100' });
    const rec = org.startTab('max');
    org.send(`tab:${rec.tabId}`, 'hi');
    fs.writeFileSync(path.join(hq, NOTE), NOTE_TEXT); // from: max, but written outside this chat's session
    await waitFor(() => org.getThread(`tab:${rec.tabId}`)!.entries.some((e) => e.kind === 'assistant'));
    expect(org.listTabs()[0].notePath).toBeNull();
  });

  it('a note written during the turn by a background agent of another run does not mark the tab', async () => {
    const bg = { path: path.join(hq, NOTE), content: NOTE_TEXT, delayMs: 0 };
    const { org } = setup({ FAKE_BG_WRITE: JSON.stringify(bg), FAKE_REPLY: 'ok' });
    const rec = org.startTab('max');
    await turn(org, rec.tabId);
    await new Promise((r) => setTimeout(r, 200));
    expect(fs.existsSync(path.join(hq, NOTE))).toBe(true);
    expect(org.listTabs()[0].notePath).toBeNull();
  });

  it('a note a sub-agent of this chat wrote during the turn marks the tab', async () => {
    const sub = [{ name: 'Write', input: { file_path: path.join(hq, NOTE) }, write: NOTE_TEXT }];
    const { org } = setup({ FAKE_SUB_TOOLS: JSON.stringify(sub), FAKE_REPLY: 'the worker wrote it' });
    const rec = org.startTab('max');
    await turn(org, rec.tabId);
    expect(org.listTabs()[0].notePath).toBe(NOTE);
  });

  it('a note this chat wrote with Bash marks the tab', async () => {
    const t = [{ name: 'Bash', input: { command: `cat > ${NOTE} <<EOF` }, writePath: path.join(hq, NOTE), write: NOTE_TEXT }];
    const { org } = setup({ FAKE_TOOLS: tools(...t) });
    const rec = org.startTab('max');
    await turn(org, rec.tabId);
    expect(org.listTabs()[0].notePath).toBe(NOTE);
  });

  it('a note this chat wrote for another department (to: design-brand) does not mark the tab', async () => {
    const { org } = setup({ FAKE_TOOLS: tools(noteTool({ write: NOTE_TEXT.replace('from: max', 'from: max\nto: design-brand') })) });
    const rec = org.startTab('max');
    await turn(org, rec.tabId);
    expect(org.listTabs()[0].notePath).toBeNull();
  });

  it('README.md and files outside inbox/ do not count', async () => {
    fs.writeFileSync(path.join(hq, 'inbox', 'README.md'), 'x');
    fs.writeFileSync(path.join(hq, 'notes.md'), 'x');
    const { org } = setup({ FAKE_TOOLS: tools({ name: 'Write', input: { file_path: path.join(hq, 'inbox', 'README.md') }, write: 'y' }, { name: 'Edit', input: { file_path: path.join(hq, 'notes.md') }, write: 'y' }) });
    const rec = org.startTab('max');
    await turn(org, rec.tabId, 'hi');
    expect(org.listTabs()[0].notePath).toBeNull();
  });

  it('closing such a tab passes the note to the chief of staff once, like a hand-over', async () => {
    const logFile = path.join(root, 'fake.log');
    // call 0 is the tab session, call 1 the CoS session
    const { org, onHandoff } = setup((n) => ({ FAKE_LOG: logFile, FAKE_TOOLS: n === 0 ? tools(noteTool()) : '[]', FAKE_SID: `S${n}` }));
    const rec = org.startTab('max');
    await turn(org, rec.tabId, 'write your note');
    await org.closeTab(rec.tabId);
    await waitFor(() => org.cos.info().entries.some((e) => e.kind === 'assistant'));
    expect(org.listTabs()[0]).toMatchObject({ status: 'closed', notePath: NOTE });
    expect(onHandoff).toHaveBeenCalledTimes(1);
    expect(onHandoff).toHaveBeenCalledWith('o1', 'Max');
    const cos = org.cos.info().entries;
    expect(cos.filter((e) => e.kind === 'handoff')).toEqual([expect.objectContaining({ author: 'Max', text: 'Max handed over: Please merge PR 7' })]);
    const sent = fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l).message.content as string);
    const toCos = sent.filter((m) => m.includes('handed over'));
    expect(toCos).toHaveLength(1);
    expect(toCos[0]).toContain(`Max (Engineering) handed over: ${NOTE}`);
    expect(toCos[0]).toContain('Please merge PR 7');
  });

  it('closeTab with passNote: false closes a noted chat and starts no CoS turn (the note stays in the inbox)', async () => {
    const logFile = path.join(root, 'fake.log');
    const tools = [{ name: 'Write', input: { file_path: path.join(hq, NOTE) }, write: NOTE_TEXT }];
    const { org, onHandoff } = setup({ FAKE_LOG: logFile, FAKE_TOOLS: JSON.stringify(tools), FAKE_TOOL_RESULTS: '1' });
    const rec = org.startTab('max');
    org.send(`tab:${rec.tabId}`, 'write your note');
    await waitFor(() => org.listTabs()[0].notePath === NOTE);
    await org.closeTab(rec.tabId, { passNote: false });
    expect(org.listTabs()[0].status).toBe('closed');
    expect(onHandoff).not.toHaveBeenCalled();
    expect(org.cos.info().entries).toEqual([]);
    expect(fs.existsSync(path.join(hq, NOTE))).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(org.cos.info().busy).toBe(false);
    const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.startsWith('{'));
    expect(lines).toHaveLength(1); // only the chat's own message: no CoS session was fed
  });

  it('a note that was deleted after the turn is not passed on', async () => {
    const { org, onHandoff } = setup((n) => ({ FAKE_TOOLS: n === 0 ? tools(noteTool()) : '[]' }));
    const rec = org.startTab('max');
    await turn(org, rec.tabId, 'write your note');
    fs.rmSync(path.join(hq, NOTE));
    await org.closeTab(rec.tabId);
    expect(onHandoff).not.toHaveBeenCalled();
    expect(org.cos.info().entries).toEqual([]);
  });

  it('after the explicit hand-over the CoS is told once (the chat is closed, nothing more to pass)', async () => {
    const { org, onHandoff } = setup((n) => ({ FAKE_TOOLS: n === 0 ? tools(noteTool()) : '[]', FAKE_REPLY: n === 0 ? NOTE : 'processed', FAKE_SID: `S${n}` }));
    const rec = org.startTab('max');
    await org.handOver(rec.tabId);
    await waitFor(() => org.listTabs()[0].status === 'closed' && org.cos.info().entries.some((e) => e.kind === 'assistant'));
    await expect(org.closeTab(rec.tabId)).rejects.toThrow(/not open/);
    expect(onHandoff).toHaveBeenCalledTimes(1);
  });
});

describe('OrgSession endTab write failures', () => {
  it('a failing tabs.json write still kills the process and closes the chat', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { org, factory } = setup({ FAKE_DELAY_MS: '5000' });
    const rec = org.startTab('max');
    org.send(`tab:${rec.tabId}`, 'long work');
    await waitFor(() => factory.pids.length === 1 && org.getThread(`tab:${rec.tabId}`)!.busy);
    (org as any).saveTabs = () => { // eslint-disable-line @typescript-eslint/no-explicit-any
      throw new Error('disk full');
    };
    await org.closeTab(rec.tabId);
    await waitFor(() => !factory.sessions[0].running);
    expect(() => process.kill(factory.pids[0], 0)).toThrow();
    expect(org.listTabs()[0].status).toBe('closed');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a failing session store still kills the process', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { org, factory } = setup({ FAKE_DELAY_MS: '5000' });
    const rec = org.startTab('max');
    org.send(`tab:${rec.tabId}`, 'long work');
    await waitFor(() => factory.pids.length === 1 && org.getThread(`tab:${rec.tabId}`)!.busy);
    (org as any).sessions.remove = () => { // eslint-disable-line @typescript-eslint/no-explicit-any
      throw new Error('read-only');
    };
    await org.closeTab(rec.tabId);
    await waitFor(() => !factory.sessions[0].running);
    expect(() => process.kill(factory.pids[0], 0)).toThrow();
    spy.mockRestore();
  });
});

describe('OrgSession tabs.json write failures', () => {
  const failSave = (org: OrgSession) => {
    (org as any).saveTabs = () => { // eslint-disable-line @typescript-eslint/no-explicit-any
      throw new Error('disk full');
    };
  };

  it('a hand-over whose first save fails does not start: the tab stays open, handOver rejects, closeTab still works', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logFile = path.join(root, 'fake.log');
    const { org, events } = setup({ FAKE_LOG: logFile });
    const rec = org.startTab('max');
    failSave(org);
    const before = events.filter((e) => e.type === 'tabs').length;
    await expect(org.handOver(rec.tabId)).rejects.toThrow(/disk full/);
    expect(org.listTabs()[0].status).toBe('open');
    expect(events.filter((e) => e.type === 'tabs').length).toBe(before);
    expect(fs.existsSync(logFile)).toBe(false); // no hand-over message was sent
    await org.closeTab(rec.tabId);
    expect(org.listTabs()[0].status).toBe('closed');
    spy.mockRestore();
  });

  it('a hand-over that finds no note returns to open and emits tabs although the save fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { org, events } = setup({ FAKE_REPLY: 'nothing' });
    const rec = org.startTab('max');
    await org.handOver(rec.tabId);
    failSave(org); // the move to handing-over was saved; the way back is not
    await waitFor(() => org.listTabs()[0].status === 'open');
    expect(events.filter((e) => e.type === 'tabs').at(-1)).toMatchObject({ tabs: [{ status: 'open' }] });
    expect(spy).toHaveBeenCalled();
    await org.closeTab(rec.tabId);
    spy.mockRestore();
  });

  it('a note change with a failing save still emits the tabs event', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const tools = [{ name: 'Write', input: { file_path: path.join(hq, NOTE) }, write: NOTE_TEXT }];
    const { org, events } = setup({ FAKE_TOOLS: JSON.stringify(tools), FAKE_REPLY: 'wrote it' });
    const rec = org.startTab('max');
    failSave(org);
    org.send(`tab:${rec.tabId}`, 'write your note');
    await waitFor(() => org.listTabs()[0].notePath === NOTE);
    expect(events.some((e) => e.type === 'tabs' && e.tabs[0]?.notePath === NOTE)).toBe(true);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('OrgSession pendingWork and the CoS inbox', () => {
  const bash = JSON.stringify([{ name: 'Bash', input: { command: 'ls' } }]);
  const write = (file: string, text = NOTE_TEXT) => fs.writeFileSync(path.join(hq, file), text);
  const turn = async (org: OrgSession, tabId: string) => {
    const th = org.getThread(`tab:${tabId}`)!;
    const n = th.entries.filter((e) => e.kind === 'assistant').length;
    org.send(`tab:${tabId}`, 'go');
    await waitFor(() => {
      const i = org.getThread(`tab:${tabId}`)!;
      return !i.busy && i.entries.filter((e) => e.kind === 'assistant').length > n;
    });
  };

  const writeNoteTools = () => JSON.stringify([{ name: 'Write', input: { file_path: path.join(hq, NOTE) }, write: NOTE_TEXT }]);
  const setPending = (org: OrgSession, v: boolean) => {
    (org as any).records[0].pendingWork = v; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  it('a new tab has no pending work; a turn that used a tool sets it (saved)', async () => {
    const { org } = setup({ FAKE_TOOLS: bash });
    const rec = org.startTab('max');
    expect(rec.pendingWork).toBe(false);
    expect(readTabs()[0].pendingWork).toBe(false);
    await turn(org, rec.tabId);
    expect(org.listTabs()[0].pendingWork).toBe(true);
    expect(readTabs()[0].pendingWork).toBe(true);
  });

  it('a text-only turn leaves pendingWork as it was', async () => {
    const { org } = setup({ FAKE_TOOLS: '[]' });
    const rec = org.startTab('max');
    await turn(org, rec.tabId);
    expect(org.listTabs()[0].pendingWork).toBe(false);
    setPending(org, true);
    await turn(org, rec.tabId);
    expect(org.listTabs()[0].pendingWork).toBe(true);
  });

  it('a turn that writes its own note clears pendingWork, sets notePath and says the handoff is already done', async () => {
    const { org } = setup({ FAKE_TOOLS: writeNoteTools() });
    const rec = org.startTab('max');
    setPending(org, true);
    await turn(org, rec.tabId);
    expect(org.listTabs()[0]).toMatchObject({ pendingWork: false, notePath: NOTE });
    expect(org.getThread(`tab:${rec.tabId}`)!.entries.some((e) => e.kind === 'system' && e.text.includes(path.basename(NOTE)))).toBe(true);
  });

  it('hand over clears pendingWork when it gets the note', async () => {
    const { org } = setup({ FAKE_TOOLS: writeNoteTools(), FAKE_REPLY: 'ok' });
    const rec = org.startTab('max');
    setPending(org, true);
    await org.handOver(rec.tabId);
    await waitFor(() => org.listTabs()[0].status === 'closed');
    expect(org.listTabs()[0]).toMatchObject({ pendingWork: false, notePath: NOTE });
  });

  it('an old record without pendingWork reads as pending when it has no note', () => {
    const { org } = setup();
    const rec = org.startTab('max');
    const old = readTabs().map((r) => {
      const { pendingWork: _p, ...rest } = r;
      return rest;
    });
    fs.writeFileSync(path.join(data, 'tabs.json'), JSON.stringify([...old, { ...old[0], tabId: 'bb', agent: 'bea', notePath: 'inbox/a.md' }]));
    const again = new OrgSession('o1', hq, data, (org as any).deps); // eslint-disable-line @typescript-eslint/no-explicit-any
    orgs.push(again);
    expect(again.listTabs().map((r) => [r.tabId, r.pendingWork])).toEqual([[rec.tabId, true], ['bb', false]]);
  });

  it('the CoS state lists inbox notes with the persona, skips an open chat\'s note and follows refreshInbox', async () => {
    const { org } = setup({ FAKE_TOOLS: JSON.stringify([{ name: 'Write', input: { file_path: path.join(hq, NOTE) }, write: NOTE_TEXT }]) });
    write('inbox/2026-01-02-bea-to-cos-z.md', NOTE_BEA);
    write('inbox/2026-01-03-other.md', '# no frontmatter\n');
    write('inbox/README.md', '# index\n');
    expect(org.cos.state().inbox).toEqual([
      { path: 'inbox/2026-01-02-bea-to-cos-z.md', name: 'Bea' },
      { path: 'inbox/2026-01-03-other.md', name: null },
    ]);
    const rec = org.startTab('max');
    await turn(org, rec.tabId); // the chat writes its own note: it belongs to an open chat
    expect(org.cos.state().inbox?.map((n) => n.path)).not.toContain(NOTE);
    write('inbox/2026-01-04-bea-to-cos-new.md', NOTE_BEA);
    expect(org.cos.state().inbox?.map((n) => n.path)).not.toContain('inbox/2026-01-04-bea-to-cos-new.md'); // cached until refreshInbox
    org.refreshInbox();
    expect(org.cos.state().inbox).toContainEqual({ path: 'inbox/2026-01-04-bea-to-cos-new.md', name: 'Bea' });
    fs.rmSync(path.join(hq, 'inbox/2026-01-02-bea-to-cos-z.md'));
    org.refreshInbox();
    expect(org.cos.state().inbox?.map((n) => n.path)).not.toContain('inbox/2026-01-02-bea-to-cos-z.md');
  });

  it('a busy chat that has not used a tool yet has no pending work; the first tool call of the turn sets it, before the turn ends', async () => {
    const { org } = setup({ FAKE_TOOLS: bash, FAKE_DELAY_MS: '400', FAKE_TEXT_DELAY_MS: '600' });
    const rec = org.startTab('max');
    org.send(`tab:${rec.tabId}`, 'go');
    await waitFor(() => org.getThread(`tab:${rec.tabId}`)!.busy);
    expect(org.isTabBusy(rec.tabId)).toBe(true);
    expect(org.listTabs()[0].pendingWork).toBe(false); // busy, no tool yet
    await waitFor(() => org.listTabs()[0].pendingWork); // the tool call arrives
    expect(org.getThread(`tab:${rec.tabId}`)!.busy).toBe(true); // the turn is still running
    expect(readTabs()[0].pendingWork).toBe(true);
    await waitFor(() => !org.getThread(`tab:${rec.tabId}`)!.busy);
    expect(org.isTabBusy(rec.tabId)).toBe(false);
  });

  it('an idle chat with no work has no pending work and is not busy', () => {
    const { org } = setup();
    const rec = org.startTab('max');
    expect(org.listTabs()[0].pendingWork).toBe(false);
    expect(org.isTabBusy(rec.tabId)).toBe(false);
  });

  it('a turn with only sub-agent tool calls sets pendingWork', () => {
    const { org } = setup();
    org.startTab('max');
    (org as any).noteOwnInbox((org as any).records[0], { text: '', isError: false, resultText: '', tools: [], subTools: [{ name: 'Bash', input: { command: 'ls' } }], sent: [{ text: 'go', kind: 'user' }] }); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(org.listTabs()[0].pendingWork).toBe(true);
  });

  it('a foreground sub-agent turn sets pendingWork', async () => {
    const sub = [{ name: 'Bash', input: { command: 'ls' } }];
    const { org } = setup({ FAKE_SUB_TOOLS: JSON.stringify(sub) });
    const rec = org.startTab('max');
    await turn(org, rec.tabId);
    expect(org.listTabs()[0].pendingWork).toBe(true);
  });

  it('the hand-over turn\'s own tool calls do not set pendingWork', async () => {
    const { org } = setup({ FAKE_TOOLS: bash, FAKE_REPLY: 'nothing to hand over' });
    const rec = org.startTab('max');
    await org.handOver(rec.tabId).catch(() => undefined);
    await waitFor(() => !org.getThread(`tab:${rec.tabId}`)?.busy);
    expect(org.listTabs()[0].pendingWork).toBe(false);
  });

  it('the CoS state hides a note that an open chat of its department may still be writing, and shows it once the chat is closed', async () => {
    const { org } = setup();
    write('inbox/2026-01-02-bea-to-cos-z.md', NOTE_BEA);
    write('inbox/2026-01-05-max-to-cos-late.md', NOTE_TEXT);
    const rec = org.startTab('max');
    org.refreshInbox();
    // The note is Max's: the open Max chat has not found it yet (notePath is null), still it is not waiting for the CoS.
    expect(org.cos.state().inbox?.map((n) => n.path)).toEqual(['inbox/2026-01-02-bea-to-cos-z.md']);
    await org.closeTab(rec.tabId, { passNote: false });
    expect(org.cos.state().inbox?.map((n) => n.path)).toEqual(['inbox/2026-01-02-bea-to-cos-z.md', 'inbox/2026-01-05-max-to-cos-late.md']);
  });

  it('the department list is read once and again after refreshInbox or refreshNames', () => {
    const { org } = setup();
    write('inbox/2026-01-02-bea-to-cos-z.md', NOTE_BEA);
    const spy = vi.spyOn(org, 'departments');
    org.cos.state();
    org.cos.state();
    org.cos.state();
    expect(spy).toHaveBeenCalledTimes(1);
    org.refreshInbox();
    org.cos.state();
    expect(spy).toHaveBeenCalledTimes(2);
    org.refreshNames();
    org.cos.state();
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('a department chat state carries no inbox', () => {
    const { org } = setup();
    write('inbox/2026-01-02-bea-to-cos-z.md', NOTE_BEA);
    const rec = org.startTab('max');
    expect(org.getThread(`tab:${rec.tabId}`) && (org as any).tabs.get(rec.tabId).state().inbox).toBeUndefined(); // eslint-disable-line @typescript-eslint/no-explicit-any
  });
});
