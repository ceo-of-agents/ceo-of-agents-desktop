import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanRelativePath, readVoice, voiceLocation, writeVoice } from '../../src/main/hq/voice';

let tmp: string;
let hq: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-voice-'));
  hq = path.join(tmp, 'hq');
  fs.mkdirSync(path.join(hq, 'company'), { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
const orgYaml = (body: string) => fs.writeFileSync(path.join(hq, 'org.yaml'), body);

describe('cleanRelativePath', () => {
  it('accepts a relative path and refuses the rest', () => {
    expect(cleanRelativePath('company/ceo-voice.md')).toBe('company/ceo-voice.md');
    expect(cleanRelativePath(' ./company//voice.md ')).toBe('company/voice.md');
    for (const bad of ['', '/etc/passwd', '~/x', '../x', 'a/../../x', '.git/config', 'a\\b', 'a\u0000b', 'x'.repeat(201), 42, null]) expect(cleanRelativePath(bad)).toBeNull();
  });
});

describe('voiceLocation', () => {
  it('defaults to company/ceo-voice.md with no org.yaml or no key', () => {
    expect(voiceLocation(hq)).toEqual({ path: 'company/ceo-voice.md' });
    orgYaml('ceo:\n  role: ceo\n');
    expect(voiceLocation(hq)).toEqual({ path: 'company/ceo-voice.md' });
    orgYaml('ceo:\n  voice: null\n');
    expect(voiceLocation(hq)).toEqual({ path: 'company/ceo-voice.md' });
  });
  it('uses ceo.voice when it is a path inside the hq', () => {
    orgYaml('ceo:\n  voice: company/my-voice.md\n');
    expect(voiceLocation(hq)).toEqual({ path: 'company/my-voice.md' });
    orgYaml('ceo:\n  voice: company/My-Voice.MD\n');
    expect(voiceLocation(hq)).toEqual({ path: 'company/My-Voice.MD' });
  });
  it('marks an unusable ceo.voice as invalid and a path that is not .md as notMarkdown', () => {
    orgYaml('ceo:\n  voice: ../outside.md\n');
    expect(voiceLocation(hq)).toMatchObject({ error: 'invalidPath' });
    orgYaml('ceo:\n  voice: [a]\n');
    expect(voiceLocation(hq).error).toBe('invalidPath');
    orgYaml('ceo:\n  voice: org.yaml\n');
    expect(voiceLocation(hq)).toEqual({ path: 'org.yaml', error: 'notMarkdown' });
  });
});

describe('readVoice and writeVoice', () => {
  const sha = (t: string) => createHash('sha256').update(t).digest('hex');
  it('reports a missing file, then writes and reads it back with a version token', () => {
    expect(readVoice(hq)).toEqual({ path: 'company/ceo-voice.md', exists: false, text: '', version: 'missing' });
    expect(writeVoice(hq, '## Base\n\n- Short.\n', 'missing')).toEqual({ ok: true, version: sha('## Base\n\n- Short.\n') });
    expect(readVoice(hq)).toMatchObject({ exists: true, text: '## Base\n\n- Short.\n', version: sha('## Base\n\n- Short.\n') });
    expect(fs.readdirSync(path.join(hq, 'company')).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
  it('writes to the path of org.yaml and creates its folders', () => {
    orgYaml('ceo:\n  voice: notes/voice.md\n');
    expect(writeVoice(hq, 'x', 'missing')).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(hq, 'notes', 'voice.md'), 'utf8')).toBe('x');
    expect(readVoice(hq)).toMatchObject({ path: 'notes/voice.md', text: 'x' });
  });
  it('refuses a path that is not a .md file, to read and to write', () => {
    orgYaml('ceo:\n  voice: org.yaml\n');
    expect(writeVoice(hq, 'x', 'missing')).toEqual({ ok: false, error: 'notMarkdown' });
    expect(readVoice(hq)).toMatchObject({ error: 'notMarkdown', text: '' });
    expect(fs.readFileSync(path.join(hq, 'org.yaml'), 'utf8')).toBe('ceo:\n  voice: org.yaml\n');
  });
  it('saves when the file is unchanged since it was loaded', () => {
    fs.writeFileSync(path.join(hq, 'company', 'ceo-voice.md'), 'one');
    const { version } = readVoice(hq);
    expect(writeVoice(hq, 'two', version)).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(hq, 'company', 'ceo-voice.md'), 'utf8')).toBe('two');
  });
  it('refuses to save when the content changed since it was loaded', () => {
    const file = path.join(hq, 'company', 'ceo-voice.md');
    fs.writeFileSync(file, 'one');
    const { version } = readVoice(hq);
    fs.writeFileSync(file, 'changed elsewhere');
    expect(writeVoice(hq, 'two', version)).toEqual({ ok: false, error: 'conflict' });
    expect(fs.readFileSync(file, 'utf8')).toBe('changed elsewhere');
  });
  it('refuses to save when the file appeared after a missing one, or was deleted after a load', () => {
    const file = path.join(hq, 'company', 'ceo-voice.md');
    const { version } = readVoice(hq);
    expect(version).toBe('missing');
    fs.writeFileSync(file, 'someone else');
    expect(writeVoice(hq, 'two', version)).toEqual({ ok: false, error: 'conflict' });
    expect(fs.readFileSync(file, 'utf8')).toBe('someone else');
    const loaded = readVoice(hq).version;
    fs.rmSync(file);
    expect(writeVoice(hq, 'two', loaded)).toEqual({ ok: false, error: 'conflict' });
  });
  it('refuses an invalid path, a link, a folder in the way, and a file that is too big', () => {
    orgYaml('ceo:\n  voice: ../x.md\n');
    expect(writeVoice(hq, 'x', 'missing')).toEqual({ ok: false, error: 'invalidPath' });
    expect(readVoice(hq).error).toBe('invalidPath');
    orgYaml('ceo:\n  voice: company/v.md\n');
    fs.writeFileSync(path.join(tmp, 'secret.md'), 'secret');
    fs.symlinkSync(path.join(tmp, 'secret.md'), path.join(hq, 'company', 'v.md'));
    expect(writeVoice(hq, 'x', 'missing')).toEqual({ ok: false, error: 'invalidPath' });
    expect(readVoice(hq)).toMatchObject({ error: 'invalidPath', text: '' });
    expect(fs.readFileSync(path.join(tmp, 'secret.md'), 'utf8')).toBe('secret');
    fs.rmSync(path.join(hq, 'company', 'v.md'));
    fs.mkdirSync(path.join(hq, 'company', 'v.md'));
    expect(writeVoice(hq, 'x', 'missing')).toEqual({ ok: false, error: 'invalidPath' });
    fs.rmdirSync(path.join(hq, 'company', 'v.md'));
    expect(writeVoice(hq, 'x'.repeat(256 * 1024 + 1), 'missing')).toEqual({ ok: false, error: 'tooLarge' });
  });
  it('refuses a linked folder on the way', () => {
    fs.mkdirSync(path.join(tmp, 'elsewhere'));
    fs.symlinkSync(path.join(tmp, 'elsewhere'), path.join(hq, 'linked'));
    orgYaml('ceo:\n  voice: linked/v.md\n');
    expect(writeVoice(hq, 'x', 'missing')).toEqual({ ok: false, error: 'invalidPath' });
    expect(fs.readdirSync(path.join(tmp, 'elsewhere'))).toEqual([]);
  });
});
