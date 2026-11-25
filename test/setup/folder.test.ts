import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkPoliciesPath, checkSetupFolder } from '../../src/main/setup/folder';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-folder-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('checkSetupFolder', () => {
  it('accepts an empty folder', () => {
    expect(checkSetupFolder(dir)).toEqual({ ok: true, entries: [] });
  });
  it('accepts only .git', () => {
    fs.mkdirSync(path.join(dir, '.git'));
    expect(checkSetupFolder(dir).ok).toBe(true);
  });
  it('accepts only .claude/settings.json (and .git)', () => {
    fs.mkdirSync(path.join(dir, '.git'));
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), '{}');
    expect(checkSetupFolder(dir)).toEqual({ ok: true, entries: [] });
  });
  it('lists anything else', () => {
    fs.writeFileSync(path.join(dir, 'README.md'), 'x');
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), '{}');
    fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), '{}');
    expect(checkSetupFolder(dir)).toEqual({ ok: false, entries: ['.claude/settings.local.json', 'README.md'] });
  });
  it("counts .DS_Store like the wizard's `ls -A` does, in the folder and in .claude", () => {
    fs.writeFileSync(path.join(dir, '.DS_Store'), 'x');
    expect(checkSetupFolder(dir)).toEqual({ ok: false, entries: ['.DS_Store'] });
    fs.rmSync(path.join(dir, '.DS_Store'));
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.writeFileSync(path.join(dir, '.claude', '.DS_Store'), 'x');
    expect(checkSetupFolder(dir)).toEqual({ ok: false, entries: ['.claude/.DS_Store'] });
  });
  it('refuses a symlinked folder, .claude, .git or settings.json', () => {
    const real = path.join(dir, 'real');
    fs.mkdirSync(real);
    const link = path.join(dir, 'link');
    fs.symlinkSync(real, link);
    expect(checkSetupFolder(link)).toEqual({ ok: false, entries: [], symlink: true });
    for (const name of ['.claude', '.git']) {
      const d = fs.mkdtempSync(path.join(dir, 'x-'));
      fs.symlinkSync(real, path.join(d, name));
      expect(checkSetupFolder(d)).toEqual({ ok: false, entries: [name], symlink: true });
    }
    const d = fs.mkdtempSync(path.join(dir, 'y-'));
    fs.mkdirSync(path.join(d, '.claude'));
    fs.writeFileSync(path.join(real, 'settings.json'), '{}');
    fs.symlinkSync(path.join(real, 'settings.json'), path.join(d, '.claude', 'settings.json'));
    expect(checkSetupFolder(d)).toEqual({ ok: false, entries: ['.claude/settings.json'], symlink: true });
  });
  it('reports a missing folder, and a file', () => {
    expect(checkSetupFolder(path.join(dir, 'nope'))).toEqual({ ok: false, entries: [], missing: true });
    fs.writeFileSync(path.join(dir, 'f'), 'x');
    expect(checkSetupFolder(path.join(dir, 'f')).missing).toBe(true);
  });
});

describe('checkPoliciesPath', () => {
  it('refuses the folder itself and anything inside it, even a path not created yet', () => {
    expect(checkPoliciesPath(dir, dir)).toBe('inside');
    expect(checkPoliciesPath(dir, path.join(dir, 'policies'))).toBe('inside');
    expect(checkPoliciesPath(dir, `${dir}/a/../b`)).toBe('inside');
    expect(checkPoliciesPath(dir, path.join(dir, 'x', 'y', 'z'))).toBe('inside');
  });
  it('refuses an existing folder with content, or a file', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-pol-'));
    try {
      expect(checkPoliciesPath(dir, other)).toBeNull();
      fs.writeFileSync(path.join(other, 'a'), 'x');
      expect(checkPoliciesPath(dir, other)).toBe('notEmpty');
      expect(checkPoliciesPath(dir, path.join(other, 'a'))).toBe('notEmpty');
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
  it('accepts a sibling that does not exist yet; a name that only starts with two dots is inside, not above', () => {
    expect(checkPoliciesPath(dir, `${dir}-policies`)).toBeNull();
    expect(checkPoliciesPath(dir, path.join(dir, '..b'))).toBe('inside');
  });
});
