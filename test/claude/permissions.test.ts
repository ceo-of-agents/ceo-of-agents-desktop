import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addAlwaysAllowRule, defaultSocketPath, ruleFor, summarize } from '../../src/main/claude/permissions';

const CWD = '/tmp/hq';

describe('ruleFor', () => {
  it('maps tools to rules', () => {
    expect(ruleFor('Bash', { command: 'git status' }, CWD)).toBe('Bash(git status *)');
    expect(ruleFor('Skill', { skill: 'ceo-of-agents:session-start' }, CWD)).toBe('Skill(ceo-of-agents:session-start)');
    expect(ruleFor('WebFetch', { url: 'https://example.com/a/b?c=1' }, CWD)).toBe('WebFetch(domain:example.com)');
    expect(ruleFor('Write', { file_path: '/tmp/hq/inbox/n.md' }, CWD)).toBe('Edit(/inbox/n.md)');
    expect(ruleFor('MultiEdit', { file_path: '/other/x.md' }, CWD)).toBe('Edit(//other/x.md)');
    expect(ruleFor('NotebookEdit', { notebook_path: '/tmp/hq/a.ipynb' }, CWD)).toBe('Edit(/a.ipynb)');
    expect(ruleFor('Edit', { file_path: 'rel.md' }, CWD)).toBe('Edit(/rel.md)');
    expect(ruleFor('Edit', { file_path: 'a/b/c.md' }, CWD)).toBe('Edit(/a/b/c.md)');
    expect(ruleFor('WebSearch', { query: 'x' }, CWD)).toBe('WebSearch');
    expect(ruleFor('Artifact', { action: 'publish', title: 'x' }, CWD)).toBe('');
    expect(ruleFor('Artifact', { action: 'read' }, CWD)).toBe('Artifact(action:read)');
  });
});

describe('summarize', () => {
  it('writes one line', () => {
    expect(summarize('Write', { file_path: '/tmp/hq/inbox/note.md' }, CWD)).toBe('Write inbox/note.md');
    expect(summarize('Bash', { command: 'git status' }, CWD)).toBe('Run: git status');
    expect(summarize('Skill', { skill: 'ceo-of-agents:session-start' }, CWD)).toBe('Use skill ceo-of-agents:session-start');
    expect(summarize('WebFetch', { url: 'https://example.com/' }, CWD)).toBe('Fetch https://example.com/');
    expect(summarize('Grep', { pattern: 'a' }, CWD)).toBe('Grep {"pattern":"a"}');
  });
  it('Artifact: a plain sentence, no raw JSON', () => {
    const publish = summarize('Artifact', { action: 'publish', file_path: '/abs/file.html', title: 'Capture test', icon: 'code', __artifactPublishTarget: 'x' }, CWD);
    expect(publish).toBe('Publish the artifact "Capture test"');
    const del = summarize('Artifact', { action: 'delete', url: 'https://claude.ai/artifact/Xk3m9Qw7RtB2nLp5VdHc4a' }, CWD);
    expect(del).toBe('Delete artifact Xk3m9Qw7RtB2nLp5VdHc4a');
    expect(publish + del).not.toMatch(/[{}]|__artifact|action/);
  });
  it('caps the JSON at 120 characters', () => {
    const s = summarize('Other', { text: 'x'.repeat(500) }, CWD);
    expect(s.startsWith('Other ')).toBe(true);
    expect(s.length - 'Other '.length).toBeLessThanOrEqual(120);
  });
});

describe('addAlwaysAllowRule', () => {
  let hq: string;
  beforeEach(() => {
    hq = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-hq-'));
  });
  afterEach(() => fs.rmSync(hq, { recursive: true, force: true }));
  const file = () => path.join(hq, '.claude', 'settings.local.json');

  it('creates the file', () => {
    addAlwaysAllowRule(hq, 'Bash(ls)');
    expect(fs.readFileSync(file(), 'utf8')).toBe(JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }, null, 2) + '\n');
  });

  it('keeps other keys and does not duplicate', () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ env: { A: '1' }, permissions: { allow: ['X'], deny: ['Y'], defaultMode: 'plan' }, other: [1] }));
    addAlwaysAllowRule(hq, 'Bash(ls)');
    addAlwaysAllowRule(hq, 'Bash(ls)');
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual({
      env: { A: '1' },
      permissions: { allow: ['X', 'Bash(ls)'], deny: ['Y'], defaultMode: 'plan' },
      other: [1],
    });
  });
});

describe('defaultSocketPath', () => {
  it('stays short', () => {
    expect(defaultSocketPath()).toContain('coa-perm-');
    expect(defaultSocketPath().length).toBeLessThan(104);
  });
});
