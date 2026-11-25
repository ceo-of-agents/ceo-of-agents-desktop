import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OrgSession } from '../../src/main/org/org-session';
import { Thread } from '../../src/main/org/thread';
import { ThreadRunStore, resolveRun } from '../../src/main/org/thread-run';
import { agentEffort, effortOfAgentText, parseEffort } from '../../src/main/hq/agent-effort';
import type { AppEvent, Settings } from '../../src/shared/types';
import { fakeFactory, waitFor } from './helpers';

const ORG_YAML = `org:
  id: T
  name: Test Org
cos:
  display_name: "Ada"
models:
  cos: opus
  departments: sonnet
  tiers: [opus, sonnet]
departments:
  - id: engineering
    agent: max
    display_name: Max
    model: haiku
`;
const CLAUDE_MD = `# Test

| Agent | Name | Role | Id | Use for |
|---|---|---|---|---|
| max | Max | Engineering | engineering | Code |
`;

let root: string;
let hq: string;
let settings: Partial<Settings>;
let org: OrgSession;
let events: AppEvent[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-chat-run-'));
  hq = path.join(root, 'hq');
  fs.mkdirSync(hq, { recursive: true });
  fs.writeFileSync(path.join(hq, 'org.yaml'), ORG_YAML);
  fs.writeFileSync(path.join(hq, 'CLAUDE.md'), CLAUDE_MD);
  settings = { permissionMode: 'default', effort: 'medium', cosModel: 'opus', modelTiers: ['opus', 'sonnet'] };
  events = [];
  org = build();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function build(): OrgSession {
  return new OrgSession('o1', hq, path.join(root, 'data'), {
    claudePath: () => 'claude',
    settings: () => settings as Settings,
    broker: { register: () => '{}', unregister: () => undefined, denyPending: () => 0 } as never,
    serverScript: 'server.js',
    nodePath: process.execPath,
    canStart: () => null,
    emit: (e) => events.push(e),
  });
}
const argsOf = (o: OrgSession, threadId: string, agent: string | null): string[] =>
  (o as any).makeSession(threadId, null, agent).args; // eslint-disable-line @typescript-eslint/no-explicit-any
const pair = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('resolveRun', () => {
  const org_ = { orgModel: 'opus', orgEffort: 'medium' as const };
  it('chat choice, then org default', () => {
    expect(resolveRun({ choice: { model: null, effort: null }, ...org_ })).toEqual({ model: 'opus', effort: 'medium' });
    expect(resolveRun({ choice: { model: 'haiku', effort: 'max' }, ...org_ })).toEqual({ model: 'haiku', effort: 'max' });
    expect(resolveRun({ choice: { model: null, effort: 'low' }, ...org_, orgModel: null })).toEqual({ model: null, effort: 'low' });
  });
  it('COA_MODEL overrides the model, not the effort', () => {
    expect(resolveRun({ choice: { model: 'haiku', effort: 'max' }, ...org_, devModel: 'sonnet' })).toEqual({ model: 'sonnet', effort: 'max' });
  });
});

describe('ThreadRunStore', () => {
  it('keeps a choice per thread on disk, merges patches, and drops an empty choice', () => {
    const dir = path.join(root, 'store');
    const a = new ThreadRunStore(dir);
    expect(a.get('cos')).toEqual({ model: null, effort: null });
    a.set('cos', { model: 'haiku' });
    a.set('cos', { effort: 'low' });
    a.set('tab:1', { effort: 'max' });
    const b = new ThreadRunStore(dir);
    expect(b.get('cos')).toEqual({ model: 'haiku', effort: 'low' });
    expect(b.get('tab:1')).toEqual({ model: null, effort: 'max' });
    expect(b.get('tab:2')).toEqual({ model: null, effort: null });
    b.set('cos', { model: null, effort: null });
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'thread-run.json'), 'utf8')))).toEqual(['tab:1']);
    expect(fs.readdirSync(dir)).toEqual(['thread-run.json']);
  });
  it('ignores invalid values', () => {
    const s = new ThreadRunStore(path.join(root, 'store'));
    s.set('cos', { model: 'bad name; rm', effort: 'huge' as never });
    expect(s.get('cos')).toEqual({ model: null, effort: null });
  });
});

describe('OrgSession chat choice', () => {
  it('args: chat choice > org default > org.yaml; departments use their own default', () => {
    expect(pair(argsOf(org, 'cos', null), '--model')).toBe('opus');
    org.setRun('cos', { model: 'haiku', effort: 'max' });
    const a = argsOf(org, 'cos', null);
    expect(pair(a, '--model')).toBe('haiku');
    expect(pair(a, '--effort')).toBe('max');
    org.setRun('cos', { model: null });
    expect(pair(argsOf(org, 'cos', null), '--model')).toBe('opus');
    const tab = org.startTab('max');
    const tid = `tab:${tab.tabId}` as const;
    expect(pair(argsOf(org, tid, 'max'), '--model')).toBe('haiku');
    expect(org.getThread(tid)?.runChoice).toEqual({ model: null, effort: null });
    org.setRun(tid, { model: 'opus' });
    expect(pair(argsOf(org, tid, 'max'), '--model')).toBe('opus');
  });

  it('the CoS choice persists across restarts; a new tab starts with none', () => {
    org.setRun('cos', { model: 'sonnet', effort: 'low' });
    const again = build();
    expect(again.getThread('cos')).toMatchObject({ model: 'sonnet', effort: 'low', runChoice: { model: 'sonnet', effort: 'low' } });
    const tab = again.startTab('max');
    expect(again.getThread(`tab:${tab.tabId}`)?.runChoice).toEqual({ model: null, effort: null });
  });

  it('info carries the org defaults and tiers; setRun emits state and validates', () => {
    const info = org.setRun('cos', { effort: 'xhigh' });
    expect(info).toMatchObject({ effort: 'xhigh', runDefaults: { model: 'opus', effort: 'medium' }, modelTiers: ['opus', 'sonnet'], runPending: false });
    expect(events.some((e) => e.type === 'thread-state' && e.state.effort === 'xhigh')).toBe(true);
    org.setRun('cos', { model: 'bad name', effort: 'huge' as never });
    expect(org.getThread('cos')?.runChoice).toEqual({ model: null, effort: 'xhigh' });
    expect(() => org.setRun('tab:nope', { model: 'opus' })).toThrow();
  });

  it('a change while a process is live is pending until the next process', () => {
    argsOf(org, 'cos', null);
    expect(org.getThread('cos')?.runPending).toBe(false);
    org.setRun('cos', { model: 'haiku' });
    expect(org.getThread('cos')).toMatchObject({ model: 'haiku', runPending: true });
    argsOf(org, 'cos', null);
    expect(org.getThread('cos')?.runPending).toBe(false);
  });
});

describe('permission mode of a running chat', () => {
  it('a mode change is pending until the process restarts, and every chat of the org gets its state', async () => {
    argsOf(org, 'cos', null);
    expect(org.getThread('cos')).toMatchObject({ permissionMode: 'default', runPending: false });
    settings.permissionMode = 'plan';
    events.length = 0;
    org.emitThreadStates();
    expect(events.some((e) => e.type === 'thread-state' && e.state.threadId === 'cos' && e.state.runPending === true && e.state.permissionMode === 'plan')).toBe(true);
    expect(pair(argsOf(org, 'cos', null), '--permission-mode')).toBe('plan');
    expect(org.getThread('cos')?.runPending).toBe(false);
    settings.permissionMode = 'auto';
    expect(org.getThread('cos')?.runPending).toBe(true);
    await org.restartSessions();
    expect(org.getThread('cos')?.runPending).toBe(false);
  });
});

describe('Thread restarts only between turns', () => {
  const setup = (env: Record<string, string>) => {
    const f = fakeFactory(root, env);
    let wanted = 'a';
    let started = 'a';
    const th = new Thread({
      orgId: 'o1',
      threadId: 'cos',
      title: 'T',
      speaker: 'Ada',
      logFile: path.join(root, 'log.jsonl'),
      makeSession: (id) => {
        started = wanted;
        return f.makeSession(id);
      },
      sessions: (() => {
        let stored: { sessionId: string; day: string } | null = null;
        return { get: () => stored, set: (sessionId: string, day: string) => (stored = { sessionId, day }), clear: () => (stored = null) };
      })(),
      needsRestart: () => started !== wanted,
      emit: () => undefined,
    });
    return { th, f, want: (v: string) => (wanted = v) };
  };
  const user = (text: string) => ({ kind: 'user' as const, author: 'You', text });
  const idle = (th: Thread) => waitFor(() => !th.busy);

  it('keeps the process while busy; the next send replaces it and resumes the session', async () => {
    const { th, f, want } = setup({ FAKE_DELAY_MS: '150', FAKE_SID: 'sid-7' });
    th.enqueue('one', 'user', user('one'));
    await waitFor(() => th.busy);
    want('b');
    expect(f.sessions).toHaveLength(1);
    await idle(th);
    expect(f.sessions).toHaveLength(1);
    th.enqueue('two', 'user', user('two'));
    await idle(th);
    expect(f.resumeIds).toEqual([null, 'sid-7']);
    th.enqueue('three', 'user', user('three'));
    await idle(th);
    expect(f.resumeIds).toEqual([null, 'sid-7']);
    await th.stop();
  });
});

describe('department effort from the agent file', () => {
  const writeAgent = (text: string) => {
    fs.mkdirSync(path.join(hq, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(hq, '.claude', 'agents', 'max.md'), text);
  };
  const agentFile = (effortLine: string) => `---\nname: max\ndescription: Engineering\n${effortLine}---\nBody\n`;

  it('parses only the five valid levels', () => {
    expect(['low', 'medium', 'high', 'xhigh', 'max'].map(parseEffort)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(parseEffort(' medium ')).toBe('medium');
    for (const bad of ['huge', '', 'Medium', 3, null, undefined, ['low']]) expect(parseEffort(bad)).toBeNull();
    expect(effortOfAgentText('no frontmatter')).toBeNull();
  });

  it('(a) effort: medium in the agent file is the department default and the process gets --effort medium', () => {
    settings.effort = 'high';
    writeAgent(agentFile('effort: medium\n'));
    expect(agentEffort(hq, 'max')).toBe('medium');
    const tab = org.startTab('max');
    const tid = `tab:${tab.tabId}` as const;
    expect(org.getThread(tid)).toMatchObject({ effort: 'medium', runDefaults: { effort: 'medium', effortFromAgent: true } });
    expect(pair(argsOf(org, tid, 'max'), '--effort')).toBe('medium');
  });

  it('(b) no or invalid effort falls back to the org effort', () => {
    settings.effort = 'high';
    for (const [file, line] of [[false, ''], [true, ''], [true, 'effort: huge\n'], [true, 'effort: ""\n'], [true, 'effort: [low]\n']] as const) {
      fs.rmSync(path.join(hq, '.claude'), { recursive: true, force: true });
      if (file) writeAgent(agentFile(line));
      const o = build();
      const tab = o.startTab('max');
      const tid = `tab:${tab.tabId}` as const;
      expect(o.getThread(tid)).toMatchObject({ effort: 'high', runDefaults: { effort: 'high', effortFromAgent: false } });
      expect(pair(argsOf(o, tid, 'max'), '--effort')).toBe('high');
    }
  });

  it('(b) an agent file that is a symlink out of the agents folder, or over the size cap, is not used', () => {
    settings.effort = 'high';
    const real = path.join(root, 'elsewhere.md');
    fs.writeFileSync(real, agentFile('effort: low\n'));
    fs.mkdirSync(path.join(hq, '.claude', 'agents'), { recursive: true });
    fs.symlinkSync(real, path.join(hq, '.claude', 'agents', 'max.md'));
    expect(agentEffort(hq, 'max')).toBeNull();
    fs.rmSync(path.join(hq, '.claude', 'agents', 'max.md'));
    writeAgent(agentFile('effort: low\n') + 'x'.repeat(300 * 1024));
    expect(agentEffort(hq, 'max')).toBeNull();
    expect(agentEffort(hq, '../max')).toBeNull();
  });

  it('(c) a per-chat choice wins over the agent file', () => {
    settings.effort = 'high';
    writeAgent(agentFile('effort: medium\n'));
    const tab = org.startTab('max');
    const tid = `tab:${tab.tabId}` as const;
    org.setRun(tid, { effort: 'max' });
    expect(pair(argsOf(org, tid, 'max'), '--effort')).toBe('max');
    expect(org.getThread(tid)).toMatchObject({ effort: 'max', runChoice: { effort: 'max' }, runDefaults: { effort: 'medium', effortFromAgent: true } });
    org.setRun(tid, { effort: null });
    expect(org.getThread(tid)).toMatchObject({ effort: 'medium' });
  });

  it('(d) the CoS chat ignores any agent file and keeps the org effort', () => {
    settings.effort = 'high';
    writeAgent(agentFile('effort: low\n'));
    fs.writeFileSync(path.join(hq, '.claude', 'agents', 'cos.md'), agentFile('effort: low\n').replace('max', 'cos'));
    expect(org.getThread('cos')).toMatchObject({ effort: 'high', runDefaults: { effort: 'high', effortFromAgent: false } });
    expect(pair(argsOf(org, 'cos', null), '--effort')).toBe('high');
  });
});
