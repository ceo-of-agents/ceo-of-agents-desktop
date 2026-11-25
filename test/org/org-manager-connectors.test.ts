import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '../../src/shared/types';

vi.mock('../../src/main/system/prereqs', () => ({ checkPrereqs: vi.fn() }));

import { OrgManager } from '../../src/main/org/org-manager';

let root: string;
let hqDir: string;
let events: AppEvent[];
let manager: OrgManager;
let orgId: string;
let userDeny: string[];

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coa-mgr-conn-')));
  hqDir = path.join(root, 'hq');
  fs.mkdirSync(hqDir, { recursive: true });
  fs.writeFileSync(path.join(hqDir, 'org.yaml'), 'org:\n  id: T\ncos:\n  display_name: Ada\ndepartments:\n  - id: engineering\n    agent: max\n    display_name: Max\naccounts:\n  forbidden_connectors: ["mcp__example-org__*"]\n');
  fs.writeFileSync(path.join(hqDir, 'CLAUDE.md'), '# T\n\n| Agent | Name | Role | Id | Use for |\n|---|---|---|---|---|\n| max | Max | Engineering | engineering | Code |\n');
  fs.writeFileSync(path.join(hqDir, '.mcp.json'), JSON.stringify({ mcpServers: { 'example-project': { command: 'node' }, 'example-local': { command: 'node' } } }));
  events = [];
  userDeny = [];
  manager = new OrgManager({
    dataDir: path.join(root, 'data'),
    settings: { userDenyRules: () => userDeny, userArtifactSettings: () => ({}), get: () => ({ permissionMode: 'default', effort: 'low', cosModel: null }), seen: () => ({ add: () => undefined, list: () => [] }), newSessionAfterMinutes: () => 0, renewSessionAtTokens: () => 0 } as never,
    broker: { register: () => '{}', unregister: () => undefined } as never,
    serverScript: 's',
    nodePath: 'node',
    emit: (e) => events.push(e),
  });
  (manager as any).claudePath = 'claude'; // eslint-disable-line @typescript-eslint/no-explicit-any
  orgId = manager.registry.add(hqDir).id;
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('OrgManager.getConnectors', () => {
  it('without a live session: nothing loaded yet, kept-out servers and claude.ai from the deny list a new chat would get', () => {
    fs.writeFileSync(path.join(hqDir, 'accounts.local.yaml'), 'repo_paths:\n  x: /home/example\nforbidden_connectors:\n  - {pattern: mcp__example-local__*, account: secret-label}\n  - mcp__claude_ai_*\n');
    userDeny = ['mcp__example-user'];
    const c = manager.getConnectors(orgId);
    expect(c.session).toEqual({
      started: false,
      loaded: [],
      keptOut: ['example-local', 'example-org', 'example-user'],
      claudeAiOff: true,
      forbiddenRules: ['mcp__example-org__*', 'mcp__example-local__*', 'mcp__claude_ai_*'],
      mcpLocked: false,
    });
    expect(c.forbiddenProblems).toEqual([]);
    expect(c.forbiddenWarnings).toEqual([]);
    expect(c.forbidden).toEqual(['mcp__example-org__*']);
    expect(c.forbiddenLocal).toEqual(['mcp__example-local__*', 'mcp__claude_ai_*']);
    expect(c.available.map((a) => a.server)).toEqual(['example-project']);
    expect(JSON.stringify(c)).not.toMatch(/secret-label|\/home\/example/);
  });

  it('a problem in a forbidden list locks MCP and is listed with the other problems; a department with no tools line is flagged', () => {
    const ok = manager.getConnectors(orgId);
    expect(ok.session.mcpLocked).toBe(false);
    expect(ok.departments.map((d) => [d.agent, d.mcpLock])).toEqual([['max', 'no-tools-line']]);
    fs.mkdirSync(path.join(hqDir, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(hqDir, '.claude', 'agents', 'max.md'), '---\nname: max\ntools: "*"\n---\n');
    expect(manager.getConnectors(orgId).departments.map((d) => [d.agent, d.mcpLock])).toEqual([['max', 'all-tools']]);
    fs.writeFileSync(path.join(hqDir, '.claude', 'agents', 'max.md'), '---\nname: max\ntools: Read, mcp__example-project__ping\n---\n');
    expect(manager.getConnectors(orgId).departments.map((d) => [d.agent, d.mcpLock])).toEqual([['max', null]]);
    fs.rmSync(path.join(hqDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(hqDir, 'accounts.local.yaml'), 'forbidden_connectors:\n  - not-a-rule\n  - ""\n  - {account: secret-label}\n');
    const c = manager.getConnectors(orgId);
    expect(c.session.mcpLocked).toBe(true);
    expect(c.forbiddenProblems).toHaveLength(3);
    expect(c.forbiddenProblems.join('\n')).toContain('"not-a-rule"');
    expect(c.forbiddenProblems.join('\n')).toContain('Item 2 of forbidden_connectors in accounts.local.yaml');
    expect(JSON.stringify(c)).not.toContain('secret-label');
    // the rules that could be built are still there
    expect(c.session.forbiddenRules).toEqual(['mcp__example-org__*']);
    fs.writeFileSync(path.join(hqDir, 'accounts.local.yaml'), 'forbidden_connectors: [unclosed\n  - x: : :\n');
    expect(manager.getConnectors(orgId).session.mcpLocked).toBe(true);
    fs.rmSync(path.join(hqDir, 'accounts.local.yaml'));
    expect(manager.getConnectors(orgId).session.mcpLocked).toBe(false);
  });

  it('kept from starting: real names (a raw pattern, or a sanitized rule through the hq\'s .mcp.json), never a claude.ai connector', () => {
    fs.writeFileSync(path.join(hqDir, '.mcp.json'), JSON.stringify({ mcpServers: { 'example-project': { command: 'node' }, 'example.dotted': { command: 'node' }, 'example.second': { command: 'node' } } }));
    fs.writeFileSync(path.join(hqDir, 'accounts.local.yaml'), 'forbidden_connectors:\n  - mcp__example.dotted__*\n  - mcp__claude_ai_Example__*\n  - "mcp__claude.ai Example__*"\n  - mcp__example-raw.name\n');
    userDeny = ['mcp__example_second__*', 'mcp__claude_ai_Other'];
    const c = manager.getConnectors(orgId);
    expect(c.session.keptOut).toEqual(['example-org', 'example-raw.name', 'example.dotted', 'example.second']);
    expect(c.session.forbiddenRules).toEqual(expect.arrayContaining(['mcp__claude_ai_Example__*']));
    expect(c.session.claudeAiOff).toBe(false);
  });

  it('warns when a forbidden rule differs from a known server only by case (the hq\'s .mcp.json or a loaded one), without locking', () => {
    fs.writeFileSync(path.join(hqDir, 'accounts.local.yaml'), 'forbidden_connectors:\n  - mcp__Example-Project__*\n  - mcp__claude_ai_example__*\n  - mcp__example-local__*\n');
    const cos = manager.session(orgId).cos as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    cos.startSession(null, '2026-01-01');
    cos.session.emit('init', 's', 'm', [], [{ name: 'claude.ai Example', status: 'connected', source: 'claudeai' }]);
    const c = manager.getConnectors(orgId);
    expect(c.session.mcpLocked).toBe(false);
    expect(c.forbiddenWarnings).toHaveLength(2);
    expect(c.forbiddenWarnings[0]).toContain('mcp__Example-Project__*');
    expect(c.forbiddenWarnings[0]).toContain('example-project');
    expect(c.forbiddenWarnings[1]).toContain('claude.ai Example');
    expect(c.forbiddenWarnings.join('\n')).not.toContain('example-local');
  });

  it('with live chats: the loaded list comes from their init messages, with the chats and the deny block', () => {
    const session = manager.session(orgId);
    const cos = session.cos as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    cos.startSession(null, '2026-01-01');
    cos.session.emit('init', 's', 'm', [], [
      { name: 'coa', status: 'connected', source: 'dynamic' },
      { name: 'example-project', status: 'connected', source: 'project' },
      { name: 'example-local', status: 'connected', source: 'local' },
    ]);
    fs.writeFileSync(path.join(hqDir, 'accounts.local.yaml'), 'forbidden_connectors:\n  - mcp__example-local__send\n');
    const c = manager.getConnectors(orgId);
    expect(c.session.started).toBe(true);
    expect(c.session.loaded).toEqual([
      { name: 'example-local', status: 'connected', source: 'local', chats: ['Ada'], block: { kind: 'some', rule: 'mcp__example-local__send' } },
      { name: 'example-project', status: 'connected', source: 'project', chats: ['Ada'], block: null },
    ]);
    expect(events.filter((e) => e.type === 'connectors')).toEqual([{ type: 'connectors', orgId }]);
  });
});
