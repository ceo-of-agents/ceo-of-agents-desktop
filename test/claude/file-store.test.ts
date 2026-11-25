import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { referencedFileIds, removeOrgFiles, sweepFiles } from '../../src/main/claude/file-cleanup';
import { FILE_ID, FileStore } from '../../src/main/claude/file-store';
import { sha256 } from '../helpers-images';

let root: string;
let store: FileStore;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-files-'));
  store = new FileStore(path.join(root, 'files'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const file = (name: string, text = 'hello', type = 'text/plain') => ({ name, mediaType: type, data: new Uint8Array(Buffer.from(text)) });
const old = new Date(2020, 1, 1);

describe('FileStore', () => {
  it('stores a file under <id>/<name> and returns the reference and the path', () => {
    const r = store.put(file('../notes.txt'));
    expect(FILE_ID.test(r.ref.id)).toBe(true);
    expect(r.ref).toMatchObject({ name: 'notes.txt', size: 5, kind: 'other' });
    expect(r.path).toBe(path.join(root, 'files', r.ref.id, 'notes.txt'));
    expect(fs.readFileSync(r.path, 'utf8')).toBe('hello');
    expect(store.pathOf(r.ref)).toBe(r.path);
  });
  it('kinds: pdf, video and audio by type or extension', () => {
    expect(store.put(file('a.pdf', 'p', 'application/pdf')).ref.kind).toBe('pdf');
    expect(store.put(file('a.mov', 'v', '')).ref.kind).toBe('video');
    expect(store.put(file('a.mp3', 'm', 'audio/mpeg')).ref.kind).toBe('audio');
  });
  it('the same bytes and name are stored once; another name is another entry', () => {
    const a = store.put(file('a.txt'));
    const b = store.put(file('a.txt'));
    const c = store.put(file('b.txt'));
    expect(b.ref.id).toBe(a.ref.id);
    expect(c.ref.id).not.toBe(a.ref.id);
    expect(fs.readdirSync(store.dir)).toHaveLength(2);
    expect(a.ref.id).toBe(sha256(Buffer.concat([Buffer.from('a.txt'), Buffer.from([0]), Buffer.from('hello')])));
  });
  it('storing again refreshes the time, and writes the file again when it is gone', () => {
    const a = store.put(file('a.txt'));
    fs.utimesSync(a.path, old, old);
    store.put(file('a.txt'));
    expect(fs.statSync(a.path).mtimeMs).toBeGreaterThan(old.getTime() + 1000);
    fs.rmSync(path.dirname(a.path), { recursive: true });
    store.put(file('a.txt'));
    expect(fs.readFileSync(a.path, 'utf8')).toBe('hello');
    expect(store.usedWithin(a.ref.id, 60_000)).toBe(true);
    expect(store.usedWithin(a.ref.id, 60_000, Date.now() + 120_000)).toBe(false);
  });
  it('pathOf refuses an id or a name the store would not make', () => {
    expect(store.pathOf({ id: '../x', name: 'a.txt' })).toBeNull();
    expect(store.pathOf({ id: 'a'.repeat(64), name: '../a.txt' })).toBeNull();
  });
});

describe('file clean-up', () => {
  it('reads the ids of the files in the logs', async () => {
    const log = path.join(root, 'cos.jsonl');
    const id = 'a'.repeat(64);
    fs.writeFileSync(log, `${JSON.stringify({ kind: 'user', files: [{ id, name: 'a', size: 1, kind: 'other' }, { id: '../x' }, null] })}\nbad {"files"\n`);
    expect([...(await referencedFileIds([log, path.join(root, 'missing.jsonl')]))]).toEqual([id]);
  });
  it('deletes an unreferenced, old file folder; keeps referenced, recent, in-use ones and anything not made by the store', async () => {
    const keep = store.put(file('keep.txt', '1'));
    const gone = store.put(file('gone.txt', '2'));
    const fresh = store.put(file('fresh.txt', '3'));
    const busy = store.put(file('busy.txt', '4'));
    for (const r of [keep, gone, busy]) {
      fs.utimesSync(r.path, old, old);
      fs.utimesSync(path.dirname(r.path), old, old);
    }
    fs.mkdirSync(path.join(store.dir, 'not-an-id'));
    fs.writeFileSync(path.join(store.dir, 'stray.txt'), 'x');
    const n = await sweepFiles(store.dir, new Set([keep.ref.id]), { isInUse: (id) => id === busy.ref.id });
    expect(n).toBe(1);
    expect(fs.existsSync(path.dirname(gone.path))).toBe(false);
    for (const r of [keep, fresh, busy]) expect(fs.existsSync(r.path)).toBe(true);
    expect(fs.existsSync(path.join(store.dir, 'not-an-id'))).toBe(true);
    expect(fs.existsSync(path.join(store.dir, 'stray.txt'))).toBe(true);
  });
  it('an interrupted write (a temporary file only) goes with its folder after the grace period', async () => {
    const id = 'b'.repeat(64);
    const folder = path.join(store.dir, id);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, '.123.tmp'), 'x');
    expect(await sweepFiles(store.dir, new Set())).toBe(0); // too recent
    fs.utimesSync(path.join(folder, '.123.tmp'), old, old);
    fs.utimesSync(folder, old, old);
    expect(await sweepFiles(store.dir, new Set())).toBe(1);
  });
  it('a missing folder is not an error; removeOrgFiles refuses an unsafe id', async () => {
    expect(await sweepFiles(path.join(root, 'nope'), new Set())).toBe(0);
    await expect(removeOrgFiles(root, '../x')).rejects.toThrow();
    store.put(file('a.txt'));
    fs.mkdirSync(path.join(root, 'orgs', 'o1'), { recursive: true });
    await removeOrgFiles(root, 'o1');
  });
});
