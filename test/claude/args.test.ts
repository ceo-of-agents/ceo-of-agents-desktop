import { describe, expect, it } from 'vitest';
import { buildClaudeArgs } from '../../src/main/claude/args';

describe('buildClaudeArgs', () => {
  it('builds the base arguments', () => {
    const a = buildClaudeArgs({ permissionMode: 'default', effort: 'high', mcpConfigJson: '{"mcpServers":{}}', allowedTools: ['Skill(ceo-of-agents:*)'] });
    expect(a).toEqual([
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', 'default',
      '--permission-prompt-tool', 'mcp__coa__permission_prompt',
      '--mcp-config', '{"mcpServers":{}}',
      '--setting-sources', 'project,local',
      '--allowedTools', 'Skill(ceo-of-agents:*)',
      '--effort', 'high',
    ]);
  });

  it('passes --strict-mcp-config (the MCP lock) right after the --mcp-config value, before --setting-sources, only when strictMcp is set', () => {
    const base = { permissionMode: 'default' as const, effort: 'high' as const, mcpConfigJson: '{"mcpServers":{"coa":{}}}', allowedTools: ['A'], settingsJson: '{"deniedMcpServers":[]}', agent: 'max' };
    expect(buildClaudeArgs({ ...base, strictMcp: false })).not.toContain('--strict-mcp-config');
    expect(buildClaudeArgs(base)).not.toContain('--strict-mcp-config');
    const a = buildClaudeArgs({ ...base, strictMcp: true });
    const i = a.indexOf('--mcp-config');
    expect(a.slice(i, i + 5)).toEqual(['--mcp-config', '{"mcpServers":{"coa":{}}}', '--strict-mcp-config', '--setting-sources', 'project,local']);
    expect(a.filter((x) => x === '--strict-mcp-config')).toHaveLength(1);
    expect(a).toContain('--permission-prompt-tool');
    // nothing else changes
    expect(a.filter((x) => x !== '--strict-mcp-config')).toEqual(buildClaudeArgs(base));
  });

  it('never passes --strict-mcp-config by default, so a chat loads the servers Claude Code loads in the hq folder', () => {
    const a = buildClaudeArgs({ permissionMode: 'default', effort: 'high', mcpConfigJson: '{}', allowedTools: ['A'], settingsJson: '{"deniedMcpServers":[]}', disallowedTools: ['mcp__x__*'], agent: 'max' });
    expect(a).not.toContain('--strict-mcp-config');
    expect(a.filter((x) => x === '--mcp-config')).toHaveLength(1);
  });

  it('passes --settings right after --setting-sources, only when given', () => {
    const base = { permissionMode: 'default' as const, effort: 'high' as const, mcpConfigJson: '{"mcpServers":{"coa":{}}}', allowedTools: ['A'] };
    const none = buildClaudeArgs(base);
    expect(none).not.toContain('--settings');
    expect(buildClaudeArgs({ ...base, settingsJson: '' })).toEqual(none);
    expect(buildClaudeArgs({ ...base, settingsJson: null })).toEqual(none);
    const json = '{"deniedMcpServers":[{"serverName":"example-forbidden"}]}';
    const a = buildClaudeArgs({ ...base, settingsJson: json });
    const i = a.indexOf('--setting-sources');
    expect(a.slice(i, i + 4)).toEqual(['--setting-sources', 'project,local', '--settings', json]);
    expect(a.filter((x) => x === '--settings')).toHaveLength(1);
    expect(a.filter((x) => x === json)).toHaveLength(1);
  });

  it('--mcp-config is variadic: an option always follows its value', () => {
    for (const settingsJson of [null, '{"deniedMcpServers":[]}']) {
      const a = buildClaudeArgs({ permissionMode: 'default', effort: 'high', mcpConfigJson: '{"mcpServers":{"coa":{}}}', allowedTools: [], settingsJson });
      const i = a.indexOf('--mcp-config');
      expect(a[i + 1]).toBe('{"mcpServers":{"coa":{}}}');
      expect(a[i + 2]).toBe('--setting-sources');
    }
  });

  it('adds the optional flags', () => {
    const a = buildClaudeArgs({
      permissionMode: 'acceptEdits',
      effort: 'medium',
      mcpConfigJson: '{}',
      allowedTools: ['A', 'B'],
      resumeSessionId: 's1',
      agent: 'max',
      model: 'haiku',
      pluginDir: '/p',
    });
    expect(a).toContain('acceptEdits');
    expect(a.join(' ')).toContain('--allowedTools A B');
    expect(a.slice(-10)).toEqual(['--resume', 's1', '--agent', 'max', '--model', 'haiku', '--effort', 'medium', '--plugin-dir', '/p']);
  });

  it('passes each rule as its own argument and adds the deny list', () => {
    const a = buildClaudeArgs({
      permissionMode: 'default',
      effort: 'low',
      mcpConfigJson: '{}',
      allowedTools: ['Bash(git log:*)', 'Edit(a b, c/**)'],
      disallowedTools: ['Bash(rm:*)'],
    });
    const i = a.indexOf('--allowedTools');
    expect(a.slice(i, i + 7)).toEqual(['--allowedTools', 'Bash(git log:*)', 'Edit(a b, c/**)', '--disallowedTools', 'Bash(rm:*)', '--effort', 'low']);
  });

  it('omits empty optionals', () => {
    const a = buildClaudeArgs({ permissionMode: 'plan', effort: 'low', mcpConfigJson: '{}', allowedTools: [], resumeSessionId: null, agent: null });
    for (const f of ['--resume', '--agent', '--model', '--plugin-dir', '--allowedTools', '--disallowedTools']) expect(a).not.toContain(f);
  });

  it('passes --model only when a model resolves, and always --effort', () => {
    const base = { permissionMode: 'default' as const, mcpConfigJson: '{}', allowedTools: [] };
    const none = buildClaudeArgs({ ...base, effort: 'xhigh', model: null });
    expect(none).not.toContain('--model');
    expect(none.slice(-2)).toEqual(['--effort', 'xhigh']);
    const withModel = buildClaudeArgs({ ...base, effort: 'max', model: 'opus' });
    expect(withModel.slice(-4)).toEqual(['--model', 'opus', '--effort', 'max']);
  });

  it('never passes --append-system-prompt, and an option always follows the variadic rule lists', () => {
    const base = { permissionMode: 'default' as const, effort: 'high' as const, mcpConfigJson: '{}', allowedTools: ['A', 'B'], disallowedTools: ['Bash(rm:*)', 'mcp__x__*'] };
    for (const agent of [undefined, 'max']) {
      const a = buildClaudeArgs({ ...base, agent });
      expect(a).not.toContain('--append-system-prompt');
      for (const flag of ['--allowedTools', '--disallowedTools']) {
        const j = a.indexOf(flag);
        const next = a.findIndex((x, k) => k > j && x.startsWith('--'));
        expect(next).toBeGreaterThan(j);
        expect(a.slice(j + 1, next).every((x) => !x.startsWith('--'))).toBe(true);
      }
    }
  });
});
