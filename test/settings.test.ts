import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSettings, SettingsStore, userSettingsFile, type ResolveInput } from '../src/main/settings';

const input = (over: Partial<ResolveInput> = {}): ResolveInput => ({ hqLocal: {}, hq: {}, user: {}, autoPush: true, newSessionAfterMinutes: 30, renewSessionAtTokens: 100000, orgYamlModel: null, modelTiers: [], ...over });

describe('resolveSettings', () => {
  it('falls back to the app defaults', () => {
    expect(resolveSettings(input())).toMatchObject({ permissionMode: 'default', permissionModeSource: 'default', effort: 'high', effortSource: 'default', model: null, cosModel: null, cosModelSource: 'default', autoPush: true });
  });
  it('prefers hq local, then hq, then the user settings', () => {
    const r = resolveSettings(input({ hqLocal: { permissionMode: 'plan' }, hq: { permissionMode: 'auto', effort: 'low' }, user: { permissionMode: 'acceptEdits', effort: 'max' } }));
    expect(r).toMatchObject({ permissionMode: 'plan', permissionModeSource: 'hq-local', effort: 'low', effortSource: 'hq' });
    expect(resolveSettings(input({ user: { effort: 'max', permissionMode: 'acceptEdits' } }))).toMatchObject({ effort: 'max', effortSource: 'user', permissionMode: 'acceptEdits', permissionModeSource: 'user' });
  });
  it('unknown or unsupported values fall through to the next source', () => {
    const r = resolveSettings(input({ hqLocal: { permissionMode: 'bypassPermissions', effort: 'turbo' }, hq: { permissionMode: 5 }, user: { permissionMode: 'plan', effort: 'medium' } }));
    expect(r).toMatchObject({ permissionMode: 'plan', permissionModeSource: 'user', effort: 'medium', effortSource: 'user' });
  });
  it('CoS model: the override, then org.yaml, then the Claude Code default', () => {
    expect(resolveSettings(input({ hqLocal: { model: 'sonnet' }, orgYamlModel: 'opus' }))).toMatchObject({ model: 'sonnet', cosModel: 'sonnet', cosModelSource: 'override', orgYamlModel: 'opus' });
    expect(resolveSettings(input({ orgYamlModel: 'opus' }))).toMatchObject({ model: null, cosModel: 'opus', cosModelSource: 'org-yaml' });
    expect(resolveSettings(input({ hqLocal: { model: '' } }))).toMatchObject({ cosModel: null, cosModelSource: 'default' });
  });
});

describe('userSettingsFile', () => {
  it('uses CLAUDE_CONFIG_DIR when set, else ~/.claude', () => {
    expect(userSettingsFile({ CLAUDE_CONFIG_DIR: '/cfg' }, '/home/u')).toBe(path.join('/cfg', 'settings.json'));
    expect(userSettingsFile({}, '/home/u')).toBe(path.join('/home/u', '.claude', 'settings.json'));
  });
});

let root: string;
let data: string;
let userFile: string;
const hqs: Record<string, string> = {};
const mkHq = (name: string, orgYaml = 'org:\n  id: X\n'): string => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'org.yaml'), orgYaml);
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# x\n');
  return (hqs[name] = dir);
};
const localFile = (hq: string) => path.join(hq, '.claude', 'settings.local.json');
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));
const store = () => new SettingsStore({ dataDir: data, userFile });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-settings-'));
  data = path.join(root, 'data');
  userFile = path.join(root, 'user-settings.json');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('SettingsStore', () => {
  it('a new org starts from the resolved values with auto push on, and reading writes nothing', () => {
    const hq = mkHq('a');
    fs.mkdirSync(path.join(hq, '.claude'));
    fs.writeFileSync(path.join(hq, '.claude', 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } }));
    fs.writeFileSync(userFile, JSON.stringify({ effortLevel: 'medium' }));
    const s = store().get('a', hq);
    expect(s).toMatchObject({ permissionMode: 'acceptEdits', permissionModeSource: 'hq', effort: 'medium', effortSource: 'user', autoPush: true });
    expect(fs.existsSync(localFile(hq))).toBe(false);
    expect(fs.existsSync(path.join(data, 'orgs'))).toBe(false);
  });

  it('writes mode, effort and model into the hq settings.local.json by merging', () => {
    const hq = mkHq('a', 'models:\n  cos: opus\n  tiers: [opus, sonnet]\n');
    fs.mkdirSync(path.join(hq, '.claude'));
    fs.writeFileSync(localFile(hq), JSON.stringify({ env: { A: '1' }, permissions: { allow: ['X'] } }));
    const s = store().set('a', hq, { permissionMode: 'plan', effort: 'xhigh', model: 'sonnet' });
    expect(readJson(localFile(hq))).toEqual({ env: { A: '1' }, permissions: { allow: ['X'], defaultMode: 'plan' }, effortLevel: 'xhigh', model: 'sonnet' });
    expect(s).toMatchObject({ permissionMode: 'plan', effort: 'xhigh', cosModel: 'sonnet', cosModelSource: 'override', modelTiers: ['opus', 'sonnet'] });
    // model null removes the override, back to org.yaml
    const back = store().set('a', hq, { model: null });
    expect(readJson(localFile(hq)).model).toBeUndefined();
    expect(back).toMatchObject({ cosModel: 'opus', cosModelSource: 'org-yaml' });
  });

  it('reports the model ids seen in this org (orgs/<id>/models-seen.json, a corrupt file counts as none)', () => {
    const hq = mkHq('a');
    const st = store();
    expect(st.get('a', hq).seenModels).toEqual([]);
    st.seen('a').add('claude-opus-5-5');
    expect(st.get('a', hq).seenModels).toEqual(['claude-opus-5-5']);
    const file = path.join(data, 'orgs', 'a', 'models-seen.json');
    expect(readJson(file)).toEqual({ models: ['claude-opus-5-5'] });
    fs.writeFileSync(file, 'garbage');
    expect(store().get('a', hq).seenModels).toEqual([]);
  });

  it('keeps seen model ids per org: an id seen in one org is not offered in another', () => {
    const hqA = mkHq('a');
    const hqB = mkHq('b');
    const st = store();
    st.seen('a').add('claude-opus-5-5');
    st.seen('b').add('claude-sonnet-4-5');
    expect(st.get('a', hqA).seenModels).toEqual(['claude-opus-5-5']);
    expect(st.get('b', hqB).seenModels).toEqual(['claude-sonnet-4-5']);
    expect(store().get('b', hqB).seenModels).toEqual(['claude-sonnet-4-5']); // read back from disk
    expect(fs.existsSync(path.join(data, 'models-seen.json'))).toBe(false);
  });

  it('writes a specific model id as the org pin and reads it back', () => {
    const hq = mkHq('a', 'models:\n  cos: opus\n');
    const s = store().set('a', hq, { model: 'claude-opus-5-5' });
    expect(readJson(localFile(hq)).model).toBe('claude-opus-5-5');
    expect(s).toMatchObject({ model: 'claude-opus-5-5', cosModel: 'claude-opus-5-5', cosModelSource: 'override', orgYamlModel: 'opus' });
  });

  it('writes only what the patch names and ignores invalid values', () => {
    const hq = mkHq('a');
    store().set('a', hq, { effort: 'bogus' as never, permissionMode: 'nope' as never });
    expect(fs.existsSync(localFile(hq))).toBe(false);
    store().set('a', hq, { effort: 'low' });
    expect(readJson(localFile(hq))).toEqual({ effortLevel: 'low' });
  });

  it('keeps auto push per org: org A does not change org B', () => {
    const a = mkHq('a');
    const b = mkHq('b');
    const st = store();
    st.set('a', a, { autoPush: false });
    st.set('a', a, { effort: 'max' });
    expect(st.get('a', a)).toMatchObject({ autoPush: false, effort: 'max' });
    expect(st.get('b', b)).toMatchObject({ autoPush: true, effort: 'high' });
    expect(st.autoPush('a')).toBe(false);
    expect(st.autoPush('b')).toBe(true);
    expect(readJson(path.join(data, 'orgs', 'a', 'settings.json'))).toEqual({ autoPush: false });
    expect(fs.existsSync(localFile(b))).toBe(false);
    // a new store (app restart) sees the same values
    expect(store().get('a', a).autoPush).toBe(false);
  });

  it('keeps the new session delay per org in the app file: default 30, 60 written and read back, 0 accepted, invalid values ignored', () => {
    const a = mkHq('a');
    const b = mkHq('b');
    const st = store();
    expect(st.newSessionAfterMinutes('a')).toBe(30);
    expect(st.get('a', a).newSessionAfterMinutes).toBe(30);
    expect(st.set('a', a, { newSessionAfterMinutes: 60 }).newSessionAfterMinutes).toBe(60);
    expect(store().newSessionAfterMinutes('a')).toBe(60);
    expect(st.newSessionAfterMinutes('b')).toBe(30);
    expect(readJson(path.join(data, 'orgs', 'a', 'settings.json'))).toEqual({ newSessionAfterMinutes: 60 });
    for (const bad of [7, -1, 61, 1.5, '30', null, NaN]) st.set('a', a, { newSessionAfterMinutes: bad as never });
    expect(st.newSessionAfterMinutes('a')).toBe(60);
    expect(st.set('a', a, { newSessionAfterMinutes: 0 }).newSessionAfterMinutes).toBe(0);
    expect(st.set('a', a, { autoPush: false, newSessionAfterMinutes: 240 })).toMatchObject({ autoPush: false, newSessionAfterMinutes: 240 });
    expect(readJson(path.join(data, 'orgs', 'a', 'settings.json'))).toEqual({ newSessionAfterMinutes: 240, autoPush: false });
    // a file holding an invalid value falls back to the default on read
    fs.mkdirSync(path.join(data, 'orgs', 'b'), { recursive: true });
    fs.writeFileSync(path.join(data, 'orgs', 'b', 'settings.json'), JSON.stringify({ newSessionAfterMinutes: 99 }));
    expect(st.get('b', b).newSessionAfterMinutes).toBe(30);
    expect(fs.existsSync(localFile(a))).toBe(false);
  });

  it('keeps the renew-at-tokens limit per org in the app file: default 100000, written and read back, 0 accepted, invalid values ignored', () => {
    const a = mkHq('a');
    const b = mkHq('b');
    const st = store();
    expect(st.renewSessionAtTokens('a')).toBe(100000);
    expect(st.get('a', a).renewSessionAtTokens).toBe(100000);
    expect(st.set('a', a, { renewSessionAtTokens: 200000 }).renewSessionAtTokens).toBe(200000);
    expect(store().renewSessionAtTokens('a')).toBe(200000);
    expect(st.renewSessionAtTokens('b')).toBe(100000);
    expect(readJson(path.join(data, 'orgs', 'a', 'settings.json'))).toEqual({ renewSessionAtTokens: 200000 });
    for (const bad of [7, -1, 60000, 1.5, '100000', null, NaN]) st.set('a', a, { renewSessionAtTokens: bad as never });
    expect(st.renewSessionAtTokens('a')).toBe(200000);
    for (const ok of [50000, 150000, 400000]) expect(st.set('a', a, { renewSessionAtTokens: ok }).renewSessionAtTokens).toBe(ok);
    expect(st.set('a', a, { renewSessionAtTokens: 0 }).renewSessionAtTokens).toBe(0);
    // it shares the file with the other app settings
    expect(st.set('a', a, { newSessionAfterMinutes: 60 })).toMatchObject({ newSessionAfterMinutes: 60, renewSessionAtTokens: 0 });
    expect(readJson(path.join(data, 'orgs', 'a', 'settings.json'))).toEqual({ renewSessionAtTokens: 0, newSessionAfterMinutes: 60 });
    fs.mkdirSync(path.join(data, 'orgs', 'b'), { recursive: true });
    fs.writeFileSync(path.join(data, 'orgs', 'b', 'settings.json'), JSON.stringify({ renewSessionAtTokens: 99 }));
    expect(st.get('b', b).renewSessionAtTokens).toBe(100000);
    expect(resolveSettings(input({ renewSessionAtTokens: 12 }))).toMatchObject({ renewSessionAtTokens: 100000 });
    expect(fs.existsSync(localFile(a))).toBe(false);
  });

  it('does not touch the user settings file', () => {
    const hq = mkHq('a');
    fs.writeFileSync(userFile, JSON.stringify({ effortLevel: 'low', secret: 'x' }));
    store().set('a', hq, { effort: 'max' });
    expect(readJson(userFile)).toEqual({ effortLevel: 'low', secret: 'x' });
  });

  it('refuses to overwrite a settings.local.json that is not valid JSON', () => {
    const hq = mkHq('a');
    fs.mkdirSync(path.join(hq, '.claude'));
    fs.writeFileSync(localFile(hq), '{ broken');
    expect(() => store().set('a', hq, { effort: 'low' })).toThrow();
    expect(fs.readFileSync(localFile(hq), 'utf8')).toBe('{ broken');
  });
});

describe('migration of the old app-wide file', () => {
  const legacy = () => path.join(data, 'settings.json');
  const writeLegacy = (v: unknown) => {
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(legacy(), JSON.stringify(v));
  };

  it('gives each org the old values, then removes the file', () => {
    const a = mkHq('a');
    const b = mkHq('b');
    writeLegacy({ permissionMode: 'acceptEdits', autoPush: false });
    store().migrateLegacy([{ id: 'a', path: a }, { id: 'b', path: b }]);
    expect(fs.existsSync(legacy())).toBe(false);
    for (const [id, hq] of [['a', a], ['b', b]] as const) {
      expect(store().get(id, hq)).toMatchObject({ permissionMode: 'acceptEdits', permissionModeSource: 'hq-local', autoPush: false });
    }
  });

  it('does not overwrite an org that already has auto push, nor an hq that already sets the mode', () => {
    const a = mkHq('a');
    const b = mkHq('b');
    const st = store();
    st.set('a', a, { autoPush: true });
    fs.mkdirSync(path.join(b, '.claude'));
    fs.writeFileSync(path.join(b, '.claude', 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'plan' } }));
    writeLegacy({ permissionMode: 'auto', autoPush: false });
    st.migrateLegacy([{ id: 'a', path: a }, { id: 'b', path: b }]);
    expect(st.autoPush('a')).toBe(true);
    expect(st.autoPush('b')).toBe(false);
    expect(st.get('b', b)).toMatchObject({ permissionMode: 'plan', permissionModeSource: 'hq' });
    expect(fs.existsSync(localFile(b))).toBe(false);
  });

  it('writes nothing to the hq for the default mode', () => {
    const a = mkHq('a');
    writeLegacy({ permissionMode: 'default', autoPush: true });
    store().migrateLegacy([{ id: 'a', path: a }]);
    expect(fs.existsSync(localFile(a))).toBe(false);
    expect(fs.existsSync(legacy())).toBe(false);
  });

  it('keeps the old file when an org folder is missing, and finishes the others', () => {
    const a = mkHq('a');
    writeLegacy({ permissionMode: 'plan', autoPush: false });
    store().migrateLegacy([{ id: 'a', path: a }, { id: 'gone', path: path.join(root, 'nowhere') }]);
    expect(fs.existsSync(legacy())).toBe(true);
    expect(store().get('a', a)).toMatchObject({ permissionMode: 'plan', autoPush: false });
    // the missing org appears later: the next start finishes and removes the file
    const gone = mkHq('gone');
    store().migrateLegacy([{ id: 'a', path: a }, { id: 'gone', path: gone }]);
    expect(fs.existsSync(legacy())).toBe(false);
    expect(store().get('gone', gone)).toMatchObject({ permissionMode: 'plan', autoPush: false });
  });

  it('keeps the old file when there are no orgs', () => {
    writeLegacy({ autoPush: false });
    store().migrateLegacy([]);
    expect(fs.existsSync(legacy())).toBe(true);
  });

  it('keeps the old file when it is not valid JSON', () => {
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(legacy(), '{ not json');
    store().migrateLegacy([{ id: 'a', path: mkHq('a') }]);
    expect(fs.existsSync(legacy())).toBe(true);
  });

  it('keeps the old file when a settings file of an org is not valid JSON, and leaves that file alone', () => {
    const a = mkHq('a');
    fs.mkdirSync(path.join(a, '.claude'));
    fs.writeFileSync(localFile(a), '{ nope');
    writeLegacy({ permissionMode: 'plan' });
    store().migrateLegacy([{ id: 'a', path: a }]);
    expect(fs.existsSync(legacy())).toBe(true);
    expect(fs.readFileSync(localFile(a), 'utf8')).toBe('{ nope');
    // the org's own app settings file
    const b = mkHq('b');
    fs.mkdirSync(path.join(data, 'orgs', 'b'), { recursive: true });
    fs.writeFileSync(path.join(data, 'orgs', 'b', 'settings.json'), '{ nope');
    fs.rmSync(path.join(a, '.claude'), { recursive: true });
    writeLegacy({ autoPush: false });
    store().migrateLegacy([{ id: 'b', path: b }]);
    expect(fs.existsSync(legacy())).toBe(true);
    // the shared hq settings file
    const c = mkHq('c');
    fs.mkdirSync(path.join(c, '.claude'));
    fs.writeFileSync(path.join(c, '.claude', 'settings.json'), '[1]');
    writeLegacy({ permissionMode: 'plan' });
    store().migrateLegacy([{ id: 'c', path: c }]);
    expect(fs.existsSync(legacy())).toBe(true);
    expect(fs.existsSync(localFile(c))).toBe(false);
  });

  it('keeps the old file when a write fails', () => {
    const a = mkHq('a');
    // a folder where the org's settings file should be: the atomic rename fails
    fs.mkdirSync(path.join(data, 'orgs', 'a', 'settings.json'), { recursive: true });
    writeLegacy({ autoPush: false });
    store().migrateLegacy([{ id: 'a', path: a }]);
    expect(fs.existsSync(legacy())).toBe(true);
  });

  it('removes the old file when every org already had its values', () => {
    const a = mkHq('a');
    store().set('a', a, { autoPush: true, permissionMode: 'plan' });
    writeLegacy({ permissionMode: 'auto', autoPush: false });
    store().migrateLegacy([{ id: 'a', path: a }]);
    expect(fs.existsSync(legacy())).toBe(false);
    expect(store().get('a', a)).toMatchObject({ permissionMode: 'plan', autoPush: true });
  });

  it('is a no-op without an old file', () => {
    const a = mkHq('a');
    store().migrateLegacy([{ id: 'a', path: a }]);
    expect(fs.existsSync(path.join(data, 'orgs'))).toBe(false);
  });
});

describe('userArtifactSettings', () => {
  it('keeps only enableArtifact and env.CLAUDE_CODE_DISABLE_ARTIFACT of the user file', () => {
    fs.writeFileSync(userFile, JSON.stringify({ model: 'x', enableArtifact: false, env: { CLAUDE_CODE_DISABLE_ARTIFACT: '1', SECRET: 'y' }, permissions: { deny: ['A'] } }));
    expect(store().userArtifactSettings()).toEqual({ enableArtifact: false, env: { CLAUDE_CODE_DISABLE_ARTIFACT: '1' } });
  });
  it('is empty without a file, with an invalid file or without those keys', () => {
    expect(store().userArtifactSettings()).toEqual({});
    fs.writeFileSync(userFile, '{ not json');
    expect(store().userArtifactSettings()).toEqual({});
    fs.writeFileSync(userFile, JSON.stringify({ model: 'x', env: { OTHER: '1' } }));
    expect(store().userArtifactSettings()).toEqual({});
  });
});

describe('userDenyRules', () => {
  it('reads only permissions.deny of the user file, anchoring single-slash path rules to its folder', () => {
    fs.writeFileSync(userFile, JSON.stringify({ model: 'x', permissions: { allow: ['Bash(ls)'], deny: ['Bash(rm *)', 'Read(~/.ssh/**)', 'Edit(/secrets/**)', 'Read(//etc/**)'] } }));
    const base = root.split(path.sep).join('/');
    expect(store().userDenyRules()).toEqual(['Bash(rm *)', 'Read(~/.ssh/**)', `Edit(/${base}/secrets/**)`, 'Read(//etc/**)']);
  });
  it('is empty without a file or without deny rules', () => {
    expect(store().userDenyRules()).toEqual([]);
    fs.writeFileSync(userFile, JSON.stringify({ permissions: { allow: ['A'] } }));
    expect(store().userDenyRules()).toEqual([]);
  });
});
