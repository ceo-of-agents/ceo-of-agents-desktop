import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  caseWarnings,
  coversAllClaudeAi,
  coversPermissionPrompt,
  forbiddenDenyRule,
  forbiddenDenyRules,
  mcpLaunch,
  rawServerNames,
  readForbiddenPatterns,
  serverBlock,
  serversKeptOut,
  toolPrefix,
} from '../../src/main/hq/forbidden-connectors';

const ORG_OK = 'org:\n  id: T\n';
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-forbidden-'));
  fs.writeFileSync(path.join(root, 'org.yaml'), ORG_OK);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const write = (name: string, text: string) => fs.writeFileSync(path.join(root, name), text);

const itemBad = (n: number, file: string) => `Item ${n} of forbidden_connectors in ${file} is not a pattern (a text, or an item with a pattern)`;

describe('readForbiddenPatterns', () => {
  it('reads strings and { pattern } items of both files, trimmed, without duplicates', () => {
    write('org.yaml', 'accounts:\n  forbidden_connectors:\n    - " mcp__example-a__* "\n    - mcp__example-a__*\n    - {pattern: mcp__example-b__send, note: x}\n');
    write('accounts.local.yaml', 'forbidden_connectors:\n  - mcp__example-c__*\n  - {pattern: mcp__example-d__*, account: secret-label, path: /home/example}\n');
    expect(readForbiddenPatterns(root)).toEqual({ org: ['mcp__example-a__*', 'mcp__example-b__send'], local: ['mcp__example-c__*', 'mcp__example-d__*'], problems: [] });
  });

  it('an item that is not a pattern is a problem naming the file and its 1-based position; the others still count', () => {
    write('org.yaml', 'accounts:\n  forbidden_connectors:\n    - mcp__example-a__*\n    - ""\n    - {pattern: mcp__example-b__send}\n    - 5\n    - {nopattern: 1}\n    - {pattern: ""}\n    - {pattern: 7}\n    - "   "\n');
    write('accounts.local.yaml', 'forbidden_connectors:\n  - [mcp__example__*]\n  - mcp__example-c__*\n');
    const r = readForbiddenPatterns(root);
    expect(r.org).toEqual(['mcp__example-a__*', 'mcp__example-b__send']);
    expect(r.local).toEqual(['mcp__example-c__*']);
    expect(r.problems).toEqual([2, 4, 5, 6, 7, 8].map((n) => itemBad(n, 'org.yaml')).concat(itemBad(1, 'accounts.local.yaml')));
  });

  it('never reads or returns any other key of accounts.local.yaml, also not in a problem text', () => {
    write('accounts.local.yaml', 'repo_paths:\n  example: /home/example/project\naccounts:\n  work: account-label@example.test\nforbidden_connectors:\n  - {pattern: mcp__example__*, account: account-label@example.test}\n  - {account: account-label@example.test}\n');
    const r = readForbiddenPatterns(root);
    expect(r.local).toEqual(['mcp__example__*']);
    expect(r.problems).toEqual([itemBad(2, 'accounts.local.yaml')]);
    const json = JSON.stringify(r);
    expect(json).not.toContain('account-label');
    expect(json).not.toContain('/home/example');
    expect(json).not.toContain('@example.test');
  });

  it('a missing or empty accounts.local.yaml, or one with no forbidden_connectors, is fine; a null list is empty', () => {
    expect(readForbiddenPatterns(root)).toEqual({ org: [], local: [], problems: [] });
    write('accounts.local.yaml', '');
    expect(readForbiddenPatterns(root).problems).toEqual([]);
    write('accounts.local.yaml', '# only a comment\n');
    expect(readForbiddenPatterns(root).problems).toEqual([]);
    write('accounts.local.yaml', 'repo_paths:\n  x: /y\n');
    expect(readForbiddenPatterns(root).problems).toEqual([]);
    write('accounts.local.yaml', 'forbidden_connectors:\n');
    expect(readForbiddenPatterns(root)).toEqual({ org: [], local: [], problems: [] });
    write('org.yaml', 'accounts:\n  forbidden_connectors:\n');
    expect(readForbiddenPatterns(root)).toEqual({ org: [], local: [], problems: [] });
    write('org.yaml', 'accounts:\n');
    expect(readForbiddenPatterns(root).problems).toEqual([]);
  });

  it('org.yaml missing, unreadable, too big, bad YAML or not a mapping is a problem', () => {
    fs.rmSync(path.join(root, 'org.yaml'));
    expect(readForbiddenPatterns(root).problems).toEqual(['org.yaml is missing']);
    write('org.yaml', 'org: [unclosed\n  - x: : :\n');
    expect(readForbiddenPatterns(root).problems[0]).toContain('org.yaml is not valid YAML');
    write('org.yaml', 'forbidden_connectors:\n' + '  - mcp__example__*\n'.repeat(20000));
    expect(readForbiddenPatterns(root).problems).toEqual(['org.yaml is too big']);
    for (const text of ['', '- a\n- b\n', 'just text\n']) {
      write('org.yaml', text);
      expect(readForbiddenPatterns(root).problems).toEqual(['org.yaml is not a mapping at the top level']);
    }
    fs.rmSync(path.join(root, 'org.yaml'));
    fs.mkdirSync(path.join(root, 'org.yaml'));
    expect(readForbiddenPatterns(root).problems[0]).toContain('org.yaml could not be read');
  });

  it('accounts that is not a mapping, and a forbidden_connectors that is not a list, are problems', () => {
    write('org.yaml', 'accounts: [1, 2]\n');
    expect(readForbiddenPatterns(root).problems).toEqual(['accounts in org.yaml is not a mapping']);
    write('org.yaml', 'accounts: text\n');
    expect(readForbiddenPatterns(root).problems).toEqual(['accounts in org.yaml is not a mapping']);
    write('org.yaml', 'accounts:\n  forbidden_connectors: mcp__example__*\n');
    expect(readForbiddenPatterns(root).problems).toEqual(['forbidden_connectors in org.yaml is not a list']);
    write('org.yaml', ORG_OK);
    write('accounts.local.yaml', 'forbidden_connectors: mcp__example__*\n');
    expect(readForbiddenPatterns(root).problems).toEqual(['forbidden_connectors in accounts.local.yaml is not a list']);
    write('accounts.local.yaml', 'forbidden_connectors:\n  mcp__example__*: 1\n');
    expect(readForbiddenPatterns(root).problems).toEqual(['forbidden_connectors in accounts.local.yaml is not a list']);
  });

  it('accounts.local.yaml: bad YAML, over 256 KB, a folder or a non-mapping is a problem, and the other file still counts', () => {
    write('org.yaml', 'accounts:\n  forbidden_connectors: [mcp__example__*]\n');
    write('accounts.local.yaml', 'forbidden_connectors: [unclosed\n  - x: : :\n');
    const bad = readForbiddenPatterns(root);
    expect(bad.org).toEqual(['mcp__example__*']);
    expect(bad.local).toEqual([]);
    expect(bad.problems).toHaveLength(1);
    expect(bad.problems[0]).toContain('accounts.local.yaml');
    write('accounts.local.yaml', 'forbidden_connectors:\n' + '  - mcp__example__*\n'.repeat(20000));
    expect(readForbiddenPatterns(root).problems).toEqual(['accounts.local.yaml is too big']);
    write('accounts.local.yaml', '- a\n- b\n');
    expect(readForbiddenPatterns(root).problems).toEqual(['accounts.local.yaml is not a mapping at the top level']);
    fs.rmSync(path.join(root, 'accounts.local.yaml'));
    fs.mkdirSync(path.join(root, 'accounts.local.yaml'));
    expect(readForbiddenPatterns(root).problems[0]).toContain('accounts.local.yaml');
  });

  it('a non-existent folder does not throw: org.yaml is missing', () => {
    expect(readForbiddenPatterns(path.join(root, 'nope'))).toEqual({ org: [], local: [], problems: ['org.yaml is missing'] });
  });
});

describe('forbiddenDenyRule', () => {
  it('maps a pattern to a deny rule', () => {
    expect(forbiddenDenyRule('*')).toBe('mcp__*');
    expect(forbiddenDenyRule('  *  ')).toBe('mcp__*');
    expect(forbiddenDenyRule('mcp__example__*')).toBe('mcp__example__*');
    expect(forbiddenDenyRule(' mcp__example__send ')).toBe('mcp__example__send');
    expect(forbiddenDenyRule('mcp__example')).toBe('mcp__example');
  });
  it('turns every character outside [A-Za-z0-9_*-] after mcp__ into _, as Claude Code does in tool names', () => {
    expect(forbiddenDenyRule('mcp__claude.ai Example__*')).toBe('mcp__claude_ai_Example__*');
    expect(forbiddenDenyRule('mcp__a(b)c')).toBe('mcp__a_b_c');
  });
  it('rejects anything else', () => {
    for (const p of ['', 'mcp__', 'Bash(rm *)', 'example', 'mcp_example', '**', 'claude.ai Example']) expect(forbiddenDenyRule(p)).toBeNull();
    expect(forbiddenDenyRule('mcp__' + 'a'.repeat(195))).toBe('mcp__' + 'a'.repeat(195)); // 200 characters
    expect(forbiddenDenyRule('mcp__' + 'a'.repeat(196))).toBeNull();
    expect(forbiddenDenyRule(5 as never)).toBeNull();
  });
  it('forbiddenDenyRules joins both lists, deduped; a pattern that is not a rule is a problem, quoted and cut to 80 characters', () => {
    expect(forbiddenDenyRules({ org: ['mcp__a__*', 'nope'], local: ['mcp__a__*', '*', 'mcp__b'] })).toEqual({
      rules: ['mcp__a__*', 'mcp__*', 'mcp__b'],
      problems: ['The pattern "nope" cannot become a deny rule (it must be * or start with mcp__ followed by a name, at most 200 characters)'],
    });
    const long = 'mcp__' + 'a'.repeat(300);
    const r = forbiddenDenyRules({ org: ['mcp__', 'Bash(rm *)', long], local: ['mcp__', long] });
    expect(r.rules).toEqual([]);
    expect(r.problems).toHaveLength(3);
    expect(r.problems[2]).toContain(`"${long.slice(0, 80)}…"`);
    expect(r.problems[2]).not.toContain(long.slice(0, 81));
  });
  it('coversPermissionPrompt: a rule that matches the app\'s own permission tool', () => {
    expect(coversPermissionPrompt(['mcp__*'])).toBe(true);
    expect(coversPermissionPrompt(['mcp__coa__*'])).toBe(true);
    expect(coversPermissionPrompt(['mcp__example__*', 'mcp__claude_ai_*'])).toBe(false);
  });
});

describe('serversKeptOut', () => {
  it('names the servers of bare and whole-server rules, sorted and unique', () => {
    expect(serversKeptOut(['mcp__example-b__*', 'mcp__example-a', 'mcp__example-b', 'mcp__Example_c__*'])).toEqual(['Example_c', 'example-a', 'example-b']);
  });
  it('leaves out wildcards, tool rules, names with __ or odd characters, other tools, the app\'s own server and claude.ai connectors', () => {
    expect(serversKeptOut(['mcp__*', 'mcp__ex*', 'mcp__example__send', 'mcp__a__b__*', 'mcp__a__b', 'mcp__claude_ai_Example__*', 'mcp__claude_ai_Example', 'mcp__coa', 'mcp__coa__*', 'mcp__coa__permission_prompt', 'mcp__', 'Bash(rm *)', 'mcp__a.b__*', '*'])).toEqual([]);
  });
  it('a sanitized rule is mapped to the real name of a known server (the hq\'s .mcp.json), else it stays as it is', () => {
    expect(serversKeptOut(['mcp__example_dotted__*'], [], ['example.dotted', 'other'])).toEqual(['example.dotted']);
    expect(serversKeptOut(['mcp__example_dotted'], [], ['other'])).toEqual(['example_dotted']);
    // two servers with the same tool prefix: both real names
    expect(serversKeptOut(['mcp__a_b__*'], [], ['a.b', 'a_b'])).toEqual(['a.b', 'a_b']);
    // the app's own server is never mapped to, and a claude.ai name is never kept out
    expect(serversKeptOut(['mcp__claude_ai_Example__*'], [], ['claude.ai Example'])).toEqual([]);
  });
  it('real names of raw patterns are used as they are, and explain the sanitized rule', () => {
    expect(serversKeptOut(['mcp__example_dotted__*'], ['example.dotted'])).toEqual(['example.dotted']);
    expect(serversKeptOut(['mcp__a__*'], ['example.dotted'])).toEqual(['a', 'example.dotted']);
  });
});

describe('rawServerNames', () => {
  it('takes S of exactly mcp__<S> or mcp__<S>__*, as written (the real name)', () => {
    expect(rawServerNames(['mcp__example.dotted__*', ' mcp__example-b ', 'mcp__Example Space__*'])).toEqual(['Example Space', 'example-b', 'example.dotted']);
  });
  it('leaves out wildcards, tool rules, __, control characters, over 200 characters, coa, claude.ai names and what is no rule', () => {
    const none = ['*', 'mcp__*', 'mcp__ex*', 'mcp__example__send', 'mcp__a__b__*', 'mcp__coa', 'mcp__coa__*', 'mcp__', 'Bash(rm *)', 'mcp__a\u0007b__*', 'mcp__' + 'a'.repeat(196), 'mcp__claude.ai Example__*', 'mcp__claude_ai_Example__*', 'mcp__claude.ai Example'];
    expect(rawServerNames(none)).toEqual([]);
    expect(rawServerNames(['mcp__' + 'a'.repeat(195)])).toEqual(['a'.repeat(195)]);
  });
});

describe('caseWarnings', () => {
  it('warns when a rule would cut a known server if the case were the same', () => {
    const w = caseWarnings(['mcp__EXAMPLE-PROJECT__*', 'mcp__Example-Local', 'mcp__example-other__*', 'mcp__*__send'], ['example-project', 'example-local', 'example-other']);
    expect(w).toEqual([
      'The pattern mcp__EXAMPLE-PROJECT__* differs from the server example-project only by case. Claude Code matches names case-sensitively, so it does not apply to that server.',
      'The pattern mcp__Example-Local differs from the server example-local only by case. Claude Code matches names case-sensitively, so it does not apply to that server.',
    ]);
  });
  it('no warning for an exact match, an unrelated rule or a duplicate server name; at most 20', () => {
    expect(caseWarnings(['mcp__example-project__*'], ['example-project', 'example-project'])).toEqual([]);
    expect(caseWarnings(['mcp__other__*'], ['example-project'])).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => `server-${i}`);
    expect(caseWarnings(['mcp__SERVER-*__*'], many)).toHaveLength(20);
  });
});

describe('coversAllClaudeAi', () => {
  it('is true for a rule that covers every claude.ai connector', () => {
    for (const r of ['*', 'mcp__*', 'mcp__claude*', 'mcp__claude_ai_*', 'mcp__c**', 'mcp__claude_ai_**']) expect(coversAllClaudeAi(['Bash(x)', r])).toBe(true);
  });
  it('is false for a rule that names one connector or a tool', () => {
    for (const r of ['mcp__claude_ai_Example__*', 'mcp__*__send', 'mcp__claude_ai_Example', 'mcp__example__*', 'mcp__claude_ai_x*', 'Bash(rm *)', 'mcp__a*']) expect(coversAllClaudeAi([r])).toBe(false);
    expect(coversAllClaudeAi([])).toBe(false);
  });
});

describe('mcpLaunch', () => {
  it('nothing forbidden: no settings, no env', () => {
    expect(mcpLaunch([])).toEqual({ settingsJson: null, env: {}, keptOut: [], claudeAiOff: false });
    expect(mcpLaunch(['Bash(rm *)', 'mcp__example__send'])).toEqual({ settingsJson: null, env: {}, keptOut: [], claudeAiOff: false });
  });
  it('whole-server rules become deniedMcpServers', () => {
    const l = mcpLaunch(['mcp__example-b__*', 'mcp__example-a', 'mcp__coa__*']);
    expect(l.keptOut).toEqual(['example-a', 'example-b']);
    expect(JSON.parse(l.settingsJson as string)).toEqual({ deniedMcpServers: [{ serverName: 'example-a' }, { serverName: 'example-b' }] });
    expect(l.env).toEqual({});
  });
  it('takes the real names from the caller (deniedMcpServers needs them)', () => {
    const l = mcpLaunch(['mcp__example_dotted__*'], ['example.dotted']);
    expect(l.keptOut).toEqual(['example.dotted']);
    expect(JSON.parse(l.settingsJson as string)).toEqual({ deniedMcpServers: [{ serverName: 'example.dotted' }] });
    expect(mcpLaunch(['mcp__claude_ai_Example__*'])).toEqual({ settingsJson: null, env: {}, keptOut: [], claudeAiOff: false });
  });
  it('locked: claude.ai is off through the environment whatever the rules are', () => {
    expect(mcpLaunch([], [], true)).toEqual({ settingsJson: null, env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' }, keptOut: [], claudeAiOff: false });
  });
  it('a rule over all claude.ai connectors turns them off through the environment', () => {
    expect(mcpLaunch(['mcp__claude_ai_*'])).toEqual({ settingsJson: null, env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' }, keptOut: [], claudeAiOff: true });
    expect(mcpLaunch(['mcp__*']).claudeAiOff).toBe(true);
  });
});

describe('toolPrefix and serverBlock', () => {
  it('toolPrefix rewrites characters outside [A-Za-z0-9_-]', () => {
    expect(toolPrefix('example-server')).toBe('mcp__example-server');
    expect(toolPrefix('claude.ai Example')).toBe('mcp__claude_ai_Example');
  });
  it('all: a bare rule, a whole-server rule or a wildcard over the server', () => {
    expect(serverBlock('example-server', ['mcp__example-server'])).toEqual({ kind: 'all', rule: 'mcp__example-server' });
    expect(serverBlock('example-server', ['mcp__example-server__*'])).toEqual({ kind: 'all', rule: 'mcp__example-server__*' });
    expect(serverBlock('example-local', ['mcp__example-l*'])).toEqual({ kind: 'all', rule: 'mcp__example-l*' });
    expect(serverBlock('example-local', ['mcp__*'])).toEqual({ kind: 'all', rule: 'mcp__*' });
  });
  it('some: a rule on one tool; all wins over some', () => {
    expect(serverBlock('example-project', ['mcp__example-project__send'])).toEqual({ kind: 'some', rule: 'mcp__example-project__send' });
    expect(serverBlock('example-project', ['mcp__example-project__send', 'mcp__example-*'])).toEqual({ kind: 'all', rule: 'mcp__example-*' });
  });
  it('none: unrelated rules, a longer server name, a tool wildcard in the middle', () => {
    expect(serverBlock('example-project', [])).toBeNull();
    expect(serverBlock('example-project', ['mcp__example-project2__*', 'mcp__other__*', 'Bash(rm *)', 'mcp__*__send'])).toBeNull();
  });
  it('claude.ai connectors: the name is matched through its tool prefix', () => {
    expect(serverBlock('claude.ai Example', ['mcp__claude_ai_Example__*'])).toEqual({ kind: 'all', rule: 'mcp__claude_ai_Example__*' });
    expect(serverBlock('claude.ai Example', ['mcp__claude_ai_*'])).toEqual({ kind: 'all', rule: 'mcp__claude_ai_*' });
    expect(serverBlock('claude.ai Example', ['mcp__claude_ai_Example__send'])).toEqual({ kind: 'some', rule: 'mcp__claude_ai_Example__send' });
    expect(serverBlock('claude.ai Example', ['mcp__claude_ai_Other__*'])).toBeNull();
  });
});
