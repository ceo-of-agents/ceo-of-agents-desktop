import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageStore } from '../../src/main/claude/image-store';
import { attachment, sha256, imageBytes } from '../helpers-images';
import { IMAGE_GRACE_MS, referencedImageIds, removeOrgImages, sweepImages, visibleLogFiles } from '../../src/main/claude/image-cleanup';

const id = (c: string) => c.repeat(64);
const line = (images?: Array<{ id: string; mediaType: string }>) => JSON.stringify({ id: 'e', kind: 'user', text: 'x', ...(images ? { images } : {}) }) + '\n';
const ref = (c: string) => ({ id: id(c), mediaType: 'image/png' });

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-sweep-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('referencedImageIds', () => {
  it('reads the CoS log and the logs of open chats, not closed ones; skips bad lines', async () => {
    fs.mkdirSync(path.join(root, 'tabs'));
    fs.writeFileSync(path.join(root, 'cos.jsonl'), line([ref('a')]) + 'not json {"images"\n' + line() + line([ref('b'), { id: '../x', mediaType: 'image/png' }]));
    fs.writeFileSync(path.join(root, 'tabs', 'open1.jsonl'), line([ref('c')]) + '{"images":[null,5,{"id":7}]}\n');
    fs.writeFileSync(path.join(root, 'tabs', 'closed1.jsonl'), line([ref('d')]));
    fs.writeFileSync(path.join(root, 'tabs', 'notes.txt'), line([ref('e')]));
    const files = await visibleLogFiles(root, new Set(['closed1']));
    expect(files.map((f) => path.relative(root, f)).sort()).toEqual(['cos.jsonl', path.join('tabs', 'open1.jsonl')]);
    expect([...(await referencedImageIds(files))].sort()).toEqual([id('a'), id('b'), id('c')]);
  });

  it('a missing log or tabs folder is not an error', async () => {
    expect(await visibleLogFiles(root, new Set())).toEqual([path.join(root, 'cos.jsonl')]);
    expect((await referencedImageIds([path.join(root, 'cos.jsonl')])).size).toBe(0);
  });
});

describe('sweepImages', () => {
  const old = new Date(2020, 1, 1);
  const put = (name: string, when?: Date) => {
    const f = path.join(root, name);
    fs.writeFileSync(f, 'x');
    if (when) fs.utimesSync(f, when, when);
    return f;
  };

  it('deletes an old unreferenced image, keeps a referenced one and one younger than the grace period', async () => {
    const gone = put(`${id('a')}.png`, old);
    const kept = put(`${id('b')}.jpg`, old);
    const fresh = put(`${id('c')}.webp`);
    expect(await sweepImages(root, new Set([id('b')]))).toBe(1);
    expect(fs.existsSync(gone)).toBe(false);
    expect(fs.existsSync(kept)).toBe(true);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(IMAGE_GRACE_MS).toBe(10 * 60 * 1000);
    // With no grace period the fresh one goes too (`now` a little ahead: mtimeMs has sub-millisecond precision, Date.now() does not).
    await sweepImages(root, new Set([id('b')]), { graceMs: 0, now: Date.now() + 1000 });
    expect(fs.existsSync(fresh)).toBe(false);
    expect(fs.existsSync(kept)).toBe(true);
  });

  it('deletes the store\'s own temporary files older than the grace period, even when the image is referenced', async () => {
    const oldTmp = put(`${id('a')}.png.4242.tmp`, old);
    const freshTmp = put(`${id('b')}.jpg.4242.tmp`);
    const image = put(`${id('a')}.png`, old);
    expect(await sweepImages(root, new Set([id('a')]))).toBe(1);
    expect(fs.existsSync(oldTmp)).toBe(false);
    expect(fs.existsSync(freshTmp)).toBe(true);
    expect(fs.existsSync(image)).toBe(true);
  });

  it('leaves files with other names, folders and symlinks alone', async () => {
    const others = [`${id('a')}.txt`, `${id('a')}.png.tmp`, `${'a'.repeat(63)}.png`, `${id('A')}.png`, 'notes.png', `x${id('a')}.png`].map((n) => put(n, old));
    const outside = path.join(root, 'outside', 'target.png');
    fs.mkdirSync(path.dirname(outside));
    fs.writeFileSync(outside, 'secret');
    const dir = path.join(root, 'images');
    fs.mkdirSync(dir);
    fs.symlinkSync(outside, path.join(dir, `${id('b')}.png`));
    fs.mkdirSync(path.join(dir, `${id('c')}.png`)); // a folder named like an image
    for (const n of others) fs.renameSync(n, path.join(dir, path.basename(n)));
    expect(await sweepImages(dir, new Set(), { graceMs: 0 })).toBe(0);
    expect(fs.readdirSync(dir)).toHaveLength(others.length + 2);
    expect(fs.readFileSync(outside, 'utf8')).toBe('secret');
  });

  it('a missing folder is fine', async () => {
    expect(await sweepImages(path.join(root, 'nope'), new Set())).toBe(0);
  });

  describe('race with ImageStore.put', () => {
    // An old, unreferenced image is a deletion candidate; while the sweep is between listing and deleting, the same
    // image is sent again: put, then the log entry that references it.
    const dir = () => path.join(root, 'images');
    const log = () => path.join(root, 'cos.jsonl');
    const refs = async () => referencedImageIds([log()]);
    const setup = () => {
      const store = new ImageStore(dir());
      const ref = store.put(attachment());
      const file = path.join(dir(), `${ref.id}.png`);
      fs.utimesSync(file, old, old);
      const resend = () => {
        store.put(attachment());
        fs.appendFileSync(log(), line([ref]));
      };
      return { store, ref, file, resend };
    };
    const old = new Date(2020, 1, 1);

    afterEach(() => vi.restoreAllMocks());

    it('sanity: with no send in between, the old unreferenced image is deleted (a store that stored it just now keeps it)', async () => {
      const { file, store } = setup();
      expect(await sweepImages(dir(), refs, { isInUse: (id) => store.usedWithin(id, IMAGE_GRACE_MS) })).toBe(0);
      expect(await sweepImages(dir(), refs, { isInUse: (id) => new ImageStore(dir()).usedWithin(id, IMAGE_GRACE_MS) })).toBe(1);
      expect(fs.existsSync(file)).toBe(false);
    });

    it('a send after the folder is listed: the references read next see it, the file stays and resolves', async () => {
      const { store, ref, file, resend } = setup();
      const n = await sweepImages(dir(), refs, { isInUse: (id) => store.usedWithin(id, IMAGE_GRACE_MS), onStage: (s) => (s === 'listed' ? resend() : undefined) });
      expect(n).toBe(0);
      expect(fs.existsSync(file)).toBe(true);
      expect(store.get(ref.id)).toBe(`data:image/png;base64,${imageBytes('image/png').toString('base64')}`);
      expect((await refs()).has(ref.id)).toBe(true);
    });

    it('a send after the references were read: the refreshed time keeps the file', async () => {
      const { store, ref, file, resend } = setup();
      const n = await sweepImages(dir(), refs, { onStage: (s) => (s === 'checked' ? resend() : undefined) });
      expect(n).toBe(0);
      expect(fs.existsSync(file)).toBe(true);
      expect(store.get(ref.id)).not.toBeNull();
    });

    it('a send after the references were read, with the time not refreshed: the store\'s own record keeps the file', async () => {
      const { store, ref, file, resend } = setup();
      vi.spyOn(fs, 'utimesSync').mockImplementation(() => {
        throw Object.assign(new Error('denied'), { code: 'EPERM' });
      });
      const n = await sweepImages(dir(), refs, { isInUse: (id) => store.usedWithin(id, IMAGE_GRACE_MS), onStage: (s) => (s === 'checked' ? resend() : undefined) });
      expect(n).toBe(0);
      expect(fs.readFileSync(file)).toEqual(imageBytes('image/png'));
      expect(store.get(ref.id)).not.toBeNull();
      expect(sha256(imageBytes('image/png'))).toBe(ref.id);
    });

    it('the file is replaced by a symlink after listing: it is not followed or deleted', async () => {
      const { file } = setup();
      const outside = path.join(root, 'outside.png');
      fs.writeFileSync(outside, 'secret');
      const n = await sweepImages(dir(), new Set(), {
        onStage: (s) => {
          if (s !== 'listed') return;
          fs.unlinkSync(file);
          fs.symlinkSync(outside, file);
        },
      });
      expect(n).toBe(0);
      expect(fs.readFileSync(outside, 'utf8')).toBe('secret');
      expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    });
  });
});

describe('removeOrgImages', () => {
  it('deletes the org images folder entirely and nothing else of the org', async () => {
    const org = path.join(root, 'orgs', 'abc123');
    fs.mkdirSync(path.join(org, 'images'), { recursive: true });
    fs.writeFileSync(path.join(org, 'images', `${id('a')}.png`), 'x');
    fs.writeFileSync(path.join(org, 'cos.jsonl'), '');
    fs.mkdirSync(path.join(root, 'orgs', 'other', 'images'), { recursive: true });
    await removeOrgImages(root, 'abc123');
    expect(fs.existsSync(path.join(org, 'images'))).toBe(false);
    expect(fs.existsSync(path.join(org, 'cos.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'orgs', 'other', 'images'))).toBe(true);
    await removeOrgImages(root, 'abc123'); // already gone: fine
  });

  it('rejects an unsafe org id and deletes nothing', async () => {
    fs.mkdirSync(path.join(root, 'orgs', 'a', 'images'), { recursive: true });
    for (const bad of ['', '.', '..', '../a', 'a/../a', 'a/b', '/etc', 'a\0b', '.hidden/..']) {
      await expect(removeOrgImages(root, bad)).rejects.toThrow('Unsafe org id');
    }
    expect(fs.existsSync(path.join(root, 'orgs', 'a', 'images'))).toBe(true);
  });
});
