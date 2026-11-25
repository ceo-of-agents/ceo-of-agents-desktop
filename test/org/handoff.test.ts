import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changedSince, findInboxNote, inboxSnapshot, noteFrom, noteTitle, noteTo, ownInboxNote, ownsNote, toCos, turnWrittenNotes, writtenSince, type NoteOwner } from '../../src/main/org/handoff';

let hq: string;
beforeEach(() => {
  hq = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-hand-'));
  fs.mkdirSync(path.join(hq, 'inbox'));
});
afterEach(() => fs.rmSync(hq, { recursive: true, force: true }));

const put = (rel: string, body = 'x', mtime?: number) => {
  const p = path.join(hq, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  if (mtime) fs.utimesSync(p, mtime / 1000, mtime / 1000);
};
const write = (file_path: string, name = 'Write', ok = true) => ({ name, input: { file_path }, ok });
const none = new Map<string, number>();

describe('ownInboxNote', () => {
  it('a successful Write, Edit or MultiEdit that created an inbox note counts (absolute or relative path)', () => {
    put('inbox/a.md');
    put('inbox/b.md');
    expect(ownInboxNote(hq, [write('inbox/a.md', 'MultiEdit')], none)).toBe('inbox/a.md');
    expect(ownInboxNote(hq, [write(path.join(hq, 'inbox/a.md'))], none)).toBe('inbox/a.md');
    expect(ownInboxNote(hq, [write('inbox/b.md', 'Edit')], none)).toBe('inbox/b.md');
  });

  it('prefers the last qualifying write', () => {
    put('inbox/a.md');
    put('inbox/b.md');
    expect(ownInboxNote(hq, [write('inbox/a.md'), write('inbox/b.md')], none)).toBe('inbox/b.md');
    expect(ownInboxNote(hq, [write('inbox/a.md'), write('inbox/b.md', 'Write', false)], none)).toBe('inbox/a.md');
  });

  it('a failed or denied call never counts, even when the file exists', () => {
    put('inbox/a.md');
    expect(ownInboxNote(hq, [write('inbox/a.md', 'Write', false)], none)).toBeNull();
  });

  it('an Edit that left an older note as it was does not count; one that changed it does', () => {
    put('inbox/old.md', 'x', 1_000_000);
    const before = inboxSnapshot(hq);
    expect(ownInboxNote(hq, [write('inbox/old.md', 'Edit')], before)).toBeNull();
    put('inbox/old.md', 'changed', 2_000_000);
    expect(ownInboxNote(hq, [write('inbox/old.md', 'Edit')], before)).toBe('inbox/old.md');
    put('inbox/new.md', 'x', 500_000); // a new file counts whatever its mtime
    expect(ownInboxNote(hq, [write('inbox/new.md')], before)).toBe('inbox/new.md');
  });

  it('ignores README.md, files outside inbox, subfolders, ../ tricks and other extensions', () => {
    put('inbox/README.md');
    put('notes/x.md');
    put('x.md');
    const tools = [write('inbox/README.md'), write('notes/x.md'), write('inbox/../x.md'), write('inbox/../../etc/x.md'), write('inbox/sub/y.md'), write('inbox/a.txt')];
    expect(ownInboxNote(hq, tools, none)).toBeNull();
  });

  it('ignores non-write tools, a write whose file does not exist, and an empty turn', () => {
    put('inbox/a.md');
    expect(ownInboxNote(hq, [write('inbox/missing.md'), write('inbox/a.md', 'Read'), write('inbox/a.md', 'Bash')], none)).toBeNull();
    expect(ownInboxNote(hq, [], none)).toBeNull();
  });

  it('a changed inbox file nobody wrote with a tool call does not count (no fallback)', () => {
    put('inbox/other.md');
    expect(ownInboxNote(hq, [], none)).toBeNull();
  });
});

describe('inboxSnapshot', () => {
  it('maps file names to mtimes; a missing inbox is empty', () => {
    put('inbox/a.md', 'x', 1_000_000);
    expect(inboxSnapshot(hq).get('a.md')).toBe(1_000_000);
    expect(inboxSnapshot(path.join(hq, 'nowhere')).size).toBe(0);
  });
});

describe('noteTitle', () => {
  it('uses the first line under "## Ask or finding"', () => {
    const note = '---\nfrom: x\n---\n# Heading\n\n## Ask or finding\n\nShip the thing\nmore\n';
    expect(noteTitle(note, 'inbox/f.md')).toBe('Ship the thing');
  });
  it('else the first heading', () => {
    expect(noteTitle('Intro\n## Second\ntext', 'inbox/f.md')).toBe('Second');
  });
  it('else the file name', () => {
    expect(noteTitle('just text', 'inbox/2026-01-01-x.md')).toBe('2026-01-01-x');
  });
  it('truncates at 100 chars', () => {
    const t = noteTitle(`# ${'a'.repeat(150)}`, 'inbox/f.md');
    expect(t).toHaveLength(100);
    expect(t.endsWith('...')).toBe(true);
    expect(noteTitle(`# ${'a'.repeat(100)}`, 'inbox/f.md')).toHaveLength(100);
  });
});

const owner: NoteOwner = { id: 'engineering', agent: 'max', persona: 'Max' };
const fm = (from: string) => `---\nfrom: ${from}\nto: cos\n---\n# Note\n`;

describe('noteFrom', () => {
  it('reads the from of a leading frontmatter block', () => {
    expect(noteFrom('---\nfrom: engineering\nto: cos\n---\n# x')).toBe('engineering');
    expect(noteFrom('---\r\nfrom: engineering\r\n---\r\nbody')).toBe('engineering');
  });
  it('strips surrounding quotes and spaces', () => {
    expect(noteFrom('---\nfrom: "engineering"\n---\n')).toBe('engineering');
    expect(noteFrom("---\nfrom:   'Max'  \n---\n")).toBe('Max');
  });
  it('null without frontmatter, without a from, with an empty from or when the block is not leading', () => {
    expect(noteFrom('# Title\nfrom: max')).toBeNull();
    expect(noteFrom('---\nto: cos\n---\n')).toBeNull();
    expect(noteFrom('---\nfrom:\n---\n')).toBeNull();
    expect(noteFrom('text\n---\nfrom: max\n---\n')).toBeNull();
    expect(noteFrom('---\nfrom: max\nno end')).toBeNull();
  });
});

describe('noteTo and toCos', () => {
  it('noteTo reads the to of the frontmatter', () => {
    expect(noteTo('---\nfrom: max\nto: "CoS"\n---\n')).toBe('CoS');
    expect(noteTo('---\nfrom: max\n---\n')).toBeNull();
    expect(noteTo('to: cos')).toBeNull();
  });
  it('a to that is cos (any case) or the CoS name counts; another department does not; no to counts', () => {
    expect(toCos('cos', 'a.md')).toBe(true);
    expect(toCos(' CoS ', 'a.md')).toBe(true);
    expect(toCos('Ada', 'a.md', ['cos', 'Ada'])).toBe(true);
    expect(toCos('design-brand', 'a.md')).toBe(false);
    expect(toCos(null, 'a.md')).toBe(true);
  });
  it('with no to, the file name decides: -to-cos- counts, -to-<other>- does not, no -to- counts', () => {
    expect(toCos(null, '2026-01-01-engineering-to-cos-x.md')).toBe(true);
    expect(toCos(null, '2026-01-01-engineering-to-design-brand-x.md')).toBe(false);
    expect(toCos(null, '2026-01-01-engineering-x.md')).toBe(true);
  });
});

describe('turnWrittenNotes', () => {
  it('collects inbox notes from Write, Edit, MultiEdit and Bash commands, of the chat and of its sub-agents', () => {
    const r = turnWrittenNotes(
      hq,
      [{ name: 'Write', input: { file_path: path.join(hq, 'inbox/a.md') } }, { name: 'Bash', input: { command: `cat > inbox/b.md <<EOF && ls inbox/c.md; echo "${hq}/inbox/d.md"` } }],
      [{ name: 'Edit', input: { file_path: 'inbox/e.md' } }, { name: 'Read', input: { file_path: 'inbox/f.md' } }, { name: 'Write', input: { file_path: 'notes/g.md' } }, { name: 'Write', input: { file_path: 'inbox/README.md' } }],
    );
    expect([...r].sort()).toEqual(['inbox/a.md', 'inbox/b.md', 'inbox/c.md', 'inbox/d.md', 'inbox/e.md']);
  });
});

describe('ownsNote', () => {
  it('a from that is the department id, the agent or the persona, in any case', () => {
    expect(ownsNote(owner, 'engineering', 'a.md')).toBe(true);
    expect(ownsNote(owner, 'max', 'a.md')).toBe(true);
    expect(ownsNote(owner, ' MAX ', 'a.md')).toBe(true);
    expect(ownsNote(owner, 'Engineering', 'a.md')).toBe(true);
  });
  it('a from of another department is refused, even when the file name says otherwise', () => {
    expect(ownsNote(owner, 'design-brand', '2026-01-01-engineering-to-cos-x.md')).toBe(false);
  });
  it('without a from the file name decides: -<id>- or -<agent>- in it', () => {
    expect(ownsNote(owner, null, '2026-01-01-engineering-to-cos-x.md')).toBe(true);
    expect(ownsNote(owner, null, '2026-01-01-MAX-to-cos-x.md')).toBe(true);
    expect(ownsNote(owner, null, '2026-01-01-design-brand-to-cos-x.md')).toBe(false);
    expect(ownsNote(owner, null, '2026-01-01-maxwell-to-cos-x.md')).toBe(false);
  });
  it('the file name fallback looks only at the sender, before -to-', () => {
    expect(ownsNote(owner, null, '2026-01-01-cos-to-engineering-x.md')).toBe(false);
    expect(ownsNote(owner, null, '2026-01-01-cos-to-max-x.md')).toBe(false);
    expect(ownsNote(owner, null, '2026-01-01-engineering-x.md')).toBe(true);
  });
  it('an owner with no id still matches by agent and persona', () => {
    const o: NoteOwner = { id: null, agent: 'max', persona: 'Max' };
    expect(ownsNote(o, 'Max', 'a.md')).toBe(true);
    expect(ownsNote(o, null, 'x-max-to-y.md')).toBe(true);
    expect(ownsNote(o, null, 'x-y.md')).toBe(false);
  });
});

describe('findInboxNote', () => {
  const any = () => true;
  it('finds a note of the owner as inbox/<name>', () => {
    put('inbox/2026-01-01-engineering-to-cos-x.md', fm('engineering'));
    expect(findInboxNote(hq, owner, any)).toBe(path.join('inbox', '2026-01-01-engineering-to-cos-x.md'));
  });
  it('null when there is no inbox folder or no note', () => {
    expect(findInboxNote(hq, owner, any)).toBeNull();
    expect(findInboxNote(path.join(hq, 'missing'), owner, any)).toBeNull();
  });
  it('README.md (any case), non-md files, subfolders and symlinks never count', () => {
    put('inbox/README.md', fm('engineering'));
    put('inbox/readme.MD', fm('engineering'));
    put('inbox/a.txt', fm('engineering'));
    put('inbox/sub/b.md', fm('engineering'));
    put('elsewhere.md', fm('engineering'));
    fs.symlinkSync(path.join(hq, 'elsewhere.md'), path.join(hq, 'inbox', 'link.md'));
    fs.mkdirSync(path.join(hq, 'inbox', 'dir.md'));
    expect(findInboxNote(hq, owner, any)).toBeNull();
  });
  it('a symlink to a valid note of the owner is skipped', () => {
    put('elsewhere.md', fm('max'));
    fs.symlinkSync(path.join(hq, 'elsewhere.md'), path.join(hq, 'inbox', 'link.md'));
    expect(findInboxNote(hq, owner, any)).toBeNull();
  });
  it('a note to another department is not taken; to cos, the CoS name or no to is', () => {
    put('inbox/a.md', '---\nfrom: max\nto: design-brand\n---\n');
    expect(findInboxNote(hq, owner, any)).toBeNull();
    put('inbox/2026-01-01-max-to-design-brand-x.md', '# plain');
    expect(findInboxNote(hq, owner, any)).toBeNull();
    put('inbox/b.md', '---\nfrom: max\nto: Ada\n---\n');
    expect(findInboxNote(hq, owner, any)).toBeNull();
    expect(findInboxNote(hq, owner, any, new Set(), ['cos', 'Ada'])).toBe(path.join('inbox', 'b.md'));
    put('inbox/c.md', '---\nfrom: max\n---\n', Date.now() - 5000);
    expect(findInboxNote(hq, owner, any)).toBe(path.join('inbox', 'c.md'));
  });
  it('ownInboxNote refuses a note the chat wrote for another department', () => {
    put('inbox/a.md', '---\nfrom: max\nto: design-brand\n---\n');
    expect(ownInboxNote(hq, [write('inbox/a.md')], none)).toBeNull();
    put('inbox/b.md', '---\nfrom: max\nto: cos\n---\n');
    expect(ownInboxNote(hq, [write('inbox/b.md')], none)).toBe('inbox/b.md');
  });
  it('another department\'s note is not taken', () => {
    put('inbox/a.md', fm('design-brand'));
    expect(findInboxNote(hq, owner, any)).toBeNull();
  });
  it('a note with no frontmatter counts by its file name', () => {
    put('inbox/2026-01-01-engineering-to-cos-x.md', '# plain');
    put('inbox/2026-01-01-other-to-cos-x.md', '# plain');
    expect(findInboxNote(hq, owner, any)).toBe(path.join('inbox', '2026-01-01-engineering-to-cos-x.md'));
  });
  it('exclude holds names as inbox/<name>', () => {
    put('inbox/a.md', fm('max'));
    put('inbox/b.md', fm('max'), Date.now() - 5000);
    expect(findInboxNote(hq, owner, any, new Set([path.join('inbox', 'a.md')]))).toBe(path.join('inbox', 'b.md'));
    expect(findInboxNote(hq, owner, any, new Set(['a.md']))).toBe(path.join('inbox', 'a.md'));
  });
  it('the newest by mtime wins', () => {
    put('inbox/old.md', fm('max'), Date.now() - 60_000);
    put('inbox/new.md', fm('max'), Date.now() - 1000);
    put('inbox/mid.md', fm('max'), Date.now() - 30_000);
    expect(findInboxNote(hq, owner, any)).toBe(path.join('inbox', 'new.md'));
  });
  it('a newer note of another department does not hide an older one of the owner', () => {
    put('inbox/mine.md', fm('max'), Date.now() - 60_000);
    put('inbox/theirs.md', fm('bea'), Date.now() - 1000);
    expect(findInboxNote(hq, owner, any)).toBe(path.join('inbox', 'mine.md'));
  });
  it('only candidates count: changedSince a snapshot, writtenSince a moment', () => {
    const t0 = Date.now() - 10_000;
    put('inbox/a.md', fm('max'), t0);
    const snap = inboxSnapshot(hq);
    expect(findInboxNote(hq, owner, changedSince(snap))).toBeNull();
    put('inbox/a.md', fm('max'), t0 + 5000); // changed
    expect(findInboxNote(hq, owner, changedSince(snap))).toBe(path.join('inbox', 'a.md'));
    put('inbox/b.md', fm('max'), t0 + 1000); // new, but older than the moment
    expect(findInboxNote(hq, owner, writtenSince(t0 + 5500))).toBeNull();
    expect(findInboxNote(hq, owner, writtenSince(t0 + 4000))).toBe(path.join('inbox', 'a.md'));
  });
  it('reads only the first 8 KB: a from after them is not seen', () => {
    put('inbox/a.md', '---\n' + 'x: ' + 'y'.repeat(9000) + '\nfrom: max\n---\n');
    expect(findInboxNote(hq, owner, any)).toBeNull(); // no closing block in the head, so no from: the name decides, and it does not name the owner
  });
  it('an unreadable file is skipped, never an error', () => {
    put('inbox/a.md', fm('max'));
    put('inbox/b.md', fm('max'), Date.now() - 5000);
    fs.chmodSync(path.join(hq, 'inbox', 'a.md'), 0o000);
    try {
      const r = findInboxNote(hq, owner, any);
      // running as root can still read it: then a.md (newest) is found
      expect([path.join('inbox', 'b.md'), path.join('inbox', 'a.md')]).toContain(r);
    } finally {
      fs.chmodSync(path.join(hq, 'inbox', 'a.md'), 0o644);
    }
  });
});
