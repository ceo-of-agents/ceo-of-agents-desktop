import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readInboxNotes } from '../../src/main/hq/inbox';

let hq: string;
beforeEach(() => {
  hq = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-inbox-'));
});
afterEach(() => fs.rmSync(hq, { recursive: true, force: true }));

describe('readInboxNotes', () => {
  it('a missing inbox is an empty list', () => expect(readInboxNotes(hq)).toEqual([]));

  it('lists the .md notes with their from and title; skips README.md, other files and subfolders', () => {
    const inbox = path.join(hq, 'inbox');
    fs.mkdirSync(path.join(inbox, 'sub.md'), { recursive: true });
    fs.mkdirSync(path.join(inbox, 'archive'));
    fs.writeFileSync(path.join(inbox, 'archive', 'old.md'), '# old\n');
    fs.writeFileSync(path.join(inbox, 'README.md'), '# index\n');
    fs.writeFileSync(path.join(inbox, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(inbox, 'b.md'), '# Plain\n');
    fs.writeFileSync(path.join(inbox, 'a.md'), '---\nfrom: engineering\n---\n# Merge it\n');
    const notes = readInboxNotes(hq);
    expect(notes.map((n) => n.path)).toEqual([path.join('inbox', 'a.md'), path.join('inbox', 'b.md')]);
    expect(notes[0].from).toBe('engineering');
    expect(notes[0].title).toBe('Merge it');
    expect(notes[1].from).toBeNull();
  });

  it('leaves out notes addressed to another department; counts the CoS name and a missing to', () => {
    const inbox = path.join(hq, 'inbox');
    fs.mkdirSync(inbox);
    fs.writeFileSync(path.join(inbox, 'a.md'), '---\nfrom: engineering\nto: design-brand\n---\n# Not for the CoS\n');
    fs.writeFileSync(path.join(inbox, 'b.md'), '---\nfrom: engineering\nto: Ada\n---\n# By name\n');
    fs.writeFileSync(path.join(inbox, 'c.md'), '---\nfrom: engineering\nto: cos\n---\n# To cos\n');
    expect(readInboxNotes(hq, ['cos', 'ada']).map((n) => n.path)).toEqual([path.join('inbox', 'b.md'), path.join('inbox', 'c.md')]);
    expect(readInboxNotes(hq).map((n) => n.path)).toEqual([path.join('inbox', 'c.md')]);
  });
});
