// The recorded init messages of Claude Code 2.1.327 (fake servers, see fixtures/claude/fake-mcp-server.mjs) read through the stream parser:
// what loads without --strict-mcp-config, and what the deny rules and an agent's tools: line cut.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StreamParser } from '../../src/main/claude/stream';
import type { ClaudeEvent } from '../../src/main/claude/stream';
import { caseWarnings, mcpLaunch, rawServerNames, serverBlock, serversKeptOut } from '../../src/main/hq/forbidden-connectors';

const FIX = path.join(__dirname, '..', 'fixtures', 'claude');
type Init = Extract<ClaudeEvent, { kind: 'init' }>;
const inits = (name: string): Init[] => new StreamParser().feed(fs.readFileSync(path.join(FIX, name), 'utf8')).filter((e): e is Init => e.kind === 'init');
/** The tool names a process offers, read from the raw init line (the parser keeps no tools list). */
const toolsOf = (name: string, line: number): string[] => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8').trim().split('\n')[line]).tools as string[];
const mcpTools = (tools: string[]) => tools.filter((x) => x.startsWith('mcp__'));
const DENY_COS = ['mcp__example-forbidden__*', 'mcp__example-l*'];

describe('chief of staff process (no --strict-mcp-config)', () => {
  const [first, later] = inits('mcp-init-cos.jsonl');
  const tools = toolsOf('mcp-init-cos.jsonl', 1);

  it('the first init has every server pending, later ones are connected, each with its scope', () => {
    expect(first.mcpServers.map((s) => s.status)).toEqual(['pending', 'pending', 'pending']);
    expect(later.mcpServers).toEqual([
      { name: 'example-project', status: 'connected', source: 'project' },
      { name: 'example-remote', status: 'connected', source: 'project' },
      { name: 'example-local', status: 'connected', source: 'local' },
    ]);
    expect(later.mcpFailed).toEqual([]);
  });

  it('a stdio and an http server of the hq\'s .mcp.json load and their tools are offered', () => {
    expect(tools).toEqual(expect.arrayContaining(['mcp__example-project__ping', 'mcp__example-project__send', 'mcp__example-remote__ping', 'mcp__example-remote__send']));
  });

  it('a local-scope server loads, but a deny rule with a wildcard removed all its tools', () => {
    expect(later.mcpServers.find((s) => s.name === 'example-local')).toMatchObject({ status: 'connected', source: 'local' });
    expect(tools.filter((x) => x.startsWith('mcp__example-local__'))).toEqual([]);
    expect(serverBlock('example-local', DENY_COS)).toEqual({ kind: 'all', rule: 'mcp__example-l*' });
    expect(serverBlock('example-project', DENY_COS)).toBeNull();
  });

  it('a server kept out with deniedMcpServers never shows in mcp_servers, and the whole-server rule names it', () => {
    for (const i of [first, later]) expect(i.mcpServers.map((s) => s.name)).not.toContain('example-forbidden');
    expect(serversKeptOut(['mcp__example-forbidden__*'])).toEqual(['example-forbidden']);
    expect(JSON.parse(mcpLaunch(DENY_COS).settingsJson as string)).toEqual({ deniedMcpServers: [{ serverName: 'example-forbidden' }] });
  });
});

describe('department process (--agent with a tools: line)', () => {
  const [, later] = inits('mcp-init-agent.jsonl');
  const tools = toolsOf('mcp-init-agent.jsonl', 1);

  it('three servers connect, but only the one tool of the agent file is offered', () => {
    expect(later.mcpServers.map((s) => `${s.name}:${s.status}`)).toEqual(['example-project:connected', 'example-remote:connected', 'example-local:connected']);
    expect(tools).toEqual(['Read', 'mcp__example-project__ping']);
    expect(mcpTools(tools)).toEqual(['mcp__example-project__ping']);
  });

  it('the department cannot call another tool of its server, nor any tool of the other servers', () => {
    expect(tools).not.toContain('mcp__example-project__send');
    expect(tools.filter((x) => x.startsWith('mcp__example-remote__') || x.startsWith('mcp__example-local__'))).toEqual([]);
  });
});

describe('department process with no tools: line (--agent)', () => {
  const inits_ = inits('mcp-init-notools.jsonl');
  const tools = toolsOf('mcp-init-notools.jsonl', 1);

  it('is offered every MCP tool of every loaded server, the forbidden one that is not kept out included: the reason for the MCP lock', () => {
    expect(inits_[1].mcpServers.map((s) => s.name)).toEqual(['example-project', 'example.dotted', 'example-forbidden', 'example-local', 'coa']);
    expect(mcpTools(tools)).toHaveLength(10);
    for (const s of ['coa', 'example_dotted', 'example-forbidden', 'example-local', 'example-project']) expect(tools).toEqual(expect.arrayContaining([`mcp__${s}__ping`, `mcp__${s}__send`]));
  });
});

describe('deny rules are case-sensitive', () => {
  const tools = toolsOf('mcp-init-case.jsonl', 1);

  it('rules that differ only by case removed nothing, so the app warns about them', () => {
    expect(mcpTools(tools)).toHaveLength(10);
    expect(tools).toEqual(expect.arrayContaining(['mcp__example-project__ping', 'mcp__example-local__send']));
    // what was passed: `--disallowedTools 'mcp__EXAMPLE-PROJECT__*' 'mcp__Example-Local'`
    expect(serverBlock('example-project', ['mcp__EXAMPLE-PROJECT__*'])).toBeNull();
    expect(serverBlock('example-local', ['mcp__Example-Local'])).toBeNull();
    expect(caseWarnings(['mcp__EXAMPLE-PROJECT__*', 'mcp__Example-Local'], ['example-project', 'example-local'])).toHaveLength(2);
  });
});

describe('--strict-mcp-config (the MCP lock)', () => {
  for (const file of ['mcp-init-strict-cos.jsonl', 'mcp-init-strict-agent.jsonl']) {
    it(`${file}: only the app's own server starts and only mcp__coa__* tools are offered, with or without --agent`, () => {
      for (const i of inits(file)) expect(i.mcpServers.map((s) => `${s.name}:${s.status}`).filter((x) => !x.startsWith('coa:'))).toEqual([]);
      const last = inits(file)[1];
      expect(last.mcpServers.map((s) => s.name)).toContain('coa');
      for (const line of [0, 1]) expect(mcpTools(toolsOf(file, line)).every((x) => x.startsWith('mcp__coa__'))).toBe(true);
      expect(mcpTools(toolsOf(file, 1))).toEqual(['mcp__coa__ping', 'mcp__coa__send']);
    });
  }
});

describe('a tools line of * (--agent)', () => {
  it('gives every tool, the MCP tools of every loaded server included: the reason a * entry locks the department', () => {
    const last = inits('mcp-init-star.jsonl')[1];
    expect(last.mcpServers.map((s) => s.name)).toEqual(['example-project', 'coa']);
    expect(mcpTools(toolsOf('mcp-init-star.jsonl', 1))).toEqual(
      expect.arrayContaining(['mcp__coa__ping', 'mcp__coa__send', 'mcp__example-project__ping', 'mcp__example-project__send']),
    );
  });
});

describe('--strict-mcp-config with an agent-frontmatter mcpServers and a plugin .mcp.json (--plugin-dir)', () => {
  for (const file of ['mcp-init-inline-strict.jsonl', 'mcp-init-plugin-strict.jsonl', 'mcp-init-plugin-strict-agent.jsonl']) {
    it(`${file}: only coa starts and only mcp__coa__* tools are offered`, () => {
      for (const i of inits(file)) expect(i.mcpServers.map((s) => s.name)).toEqual(['coa']);
      for (const line of [0, 1]) {
        const m = mcpTools(toolsOf(file, line));
        expect(m.length).toBeGreaterThan(0);
        expect(m.every((x) => x.startsWith('mcp__coa__'))).toBe(true);
      }
    });
  }
});

describe('deniedMcpServers needs the real server name', () => {
  it('the sanitized name (example_dotted) does not stop the server, the real name (example.dotted) does', () => {
    const sanitized = inits('mcp-init-denied-sanitized.jsonl')[1];
    const real = inits('mcp-init-denied-real.jsonl')[1];
    expect(sanitized.mcpServers.map((s) => s.name)).toContain('example.dotted');
    expect(real.mcpServers.map((s) => s.name)).not.toContain('example.dotted');
    expect(toolsOf('mcp-init-denied-sanitized.jsonl', 1)).toContain('mcp__example_dotted__ping');
    expect(mcpTools(toolsOf('mcp-init-denied-real.jsonl', 1)).filter((x) => x.startsWith('mcp__example_dotted__'))).toEqual([]);
  });

  it('the app builds the real name from a raw pattern, or from the hq\'s .mcp.json for a sanitized rule', () => {
    expect(JSON.parse(mcpLaunch(['mcp__example_dotted__*'], serversKeptOut(['mcp__example_dotted__*'], rawServerNames(['mcp__example.dotted__*']))).settingsJson as string)).toEqual({ deniedMcpServers: [{ serverName: 'example.dotted' }] });
    expect(serversKeptOut(['mcp__example_dotted__*'], [], ['example.dotted'])).toEqual(['example.dotted']);
  });
});
