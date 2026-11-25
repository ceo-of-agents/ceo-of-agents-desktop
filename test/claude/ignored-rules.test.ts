import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { broadAllowRulesBySource, droppedRulesBySource, isBroadSelfAllowRule, removeDroppedLocalRules } from '../../src/main/claude/rules';

let hq: string;
const settings = () => path.join(hq, '.claude', 'settings.json');
const local = () => path.join(hq, '.claude', 'settings.local.json');
const readLocal = () => JSON.parse(fs.readFileSync(local(), 'utf8')) as Record<string, unknown>;

beforeEach(() => {
  hq = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coa-ignored-')));
  fs.mkdirSync(path.join(hq, '.claude'));
});
afterEach(() => fs.rmSync(hq, { recursive: true, force: true }));

describe('droppedRulesBySource', () => {
  it('splits the ignored allow rules by the file they are written in', () => {
    fs.writeFileSync(settings(), JSON.stringify({ permissions: { allow: ['Bash(gh issue list *)', 'Bash(python *)', 'Bash(rm -rf x)'] } }));
    fs.writeFileSync(local(), JSON.stringify({ permissions: { allow: ['Bash(rm *)', 'Bash(make test)', 'WebFetch'] } }));
    const r = droppedRulesBySource(hq);
    expect(r.local).toEqual(['Bash(rm *)', 'WebFetch']);
    expect(r.project).toEqual(['Bash(python *)', 'Bash(rm -rf x)']);
  });

  it('keeps an exact dangerous rule of the committed file when the user also saved it locally', () => {
    fs.writeFileSync(settings(), JSON.stringify({ permissions: { allow: ['Bash(make test)'] } }));
    fs.writeFileSync(local(), JSON.stringify({ permissions: { allow: ['Bash(make test)'] } }));
    expect(droppedRulesBySource(hq)).toEqual({ local: [], project: [] });
  });

  it('is empty when the files are missing or unparseable', () => {
    expect(droppedRulesBySource(hq)).toEqual({ local: [], project: [] });
    fs.writeFileSync(local(), '{ nope');
    expect(droppedRulesBySource(hq)).toEqual({ local: [], project: [] });
  });
});

describe('removeDroppedLocalRules', () => {
  it('removes only the dropped allow rules and keeps every other key, rule and the order', () => {
    const data = {
      model: 'opus',
      permissions: {
        defaultMode: 'acceptEdits',
        allow: ['Bash(gh issue list *)', 'Bash(python *)', 'Bash(make test)', 'WebFetch', 'Bash(git status)'],
        deny: ['Bash(rm *)', 'Bash(python *)'],
        ask: ['Bash(git push *)'],
      },
      effortLevel: 'high',
    };
    fs.writeFileSync(local(), JSON.stringify(data));
    expect(removeDroppedLocalRules(hq)).toBe(2);
    const out = readLocal();
    expect(out).toEqual({
      ...data,
      permissions: { ...data.permissions, allow: ['Bash(gh issue list *)', 'Bash(make test)', 'Bash(git status)'] },
    });
    expect(Object.keys(out)).toEqual(['model', 'permissions', 'effortLevel']);
    expect(Object.keys(out.permissions as object)).toEqual(['defaultMode', 'allow', 'deny', 'ask']);
    expect(fs.readdirSync(path.join(hq, '.claude')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('never reads or writes settings.json', () => {
    const shared = JSON.stringify({ permissions: { allow: ['Bash(python *)', 'Bash(rm -rf x)'] } });
    fs.writeFileSync(settings(), shared);
    const before = fs.statSync(settings()).mtimeMs;
    fs.writeFileSync(local(), JSON.stringify({ permissions: { allow: ['Bash(python *)', 'Bash(make test)'] } }));
    expect(removeDroppedLocalRules(hq)).toBe(1);
    expect(fs.readFileSync(settings(), 'utf8')).toBe(shared);
    expect(fs.statSync(settings()).mtimeMs).toBe(before);
    expect(droppedRulesBySource(hq).project).toEqual(['Bash(python *)', 'Bash(rm -rf x)']);
  });

  it('does not touch a file with nothing to remove, and returns 0', () => {
    const text = '{"permissions":{"allow":["Bash(make test)"]},"a":1}';
    fs.writeFileSync(local(), text);
    expect(removeDroppedLocalRules(hq)).toBe(0);
    expect(fs.readFileSync(local(), 'utf8')).toBe(text);
    fs.writeFileSync(local(), '{"model":"opus"}');
    expect(removeDroppedLocalRules(hq)).toBe(0);
    expect(fs.readFileSync(local(), 'utf8')).toBe('{"model":"opus"}');
  });

  it('is an error, and writes nothing, when the file is missing or is not valid JSON', () => {
    expect(() => removeDroppedLocalRules(hq)).toThrow();
    expect(fs.existsSync(local())).toBe(false);
    fs.writeFileSync(local(), '{ "permissions": ');
    expect(() => removeDroppedLocalRules(hq)).toThrow();
    expect(fs.readFileSync(local(), 'utf8')).toBe('{ "permissions": ');
  });

  it('keeps entries that are not strings', () => {
    fs.writeFileSync(local(), JSON.stringify({ permissions: { allow: [42, 'WebFetch', null, 'Bash(make test)'] } }));
    expect(removeDroppedLocalRules(hq)).toBe(1);
    expect((readLocal().permissions as { allow: unknown[] }).allow).toEqual([42, null, 'Bash(make test)']);
  });
});

describe('broad Artifact and AskUserQuestion rules that Claude Code reads itself', () => {
  it('detects a bare Artifact in settings.local.json and in settings.json, apart from the ignored rules', () => {
    fs.writeFileSync(settings(), JSON.stringify({ permissions: { allow: ['Artifact', 'Bash(python *)', 'Artifact(action:read)'] } }));
    fs.writeFileSync(local(), JSON.stringify({ permissions: { allow: ['Artifact', 'AskUserQuestion', 'Artifact(action:list)', 'WebFetch'] } }));
    expect(broadAllowRulesBySource(hq)).toEqual({ local: ['Artifact', 'AskUserQuestion'], project: ['Artifact'] });
    expect(droppedRulesBySource(hq)).toEqual({ local: ['WebFetch'], project: ['Bash(python *)'] });
  });

  it('flags every Artifact rule but the three safe actions, and every AskUserQuestion rule', () => {
    for (const r of ['Artifact', 'Artifact(*)', 'Artifact(action:*)', 'Artifact(action:publish)', 'Artifact(action:delete)', 'Artifact(read)', 'AskUserQuestion', 'AskUserQuestion(*)', 'AskUserQuestion(x)']) {
      expect(isBroadSelfAllowRule(r), r).toBe(true);
    }
    for (const r of ['Artifact(action:read)', 'Artifact(action: list)', 'Artifact(action:open)', 'Bash(ls)', 'WebFetch', 'Read']) {
      expect(isBroadSelfAllowRule(r), r).toBe(false);
    }
  });

  it('is empty when the files are missing, unparseable or clean', () => {
    expect(broadAllowRulesBySource(hq)).toEqual({ local: [], project: [] });
    fs.writeFileSync(local(), '{ nope');
    fs.writeFileSync(settings(), JSON.stringify({ permissions: { allow: ['Artifact(action:open)'] } }));
    expect(broadAllowRulesBySource(hq)).toEqual({ local: [], project: [] });
  });

  it('cleanup removes the broad rules from settings.local.json only', () => {
    const shared = JSON.stringify({ permissions: { allow: ['Artifact', 'AskUserQuestion(*)'] } });
    fs.writeFileSync(settings(), shared);
    fs.writeFileSync(local(), JSON.stringify({ permissions: { allow: ['Artifact', 'Artifact(action:read)', 'AskUserQuestion'] } }));
    expect(removeDroppedLocalRules(hq)).toBe(2);
    expect((readLocal().permissions as { allow: string[] }).allow).toEqual(['Artifact(action:read)']);
    expect(fs.readFileSync(settings(), 'utf8')).toBe(shared);
    expect(broadAllowRulesBySource(hq)).toEqual({ local: [], project: ['Artifact', 'AskUserQuestion(*)'] });
  });
});
