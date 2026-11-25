import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readInitiativeStatus, stripFrontmatter } from '../../src/main/hq/read';

let tmp: string;
let hq: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-ini-'));
  hq = path.join(tmp, 'hq');
  fs.mkdirSync(path.join(hq, 'initiatives', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(hq, 'initiatives', 'demo', 'status.md'), '---\nstate: active\nupdated: 2026-11-01\n---\n\n# Demo\n\n## Goal\nDo it.\n');
  fs.writeFileSync(path.join(tmp, 'secret.md'), 'outside');
  fs.mkdirSync(path.join(tmp, 'outside-dir'));
  fs.writeFileSync(path.join(tmp, 'outside-dir', 'status.md'), 'outside too');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('readInitiativeStatus', () => {
  it('reads a valid status page without its frontmatter', () => {
    expect(readInitiativeStatus(hq, 'demo')).toBe('# Demo\n\n## Goal\nDo it.\n');
  });

  it('reads a page whose hq folder is itself reached through a link', () => {
    const link = path.join(tmp, 'hq-link');
    fs.symlinkSync(hq, link);
    expect(readInitiativeStatus(link, 'demo')).toContain('# Demo');
  });

  it('is null for a slug that is not a plain folder name', () => {
    for (const slug of ['..', '.', 'a/b', '../x', '../outside-dir', '', 'a b', 'a\\b', '/etc', 'demo/../demo', 'a\0b']) {
      expect(readInitiativeStatus(hq, slug)).toBeNull();
    }
    expect(readInitiativeStatus(hq, undefined as unknown as string)).toBeNull();
    expect(readInitiativeStatus(hq, 7 as unknown as string)).toBeNull();
  });

  it('is null for a missing initiative, a missing file or a missing hq', () => {
    expect(readInitiativeStatus(hq, 'nope')).toBeNull();
    fs.mkdirSync(path.join(hq, 'initiatives', 'empty'));
    expect(readInitiativeStatus(hq, 'empty')).toBeNull();
    expect(readInitiativeStatus(path.join(tmp, 'gone'), 'demo')).toBeNull();
  });

  it('is null when status.md is a link, even to a file inside the hq', () => {
    fs.mkdirSync(path.join(hq, 'initiatives', 'linked'));
    fs.symlinkSync(path.join(tmp, 'secret.md'), path.join(hq, 'initiatives', 'linked', 'status.md'));
    expect(readInitiativeStatus(hq, 'linked')).toBeNull();
    fs.mkdirSync(path.join(hq, 'initiatives', 'linked2'));
    fs.symlinkSync(path.join(hq, 'initiatives', 'demo', 'status.md'), path.join(hq, 'initiatives', 'linked2', 'status.md'));
    expect(readInitiativeStatus(hq, 'linked2')).toBeNull();
  });

  it('is null when the initiative folder or the initiatives folder is a link', () => {
    fs.symlinkSync(path.join(tmp, 'outside-dir'), path.join(hq, 'initiatives', 'dirlink'));
    expect(readInitiativeStatus(hq, 'dirlink')).toBeNull();
    const hq2 = path.join(tmp, 'hq2');
    fs.mkdirSync(hq2);
    fs.symlinkSync(path.join(hq, 'initiatives'), path.join(hq2, 'initiatives'));
    expect(readInitiativeStatus(hq2, 'demo')).toBeNull();
  });

  it('is null over 256 KB and reads a file at the limit', () => {
    fs.mkdirSync(path.join(hq, 'initiatives', 'big'));
    fs.writeFileSync(path.join(hq, 'initiatives', 'big', 'status.md'), 'x'.repeat(256 * 1024 + 1));
    expect(readInitiativeStatus(hq, 'big')).toBeNull();
    fs.mkdirSync(path.join(hq, 'initiatives', 'edge'));
    fs.writeFileSync(path.join(hq, 'initiatives', 'edge', 'status.md'), 'x'.repeat(256 * 1024));
    expect(readInitiativeStatus(hq, 'edge')).toHaveLength(256 * 1024);
  });

  it('is null when status.md is a folder', () => {
    fs.mkdirSync(path.join(hq, 'initiatives', 'dir', 'status.md'), { recursive: true });
    expect(readInitiativeStatus(hq, 'dir')).toBeNull();
  });
});

describe('stripFrontmatter', () => {
  it('removes only a leading block', () => {
    expect(stripFrontmatter('---\na: 1\n---\n# T')).toBe('# T');
    expect(stripFrontmatter('# T\n\n---\nx\n---\n')).toBe('# T\n\n---\nx\n---\n');
    expect(stripFrontmatter('---\nnever closed\n# T')).toBe('---\nnever closed\n# T');
    expect(stripFrontmatter('')).toBe('');
  });
});
