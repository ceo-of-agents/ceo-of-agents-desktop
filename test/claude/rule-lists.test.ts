import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPermissionRules, removeSavedAllowRule } from '../../src/main/claude/rule-lists';

let hq: string;
beforeEach(() => {
  hq = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-rl-'));
  fs.mkdirSync(path.join(hq, '.claude'));
});
afterEach(() => fs.rmSync(hq, { recursive: true, force: true }));

const shared = () => path.join(hq, '.claude', 'settings.json');
const local = () => path.join(hq, '.claude', 'settings.local.json');
const write = (file: string, data: unknown) => fs.writeFileSync(file, JSON.stringify(data));

describe('buildPermissionRules', () => {
  it('is empty for an hq with no settings files', () => {
    expect(buildPermissionRules(hq, [])).toEqual({ hqAllow: [], savedAllow: [], deny: [] });
  });

  it('keeps the hq list and the saved list apart and flags the rules the app drops', () => {
    write(shared(), { permissions: { allow: ['Bash(npm test)', 'Bash(rm *)'] } });
    write(local(), { permissions: { allow: ['Bash(git status *)'] } });
    const r = buildPermissionRules(hq, []);
    expect(r.hqAllow).toEqual([
      { rule: 'Bash(npm test)', dropped: false },
      { rule: 'Bash(rm *)', dropped: true },
    ]);
    expect(r.savedAllow).toEqual([{ rule: 'Bash(git status *)', dropped: false }]);
  });

  it('lists deny rules of the hq and of the user once each, hq first', () => {
    write(shared(), { permissions: { deny: ['Bash(git push *)'] } });
    write(local(), { permissions: { deny: ['Read(//secret/**)', 'Bash(git push *)'] } });
    const r = buildPermissionRules(hq, ['Read(//secret/**)', 'WebFetch', 'WebFetch']);
    expect(r.deny).toEqual([
      { rule: 'Bash(git push *)', source: 'hq' },
      { rule: 'Read(//secret/**)', source: 'hq' },
      { rule: 'WebFetch', source: 'user' },
    ]);
  });

  it('skips blank, multi-line and non-string entries', () => {
    write(shared(), { permissions: { allow: ['', '  ', 'Bash(a)\nBash(b)', 7, 'Bash(npm test)', 'Bash(npm test)'] } });
    expect(buildPermissionRules(hq, []).hqAllow.map((e) => e.rule)).toEqual(['Bash(npm test)']);
  });
});

describe('removeSavedAllowRule', () => {
  it('removes only the exact rule and keeps other keys and other rules', () => {
    write(local(), { effortLevel: 'high', permissions: { defaultMode: 'default', allow: ['Bash(npm test)', 'Bash(npm test *)', 'Bash(git status *)'], deny: ['Bash(x)'] } });
    expect(removeSavedAllowRule(hq, 'Bash(npm test)')).toBe(true);
    expect(JSON.parse(fs.readFileSync(local(), 'utf8'))).toEqual({
      effortLevel: 'high',
      permissions: { defaultMode: 'default', allow: ['Bash(npm test *)', 'Bash(git status *)'], deny: ['Bash(x)'] },
    });
  });

  it('returns false and does not write when the rule is absent', () => {
    const text = JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } });
    fs.writeFileSync(local(), text);
    const before = fs.statSync(local()).mtimeMs;
    expect(removeSavedAllowRule(hq, 'Bash(npm test *)')).toBe(false);
    expect(fs.readFileSync(local(), 'utf8')).toBe(text);
    expect(fs.statSync(local()).mtimeMs).toBe(before);
  });

  it('returns false and creates no file when there is no settings.local.json or no allow list', () => {
    expect(removeSavedAllowRule(hq, 'Bash(npm test)')).toBe(false);
    expect(fs.existsSync(local())).toBe(false);
    write(local(), { effortLevel: 'low' });
    expect(removeSavedAllowRule(hq, 'Bash(npm test)')).toBe(false);
    expect(JSON.parse(fs.readFileSync(local(), 'utf8'))).toEqual({ effortLevel: 'low' });
  });

  it('does not touch the hq shared settings file', () => {
    write(shared(), { permissions: { allow: ['Bash(npm test)'] } });
    write(local(), { permissions: { allow: ['Bash(npm test)'] } });
    expect(removeSavedAllowRule(hq, 'Bash(npm test)')).toBe(true);
    expect(JSON.parse(fs.readFileSync(shared(), 'utf8')).permissions.allow).toEqual(['Bash(npm test)']);
  });

  it('throws and leaves a file that is not valid JSON alone', () => {
    fs.writeFileSync(local(), '{ nope');
    expect(() => removeSavedAllowRule(hq, 'Bash(npm test)')).toThrow(/not valid JSON/);
    expect(fs.readFileSync(local(), 'utf8')).toBe('{ nope');
  });
});
