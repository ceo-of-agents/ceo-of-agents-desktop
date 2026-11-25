import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IMAGE_ID, ImageStore } from '../../src/main/claude/image-store';
import { attachment, imageBytes, sha256 } from '../helpers-images';

let root: string;
let dir: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-img-'));
  dir = path.join(root, 'images');
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('ImageStore', () => {
  it('stores an image under its sha256 with the extension of its type, and returns id and type', () => {
    const store = new ImageStore(dir);
    const ref = store.put(attachment('image/jpeg'));
    expect(ref).toEqual({ id: sha256(imageBytes('image/jpeg')), mediaType: 'image/jpeg' });
    expect(ref.id).toMatch(IMAGE_ID);
    expect(fs.readdirSync(dir)).toEqual([`${ref.id}.jpg`]);
    expect(fs.readFileSync(path.join(dir, `${ref.id}.jpg`))).toEqual(imageBytes('image/jpeg'));
  });

  it('writes the same image once: the bytes are not written again (only the time is refreshed), no temp files stay', () => {
    const store = new ImageStore(dir);
    const a = store.put(attachment());
    const file = path.join(dir, `${a.id}.png`);
    const old = new Date(2020, 1, 1);
    fs.utimesSync(file, old, old);
    const b = store.put(attachment());
    expect(b).toEqual(a);
    expect(fs.statSync(file).mtime.getTime()).toBeGreaterThan(old.getTime()); // refreshed: the clean-up's grace period restarts
    expect(fs.readFileSync(file)).toEqual(imageBytes('image/png'));
    expect(fs.readdirSync(dir)).toHaveLength(1);
    store.put(attachment('image/png', 9));
    expect(fs.readdirSync(dir)).toHaveLength(2);
  });

  it('put writes the file again when it vanished before the time was refreshed (the clean-up just deleted it)', () => {
    const store = new ImageStore(dir);
    const a = store.put(attachment());
    const file = path.join(dir, `${a.id}.png`);
    const real = fs.utimesSync;
    vi.spyOn(fs, 'utimesSync').mockImplementationOnce((...args) => {
      fs.unlinkSync(file); // gone between the decision and the refresh
      return real(...args);
    });
    expect(store.put(attachment())).toEqual(a);
    expect(fs.readFileSync(file)).toEqual(imageBytes('image/png'));
    expect(fs.readdirSync(dir)).toEqual([`${a.id}.png`]);
    expect(store.get(a.id)).toBe(`data:image/png;base64,${imageBytes('image/png').toString('base64')}`);
  });

  it('put also writes into a folder that does not exist yet', () => {
    const ref = new ImageStore(path.join(dir, 'deeper')).put(attachment('image/webp'));
    expect(fs.existsSync(path.join(dir, 'deeper', `${ref.id}.webp`))).toBe(true);
  });

  it('put does not fail when the time cannot be refreshed (the file stays, usedWithin covers it)', () => {
    const store = new ImageStore(dir);
    const a = store.put(attachment());
    vi.spyOn(fs, 'utimesSync').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });
    expect(store.put(attachment())).toEqual(a);
    expect(fs.readdirSync(dir)).toEqual([`${a.id}.png`]);
    const t = Date.now();
    expect(store.usedWithin(a.id, 1000, t)).toBe(true);
    expect(store.usedWithin(a.id, 1000, t + 1000)).toBe(false);
    expect(store.usedWithin('c'.repeat(64), 1000)).toBe(false);
  });

  it('get returns a data: URL with the right type', () => {
    const store = new ImageStore(dir);
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const) {
      const ref = store.put(attachment(type));
      expect(store.get(ref.id)).toBe(`data:${type};base64,${imageBytes(type).toString('base64')}`);
    }
  });

  it('get returns null for a missing file', () => {
    expect(new ImageStore(dir).get('a'.repeat(64))).toBeNull();
  });

  it('get never throws: a folder named like the image, or a file deleted while it is read, gives null', () => {
    const store = new ImageStore(dir);
    fs.mkdirSync(path.join(dir, `${'d'.repeat(64)}.png`), { recursive: true });
    expect(store.get('d'.repeat(64))).toBeNull();
    const ref = store.put(attachment('image/gif'));
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    });
    expect(store.get(ref.id)).toBeNull();
  });

  it('get checks the id before touching the file system', () => {
    const store = new ImageStore(dir);
    // A file outside the store that a path trick would reach.
    fs.writeFileSync(path.join(root, 'secret.png'), imageBytes('image/png'));
    fs.mkdirSync(dir, { recursive: true });
    const bad = ['../secret', '../secret.png', `../${'a'.repeat(61)}`, '', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), `${'a'.repeat(63)}/`, `${'a'.repeat(64)}.png`, `${'a'.repeat(60)}/../`, 'g'.repeat(64), '\0', null, undefined, 5, {}];
    for (const id of bad) expect(store.get(id)).toBeNull();
    expect(IMAGE_ID.test('../x')).toBe(false);
    expect(IMAGE_ID.test(sha256(Buffer.from('x')))).toBe(true);
  });

  it('get returns null when the stored bytes do not match their extension', () => {
    const store = new ImageStore(dir);
    fs.mkdirSync(dir, { recursive: true });
    const id = 'b'.repeat(64);
    fs.writeFileSync(path.join(dir, `${id}.png`), 'not a png');
    expect(store.get(id)).toBeNull();
  });
});
