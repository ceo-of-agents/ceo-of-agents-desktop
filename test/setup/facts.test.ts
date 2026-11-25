import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectFacts, headCommit } from '../../src/main/setup/facts';
import { EMPTY_FACTS } from '../../src/shared/setup';
import type { Runner } from '../../src/main/system/exec';
import { run } from '../../src/main/system/exec';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-facts-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const put = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

describe('detectFacts', () => {
  it('finds nothing in an empty folder (and in a missing one)', async () => {
    expect(await detectFacts(dir)).toEqual(EMPTY_FACTS);
    expect(await detectFacts(path.join(dir, 'nope'))).toEqual(EMPTY_FACTS);
  });

  it('detects the files the wizard writes', async () => {
    put('org.yaml', 'org:\n  id: ACME\n  name: Acme\ncos:\n  display_name: Ada\n');
    put('decisions/0001-setup.md', '# x');
    put('company/state.md', '# s');
    put('.claude/settings.json', JSON.stringify({ enabledPlugins: { 'ceo-of-agents@ceo-of-agents': true } }));
    expect(await detectFacts(dir)).toEqual({ orgYaml: true, decisionRecord: true, state: true, settings: true, pluginEnabled: true, commit: null, orgName: 'Acme', cosName: 'Ada' });
  });

  it('accepts any decisions/0001-*.md, and not other numbers', async () => {
    put('decisions/0002-other.md', 'x');
    expect((await detectFacts(dir)).decisionRecord).toBe(false);
    put('decisions/0001-the-setup-of-acme.md', 'x');
    expect((await detectFacts(dir)).decisionRecord).toBe(true);
  });

  it('pluginEnabled needs a ceo-of-agents@ key set to true', async () => {
    put('.claude/settings.json', JSON.stringify({ enabledPlugins: { 'ceo-of-agents@x': false, 'other@y': true } }));
    expect(await detectFacts(dir)).toMatchObject({ settings: true, pluginEnabled: false });
    put('.claude/settings.json', '{ not json');
    expect(await detectFacts(dir)).toMatchObject({ settings: true, pluginEnabled: false });
    put('.claude/settings.json', JSON.stringify({ enabledPlugins: { 'ceo-of-agents@market': true } }));
    expect((await detectFacts(dir)).pluginEnabled).toBe(true);
  });

  it('gives no names while org.yaml is missing or unreadable', async () => {
    put('org.yaml', ': : [');
    expect(await detectFacts(dir)).toMatchObject({ orgYaml: true, orgName: null, cosName: null });
  });

  it('reads the short sha of HEAD of a real repo', async () => {
    expect(await headCommit(dir)).toBeNull();
    const git = (...a: string[]) => run('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: dir });
    await git('init', '--quiet');
    expect(await headCommit(dir)).toBeNull(); // no commit yet
    put('a.txt', 'x');
    await git('add', '-A');
    await git('commit', '--quiet', '-m', 'init');
    const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
    expect(head.startsWith((await headCommit(dir)) as string)).toBe(true);
    expect((await detectFacts(dir)).commit).toBe(await headCommit(dir));
  });

  it('never throws: a failing or throwing runner gives null, and a folder inside another repo has no commit', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    const bad: Runner = () => Promise.reject(new Error('boom'));
    expect(await headCommit(dir, bad)).toBeNull();
    const timedOut: Runner = () => Promise.resolve({ code: null, stdout: '', stderr: '', error: 'timeout' });
    expect(await headCommit(dir, timedOut)).toBeNull();
    const garbage: Runner = () => Promise.resolve({ code: 0, stdout: 'fatal: x\n', stderr: '', error: null });
    expect(await headCommit(dir, garbage)).toBeNull();
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);
    const ok: Runner = () => Promise.resolve({ code: 0, stdout: 'abc1234\n', stderr: '', error: null });
    expect(await headCommit(sub, ok)).toBeNull();
    expect(await headCommit(dir, ok)).toBe('abc1234');
  });
});
