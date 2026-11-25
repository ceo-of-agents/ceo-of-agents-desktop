import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SeenModels, cleanSeen } from '../../src/main/claude/seen-models';

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-seen-'));
  file = path.join(dir, 'models-seen.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('SeenModels', () => {
  it('starts empty and writes nothing on read', () => {
    expect(new SeenModels(file).list()).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('remembers ids newest first, without duplicates, across instances', () => {
    const s = new SeenModels(file);
    s.add('claude-opus-5-5');
    s.add('claude-sonnet-4-5-20250929');
    s.add('claude-opus-5-5');
    expect(s.list()).toEqual(['claude-opus-5-5', 'claude-sonnet-4-5-20250929']);
    expect(new SeenModels(file).list()).toEqual(['claude-opus-5-5', 'claude-sonnet-4-5-20250929']);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ models: ['claude-opus-5-5', 'claude-sonnet-4-5-20250929'] });
  });

  it('ignores an invalid id', () => {
    const s = new SeenModels(file);
    s.add('');
    s.add('has space');
    s.add('x;rm -rf');
    expect(s.list()).toEqual([]);
  });

  it('tolerates a corrupt file and a file of the wrong shape', () => {
    fs.writeFileSync(file, '{not json');
    const s = new SeenModels(file);
    expect(s.list()).toEqual([]);
    s.add('claude-haiku-4-5');
    expect(new SeenModels(file).list()).toEqual(['claude-haiku-4-5']);
    fs.writeFileSync(file, JSON.stringify({ models: 'nope' }));
    expect(new SeenModels(file).list()).toEqual([]);
    expect(cleanSeen([1, 'claude-opus-5-5', 'claude-opus-5-5', null, 'bad id'])).toEqual(['claude-opus-5-5']);
  });
});
