import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrgSession } from '../../src/main/org/org-session';
import type { Settings } from '../../src/shared/types';

const ORG_YAML = `org:
  id: T
  name: Test Org
cos:
  display_name: "Ada"
models:
  cos: opus
  departments: sonnet
departments:
  - id: engineering
    agent: max
    display_name: Max
    model: haiku
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
let settings: Partial<Settings>;
let org: OrgSession;
let userDeny: string[];
let userArtifact: unknown;
let denyPending: ReturnType<typeof vi.fn>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-run-'));
  hq = path.join(root, 'hq');
  fs.mkdirSync(hq, { recursive: true });
  fs.writeFileSync(path.join(hq, 'org.yaml'), ORG_YAML);
  fs.writeFileSync(path.join(hq, 'CLAUDE.md'), CLAUDE_MD);
  settings = { permissionMode: 'acceptEdits', effort: 'medium', cosModel: 'opus' };
  userDeny = [];
  userArtifact = {};
  denyPending = vi.fn(() => 0);
  org = new OrgSession('o1', hq, path.join(root, 'data'), {
    claudePath: () => 'claude',
    settings: () => settings as Settings,
    userDeny: () => userDeny,
    userArtifactSettings: () => userArtifact,
    restartWaitMs: 60,
    broker: { register: () => '{}', unregister: () => undefined, denyPending } as never,
    serverScript: 'server.js',
    nodePath: process.execPath,
    canStart: () => null,
    emit: () => undefined,
  });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const argsOf = (threadId: string, agent: string | null): string[] =>
  (org as any).makeSession(threadId, null, agent).args; // eslint-disable-line @typescript-eslint/no-explicit-any
const pair = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('model and effort of a session', () => {
  it('the CoS runs on the CoS model and the org effort', () => {
    const a = argsOf('cos', null);
    expect(pair(a, '--model')).toBe('opus');
    expect(pair(a, '--effort')).toBe('medium');
    expect(pair(a, '--permission-mode')).toBe('acceptEdits');
  });

  it('a department chat runs on the department model, else models.departments', () => {
    expect(pair(argsOf('tab:1', 'max'), '--model')).toBe('haiku');
    expect(pair(argsOf('tab:2', 'bea'), '--model')).toBe('sonnet');
  });

  it('passes no --model when nothing resolves, but always --effort', () => {
    settings = { permissionMode: 'default', effort: 'low', cosModel: null };
    const a = argsOf('cos', null);
    expect(a).not.toContain('--model');
    expect(pair(a, '--effort')).toBe('low');
  });

  it('the thread info shows the next turn values; a live session on older values is pending until it restarts', async () => {
    expect(org.getThread('cos')).toMatchObject({ model: 'opus', effort: 'medium', runPending: false });
    argsOf('cos', null);
    settings = { ...settings, effort: 'max', cosModel: 'sonnet' };
    expect(org.getThread('cos')).toMatchObject({ model: 'sonnet', effort: 'max', runPending: true });
    await org.restartSessions();
    expect(org.getThread('cos')).toMatchObject({ model: 'sonnet', effort: 'max', runPending: false });
  });

  it('the CoS default is pinned when the org override is a specific model id; tabs keep their org.yaml model', () => {
    expect(org.getThread('cos')?.runDefaults).toMatchObject({ model: 'opus', pinned: false });
    settings = { ...settings, model: 'claude-opus-5-5', cosModel: 'claude-opus-5-5' };
    expect(org.getThread('cos')).toMatchObject({ model: 'claude-opus-5-5', runDefaults: { model: 'claude-opus-5-5', pinned: true } });
    expect(pair(argsOf('cos', null), '--model')).toBe('claude-opus-5-5');
    const tab = org.startTab('max');
    expect(org.getThread(`tab:${tab.tabId}`)?.runDefaults).toMatchObject({ model: 'haiku', pinned: false });
  });

  it('a chat pinned to a specific model id passes it as --model', () => {
    org.setRun('cos', { model: 'claude-sonnet-4-5-20250929' });
    expect(pair(argsOf('cos', null), '--model')).toBe('claude-sonnet-4-5-20250929');
    expect(org.getThread('cos')?.runChoice?.model).toBe('claude-sonnet-4-5-20250929');
  });

  it('the thread info lists the ids seen so far', () => {
    expect(org.getThread('cos')?.seenModels).toEqual([]);
  });

  it('a department thread info shows the department model', () => {
    const tab = org.startTab('max');
    expect(org.getThread(`tab:${tab.tabId}`)).toMatchObject({ model: 'haiku', effort: 'medium' });
  });
});

const list = (args: string[], flag: string): string[] => {
  const i = args.indexOf(flag);
  if (i < 0) return [];
  const out: string[] = [];
  for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j]);
  return out;
};
const writeSettings = (file: string, v: unknown) => {
  fs.mkdirSync(path.join(hq, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(hq, '.claude', file), JSON.stringify(v));
};

// Chats may read the folder of the attached files (outside the hq) without a card.
const attachmentsRule = () => `Read(/${path.join(root, 'data', 'files')}/**)`;

describe('rules passed to a process', () => {
  it('allow = the plugin skill rule + the hq allow rules, no baseline of the app', () => {
    writeSettings('settings.json', { permissions: { allow: ['Edit(/**)', 'Bash(gh issue list *)', 'Bash', 'WebFetch', 'mcp__x', 'Read(~/**)'], deny: ['Read(/secrets/**)', 'Bash(git push *)'] } });
    writeSettings('settings.local.json', { permissions: { allow: ['Bash(make test)', 'Bash(gh issue list *)', 'Bash(*)', 'Bash(python *)'] } });
    userDeny = ['Read(//home/u/.ssh/**)'];
    const a = argsOf('cos', null);
    const allow = list(a, '--allowedTools');
    expect(allow).toEqual(['Skill(ceo-of-agents:*)', attachmentsRule(), `Edit(/${hq}/**)`, 'Bash(gh issue list *)', 'Bash(make test)']);
    expect(allow.some((r) => /^(Read|Grep|Glob|LS)$/.test(r) || r.includes('git pull') || r.includes('cat'))).toBe(false);
    expect(list(a, '--disallowedTools')).toEqual([`Read(/${hq}/secrets/**)`, 'Bash(git push *)', 'Read(//home/u/.ssh/**)']);
  });

  it('with no hq rules only the skill rule and the read rule for the attached files folder are passed', () => {
    expect(list(argsOf('cos', null), '--allowedTools')).toEqual(['Skill(ceo-of-agents:*)', attachmentsRule()]);
    expect(argsOf('cos', null)).not.toContain('--disallowedTools');
  });

  it('a rule added after the process started makes the next turn restart (allow, deny, user deny)', () => {
    argsOf('cos', null);
    expect(org.getThread('cos')?.runPending).toBe(false);
    writeSettings('settings.local.json', { permissions: { allow: ['Bash(make test)'] } });
    expect(org.getThread('cos')?.runPending).toBe(true);
    argsOf('cos', null);
    expect(org.getThread('cos')?.runPending).toBe(false);
    writeSettings('settings.json', { permissions: { deny: ['Bash(rm x)'] } });
    expect(org.getThread('cos')?.runPending).toBe(true);
    argsOf('cos', null);
    userDeny = ['Read(//x/**)'];
    expect(org.getThread('cos')?.runPending).toBe(true);
    argsOf('cos', null);
    expect(org.getThread('cos')?.runPending).toBe(false);
    // removing a rule file also changes the lists
    fs.rmSync(path.join(hq, '.claude', 'settings.json'));
    expect(org.getThread('cos')?.runPending).toBe(true);
  });
});

describe('artifact tools', () => {
  const envOf = (): NodeJS.ProcessEnv => (org as any).makeSession('cos', null, null).o.env; // eslint-disable-line @typescript-eslint/no-explicit-any
  const saved = process.env.CLAUDE_CODE_ARTIFACT;
  beforeEach(() => {
    delete process.env.CLAUDE_CODE_ARTIFACT;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CODE_ARTIFACT;
    else process.env.CLAUDE_CODE_ARTIFACT = saved;
  });

  it('sets CLAUDE_CODE_ARTIFACT=1 in the process env by default, for the CoS and a department', () => {
    expect(envOf().CLAUDE_CODE_ARTIFACT).toBe('1');
    expect(((org as any).makeSession('tab:x', null, 'max') as any).o.env.CLAUDE_CODE_ARTIFACT).toBe('1'); // eslint-disable-line @typescript-eslint/no-explicit-any
  });
  it('does not set it when the user settings turn artifacts off', () => {
    userArtifact = { enableArtifact: false };
    expect(envOf().CLAUDE_CODE_ARTIFACT).toBeUndefined();
    userArtifact = { env: { CLAUDE_CODE_DISABLE_ARTIFACT: '1' } };
    expect(envOf().CLAUDE_CODE_ARTIFACT).toBeUndefined();
  });
  it('leaves a value already in the app env as it is', () => {
    process.env.CLAUDE_CODE_ARTIFACT = '0';
    expect(envOf().CLAUDE_CODE_ARTIFACT).toBe('0');
  });
});

describe('restartSessions with a permission card pending', () => {
  it('denies the pending requests, notes it in the thread and stops a chat that never goes idle after the cap', async () => {
    const th = org.cos;
    vi.spyOn(th, 'restart').mockImplementation(() => new Promise(() => undefined));
    const stop = vi.spyOn(th, 'stop').mockResolvedValue(undefined);
    denyPending.mockImplementation((key: string) => (key === 'o1|cos' ? 2 : 0));
    const t0 = Date.now();
    await org.restartSessions();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(denyPending).toHaveBeenCalledWith('o1|cos');
    expect(stop).toHaveBeenCalledWith(0);
    expect(th.info().entries.filter((e) => e.kind === 'system').map((e) => e.text)).toEqual(['A permission request was cancelled to apply new settings.']);
  });

  it('a chat that restarts in time is not stopped, and nothing is said without pending requests', async () => {
    const restart = vi.spyOn(org.cos, 'restart').mockResolvedValue(undefined);
    const stop = vi.spyOn(org.cos, 'stop');
    await org.restartSessions();
    expect(restart).toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(org.cos.info().entries).toEqual([]);
  });
});

describe('MCP servers and forbidden connectors', () => {
  const sessionOf = (threadId: string, agent: string | null) => (org as any).makeSession(threadId, null, agent); // eslint-disable-line @typescript-eslint/no-explicit-any
  const envOf = (s: any) => s.o.env as Record<string, string | undefined>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const writeOrgForbidden = (patterns: unknown[]) => fs.appendFileSync(path.join(hq, 'org.yaml'), `accounts:\n  forbidden_connectors: ${JSON.stringify(patterns)}\n`);
  const writeLocal = (yaml: string) => fs.writeFileSync(path.join(hq, 'accounts.local.yaml'), yaml);
  /** An agent file; `tools: null` leaves the line out. */
  const writeAgent = (agent: string, tools: string | null) => {
    fs.mkdirSync(path.join(hq, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(hq, '.claude', 'agents', `${agent}.md`), `---\nname: ${agent}\n${tools === null ? '' : `tools: ${tools}\n`}---\nBody.\n`);
  };
  // the shell's value would otherwise leak in through childEnv
  const savedClaudeAiMcp = process.env.ENABLE_CLAUDEAI_MCP_SERVERS;
  beforeEach(() => {
    delete process.env.ENABLE_CLAUDEAI_MCP_SERVERS;
    writeAgent('max', 'Read, mcp__example-project__ping');
    writeAgent('bea', 'Read');
  });
  afterEach(() => {
    if (savedClaudeAiMcp === undefined) delete process.env.ENABLE_CLAUDEAI_MCP_SERVERS;
    else process.env.ENABLE_CLAUDEAI_MCP_SERVERS = savedClaudeAiMcp;
  });

  it('no chat passes --strict-mcp-config, nor a server definition of the user\'s: one --mcp-config value (the app\'s server)', () => {
    fs.writeFileSync(path.join(hq, '.mcp.json'), JSON.stringify({ mcpServers: { 'example-project': { command: 'node', env: { TOKEN: 'tok-SECRET' } } } }));
    for (const [id, agent] of [['cos', null], ['tab:1', 'max']] as const) {
      const a = argsOf(id, agent);
      expect(a).not.toContain('--strict-mcp-config');
      expect(list(a, '--mcp-config')).toEqual(['{}']);
      expect(a.join(' ')).not.toContain('tok-SECRET');
      expect(a).not.toContain('--settings');
    }
    expect(envOf(sessionOf('cos', null)).ENABLE_CLAUDEAI_MCP_SERVERS).toBeUndefined();
  });

  it('the forbidden patterns of org.yaml and accounts.local.yaml go to --disallowedTools after the hq and user rules; only `pattern` of local items is read', () => {
    writeSettings('settings.json', { permissions: { deny: ['Bash(git push *)'] } });
    userDeny = ['Read(//home/u/.ssh/**)'];
    writeOrgForbidden(['mcp__example-org__send', { pattern: 'mcp__example-obj__*', account: 'secret-label' }]);
    writeLocal('repo_paths:\n  example: /home/example/path\nforbidden_connectors:\n  - mcp__example-local__*\n  - {pattern: "claude.ai Example", account: other-secret}\n  - not-a-rule\n');
    const a = argsOf('cos', null);
    expect(list(a, '--disallowedTools')).toEqual(['Bash(git push *)', 'Read(//home/u/.ssh/**)', 'mcp__example-org__send', 'mcp__example-obj__*', 'mcp__example-local__*']);
    expect(a.join(' ')).not.toMatch(/secret-label|other-secret|\/home\/example\/path/);
    // a department gets the same list
    expect(list(argsOf('tab:1', 'max'), '--disallowedTools')).toEqual(list(a, '--disallowedTools'));
  });

  it('a whole-server pattern becomes deniedMcpServers in --settings (never coa); other patterns do not', () => {
    writeOrgForbidden(['mcp__example-forbidden__*', 'mcp__coa__*', 'mcp__example-tool__send', 'mcp__example-wild*']);
    const a = argsOf('tab:1', 'max');
    expect(JSON.parse(pair(a, '--settings'))).toEqual({ deniedMcpServers: [{ serverName: 'example-forbidden' }] });
    expect(pair(a, '--settings')).not.toContain('coa');
    expect(a.indexOf('--settings')).toBe(a.indexOf('--setting-sources') + 2);
    expect(list(a, '--disallowedTools')).toContain('mcp__coa__*'); // forbidden wins: the deny rule is still passed
  });

  it('claude.ai connectors are turned off with the environment when a pattern covers all of them', () => {
    expect(envOf(sessionOf('cos', null)).ENABLE_CLAUDEAI_MCP_SERVERS).toBeUndefined();
    writeLocal('forbidden_connectors:\n  - mcp__claude_ai_*\n');
    const s = sessionOf('cos', null);
    expect(envOf(s).ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
    expect(s.args).not.toContain('--settings');
    expect(list(s.args, '--disallowedTools')).toEqual(['mcp__claude_ai_*']);
    // one named connector is only a deny rule: the others stay on
    writeLocal('forbidden_connectors:\n  - mcp__claude.ai Example__*\n');
    const one = sessionOf('cos', null);
    expect(envOf(one).ENABLE_CLAUDEAI_MCP_SERVERS).toBeUndefined();
    expect(list(one.args, '--disallowedTools')).toEqual(['mcp__claude_ai_Example__*']);
    // a claude.ai connector is never in deniedMcpServers (its real name is not known): the deny rule is all there is
    expect(one.args).not.toContain('--settings');
  });

  it('a raw pattern names the real server in deniedMcpServers (never the sanitized name), and so does a sanitized rule through the hq\'s .mcp.json', () => {
    writeLocal('forbidden_connectors:\n  - mcp__example.dotted__*\n');
    userDeny = ['mcp__example_second__*'];
    fs.writeFileSync(path.join(hq, '.mcp.json'), JSON.stringify({ mcpServers: { 'example.second': { command: 'node' } } }));
    const a = argsOf('tab:1', 'max');
    expect(list(a, '--disallowedTools')).toEqual(['mcp__example_second__*', 'mcp__example_dotted__*']);
    expect(JSON.parse(pair(a, '--settings'))).toEqual({ deniedMcpServers: [{ serverName: 'example.dotted' }, { serverName: 'example.second' }] });
    expect(a).not.toContain('--strict-mcp-config');
  });

  describe('the MCP lock (--strict-mcp-config and claude.ai off)', () => {
    const locked = (s: any) => s.args.includes('--strict-mcp-config') && envOf(s).ENABLE_CLAUDEAI_MCP_SERVERS === 'false'; // eslint-disable-line @typescript-eslint/no-explicit-any
    const unlocked = (s: any) => !s.args.includes('--strict-mcp-config') && envOf(s).ENABLE_CLAUDEAI_MCP_SERVERS === undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => warn.mockRestore());

    it('a bad accounts.local.yaml locks every chat; the deny rules that could be built are still passed, and the permission server is still the one --mcp-config', () => {
      writeOrgForbidden(['mcp__example-org__send']);
      writeLocal('forbidden_connectors: [unclosed\n  - x: : :\n');
      for (const [id, agent] of [['cos', null], ['tab:1', 'max']] as const) {
        const s = sessionOf(id, agent);
        expect(locked(s)).toBe(true);
        const i = s.args.indexOf('--mcp-config');
        expect(s.args.slice(i, i + 4)).toEqual(['--mcp-config', '{}', '--strict-mcp-config', '--setting-sources']);
        expect(pair(s.args, '--permission-prompt-tool')).toBe('mcp__coa__permission_prompt');
        expect(list(s.args, '--disallowedTools')).toEqual(['mcp__example-org__send']);
      }
      expect(warn.mock.calls.some((c) => String(c[0]).includes('MCP locked'))).toBe(true);
    });

    it('other problems lock too: a pattern that is no rule, an item that is not a pattern, a list that is not a list, org.yaml unreadable', () => {
      writeLocal('forbidden_connectors:\n  - not-a-rule\n');
      expect(locked(sessionOf('cos', null))).toBe(true);
      writeLocal('forbidden_connectors:\n  - ""\n');
      expect(locked(sessionOf('cos', null))).toBe(true);
      writeLocal('forbidden_connectors: mcp__example__*\n');
      expect(locked(sessionOf('cos', null))).toBe(true);
      writeLocal('forbidden_connectors:\n  - mcp__example__*\n');
      expect(unlocked(sessionOf('cos', null))).toBe(true);
      fs.writeFileSync(path.join(hq, 'org.yaml'), 'org: [unclosed\n  - x: : :\n');
      expect(locked(sessionOf('cos', null))).toBe(true);
      fs.rmSync(path.join(hq, 'org.yaml'));
      expect(locked(sessionOf('cos', null))).toBe(true);
    });

    it('a missing accounts.local.yaml is no lock', () => {
      expect(fs.existsSync(path.join(hq, 'accounts.local.yaml'))).toBe(false);
      expect(unlocked(sessionOf('cos', null))).toBe(true);
      expect(unlocked(sessionOf('tab:1', 'max'))).toBe(true);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('MCP locked'))).toBe(false);
    });

    it('a department whose agent file has no tools line (none, empty, no file, unreadable) is locked, and only its tab', () => {
      writeAgent('bea', null);
      expect(locked(sessionOf('tab:2', 'bea'))).toBe(true);
      expect(unlocked(sessionOf('tab:1', 'max'))).toBe(true);
      expect(unlocked(sessionOf('cos', null))).toBe(true);
      writeAgent('bea', '""');
      expect(locked(sessionOf('tab:2', 'bea'))).toBe(true);
      writeAgent('bea', '[]');
      expect(locked(sessionOf('tab:2', 'bea'))).toBe(true);
      writeAgent('bea', 'Read');
      expect(unlocked(sessionOf('tab:2', 'bea'))).toBe(true);
      fs.rmSync(path.join(hq, '.claude', 'agents', 'bea.md'));
      expect(locked(sessionOf('tab:2', 'bea'))).toBe(true);
      fs.mkdirSync(path.join(hq, '.claude', 'agents', 'bea.md'));
      expect(locked(sessionOf('tab:2', 'bea'))).toBe(true);
      expect(unlocked(sessionOf('tab:1', 'max'))).toBe(true);
    });

    it('a department whose tools line has a * entry (every tool) is locked too, and only its tab; mcp__x__* is not a star', () => {
      for (const tools of ['"*"', '["*"]', 'Read, *']) {
        writeAgent('bea', tools);
        expect(locked(sessionOf('tab:2', 'bea'))).toBe(true);
        expect(unlocked(sessionOf('tab:1', 'max'))).toBe(true);
      }
      expect(warn.mock.calls.some((c) => String(c[0]).includes('MCP locked') && String(c[0]).includes('every tool'))).toBe(true);
      writeAgent('bea', 'Read, mcp__example-project__*');
      expect(unlocked(sessionOf('tab:2', 'bea'))).toBe(true);
    });

    it('a change of the lock makes the next message restart the process: a broken file locks, a fixed one unlocks', () => {
      const tab = org.startTab('max');
      const key = `tab:${tab.tabId}` as const;
      for (const [id, agent] of [['cos', null], [key, 'max']] as const) argsOf(id, agent);
      const pending = () => [org.getThread('cos')?.runPending, org.getThread(key)?.runPending];
      expect(pending()).toEqual([false, false]);
      writeLocal('forbidden_connectors: [unclosed\n');
      expect(pending()).toEqual([true, true]);
      expect(locked(sessionOf('cos', null))).toBe(true);
      sessionOf(key, 'max');
      expect(pending()).toEqual([false, false]);
      fs.rmSync(path.join(hq, 'accounts.local.yaml'));
      expect(pending()).toEqual([true, true]);
      expect(unlocked(sessionOf('cos', null))).toBe(true);
      sessionOf(key, 'max');
      expect(pending()).toEqual([false, false]);
      // a department's agent file loses its tools line: only that chat is pending
      writeAgent('max', null);
      expect(pending()).toEqual([false, true]);
      expect(locked(sessionOf(key, 'max'))).toBe(true);
      expect(pending()).toEqual([false, false]);
      writeAgent('max', 'Read');
      expect(pending()).toEqual([false, true]);
    });
  });

  it('a change in either forbidden file makes the idle process restart (runPending), then settles', () => {
    argsOf('cos', null);
    expect(org.getThread('cos')?.runPending).toBe(false);
    writeLocal('forbidden_connectors:\n  - mcp__example-local__*\n');
    expect(org.getThread('cos')?.runPending).toBe(true);
    argsOf('cos', null);
    expect(org.getThread('cos')?.runPending).toBe(false);
    writeOrgForbidden(['mcp__example-org__*']);
    expect(org.getThread('cos')?.runPending).toBe(true);
    argsOf('cos', null);
    expect(org.getThread('cos')?.runPending).toBe(false);
    // an unrelated key of accounts.local.yaml changes nothing
    writeLocal('forbidden_connectors:\n  - mcp__example-local__*\nlabel: x\n');
    expect(org.getThread('cos')?.runPending).toBe(false);
    fs.rmSync(path.join(hq, 'accounts.local.yaml'));
    expect(org.getThread('cos')?.runPending).toBe(true);
  });

  it('a pattern that covers the permission tool is still passed, with one warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeOrgForbidden(['mcp__*']);
    const a = argsOf('cos', null);
    expect(list(a, '--disallowedTools')).toEqual(['mcp__*']);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('permission_prompt'))).toHaveLength(1);
    warn.mockRestore();
  });
});

describe('loaded connectors', () => {
  const init = (th: any, servers: unknown[]) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    th.startSession(null, '2026-01-01');
    th.session.emit('init', 's', 'm', [], servers);
  };

  it('is not started before an init; lists servers per chat with the status that wins, and the deny rules\' block', () => {
    expect(org.loadedConnectors([])).toEqual({ started: false, loaded: [] });
    const tab = org.startTab('max');
    const tabThread = org.thread(`tab:${tab.tabId}`) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    init(org.cos, [{ name: 'coa', status: 'connected', source: 'dynamic' }, { name: 'example-project', status: 'connected', source: 'project' }, { name: 'claude.ai Example', status: 'connected', source: 'claudeai' }]);
    init(tabThread, [{ name: 'example-project', status: 'failed', source: 'project' }]);
    const r = org.loadedConnectors(['mcp__claude_ai_Example__send', 'mcp__example-project__*']);
    expect(r.started).toBe(true);
    expect(r.loaded).toEqual([
      { name: 'claude.ai Example', status: 'connected', source: 'claudeai', chats: ['Ada'], block: { kind: 'some', rule: 'mcp__claude_ai_Example__send' } },
      { name: 'example-project', status: 'failed', source: 'project', chats: ['Ada', 'Max'], block: { kind: 'all', rule: 'mcp__example-project__*' } },
    ]);
  });

  it('emits a connectors event when the list changes, not when it repeats', () => {
    const events: unknown[] = [];
    const o2 = new OrgSession('o2', hq, path.join(root, 'data2'), {
      claudePath: () => 'claude', settings: () => settings as Settings, restartWaitMs: 60,
      broker: { register: () => '{}', unregister: () => undefined, denyPending } as never,
      serverScript: 'server.js', nodePath: process.execPath, canStart: () => null, emit: (e) => events.push(e),
    });
    const same = [{ name: 'example-project', status: 'connected', source: 'project' }];
    init(o2.cos, same);
    expect(events.filter((e: any) => e.type === 'connectors')).toEqual([{ type: 'connectors', orgId: 'o2' }]); // eslint-disable-line @typescript-eslint/no-explicit-any
    (o2.cos as any).session.emit('init', 's', 'm', [], same); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(events.filter((e: any) => e.type === 'connectors')).toHaveLength(1); // eslint-disable-line @typescript-eslint/no-explicit-any
    (o2.cos as any).session.emit('init', 's', 'm', [], [{ name: 'example-project', status: 'failed', source: 'project' }]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(events.filter((e: any) => e.type === 'connectors')).toHaveLength(2); // eslint-disable-line @typescript-eslint/no-explicit-any
  });
});
