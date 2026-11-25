import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_IMAGES, MAX_IMAGE_BYTES } from '../../src/shared/images';
import { dragHasFiles, draftImages, imageFilesFromPaste, ipcErrorText, readImageFile, restoreAfterRejectedSend, screenCandidates, splitDataUrl } from '../../src/renderer/composer-images';
import { attachment, imageBytes } from '../helpers-images';

describe('screenCandidates', () => {
  const png = { type: 'image/png', size: 100 };
  it('accepts images and reports no problem', () => {
    expect(screenCandidates(0, [png, { type: 'image/webp', size: 5 }])).toEqual({ accepted: [0, 1], problem: null });
  });
  it('leaves out other types, empty files and files over the cap, reporting the first reason', () => {
    expect(screenCandidates(0, [{ type: 'text/plain', size: 10 }, png])).toEqual({ accepted: [1], problem: 'type' });
    expect(screenCandidates(0, [{ type: 'image/png', size: 0 }])).toEqual({ accepted: [], problem: 'format' });
    expect(screenCandidates(0, [{ type: 'image/png', size: MAX_IMAGE_BYTES + 1 }, png])).toEqual({ accepted: [1], problem: 'size' });
    expect(screenCandidates(0, [{ type: 'image/svg+xml', size: 10 }]).problem).toBe('type');
  });
  it('stops at MAX_IMAGES counting what is already there', () => {
    const many = Array.from({ length: MAX_IMAGES + 2 }, () => png);
    expect(screenCandidates(0, many).accepted).toHaveLength(MAX_IMAGES);
    expect(screenCandidates(0, many).problem).toBe('count');
    expect(screenCandidates(MAX_IMAGES - 1, [png, png])).toEqual({ accepted: [0], problem: 'count' });
    expect(screenCandidates(MAX_IMAGES, [png])).toEqual({ accepted: [], problem: 'count' });
  });
});

describe('splitDataUrl', () => {
  it('returns the base64 part, null for anything else', () => {
    expect(splitDataUrl('data:image/png;base64,QUJD')).toBe('QUJD');
    expect(splitDataUrl('data:;base64,')).toBe('');
    expect(splitDataUrl('data:text/plain,hello')).toBeNull();
    expect(splitDataUrl('https://example.com/a.png')).toBeNull();
  });
});

describe('imageFilesFromPaste', () => {
  const item = (kind: string, type: string, file: string | null = null) => ({ kind, type, getAsFile: () => file });
  it('takes the image files of a paste', () => {
    expect(imageFilesFromPaste([item('file', 'image/png', 'a'), item('file', 'image/jpeg', 'b')])).toEqual(['a', 'b']);
  });
  it('leaves a paste with plain text alone, even when a preview image comes with it', () => {
    expect(imageFilesFromPaste([item('string', 'text/plain'), item('file', 'image/png', 'a')])).toEqual([]);
    expect(imageFilesFromPaste([item('string', 'text/plain')])).toEqual([]);
  });
  it('ignores other files and items that give no file', () => {
    expect(imageFilesFromPaste([item('file', 'application/pdf', 'x'), item('file', 'image/png', null), item('string', 'text/html')])).toEqual([]);
  });
});

describe('dragHasFiles', () => {
  it('is true only when the drag carries files', () => {
    expect(dragHasFiles(['Files', 'text/plain'])).toBe(true);
    expect(dragHasFiles(['text/plain'])).toBe(false);
    expect(dragHasFiles(null)).toBe(false);
  });
});

describe('ipcErrorText', () => {
  it('drops the wrapper Electron puts around a main process error', () => {
    expect(ipcErrorText(new Error("Error invoking remote method 'send': Error: At most 5 images in one message."))).toBe('At most 5 images in one message.');
    expect(ipcErrorText('plain')).toBe('plain');
  });
});

describe('draftImages', () => {
  it('keeps a list per chat and forgets an empty one', () => {
    const list = [{ key: 'img1', attachment: attachment() }];
    draftImages.set('o|cos', list);
    expect(draftImages.get('o|cos')).toBe(list);
    expect(draftImages.get('o|tab:1')).toEqual([]);
    draftImages.set('o|cos', []);
    expect(draftImages.get('o|cos')).toEqual([]);
    expect(draftImages.size()).toBe(0);
  });
  it('delete frees one chat and leaves the others', () => {
    const list = [{ key: 'img1', attachment: attachment() }];
    draftImages.set('o|tab:1', list);
    draftImages.set('o|tab:2', list);
    draftImages.delete('o|tab:1');
    expect(draftImages.get('o|tab:1')).toEqual([]);
    expect(draftImages.get('o|tab:2')).toBe(list);
    draftImages.delete('o|tab:1');
    draftImages.delete('o|tab:2');
    expect(draftImages.size()).toBe(0);
  });
  it('deleteOrg frees every chat of that org only, not an org whose id starts the same', () => {
    const list = [{ key: 'img1', attachment: attachment() }];
    for (const k of ['a|cos', 'a|tab:1', 'ab|cos', 'b|tab:1']) draftImages.set(k, list);
    draftImages.deleteOrg('a');
    expect(draftImages.size()).toBe(2);
    expect(draftImages.get('a|cos')).toEqual([]);
    expect(draftImages.get('a|tab:1')).toEqual([]);
    expect(draftImages.get('ab|cos')).toBe(list);
    expect(draftImages.get('b|tab:1')).toBe(list);
    draftImages.deleteOrg('ab');
    draftImages.deleteOrg('b');
    expect(draftImages.size()).toBe(0);
  });
});

describe('restoreAfterRejectedSend', () => {
  const imgs = [{ key: 'img1', attachment: attachment() }];
  const typed = [{ key: 'img9', attachment: attachment('image/gif') }];
  const chip = { code: 'ACME-D3', text: 'Pick one' };
  const sent = { text: '  my note ', images: imgs, reply: chip };
  const empty = { text: '', images: [], reply: null };

  it('gives back the text exactly as it was, the images and the chip when the composer is empty', () => {
    expect(restoreAfterRejectedSend(sent, empty)).toEqual(sent);
  });
  it('treats whitespace-only text as empty', () => {
    expect(restoreAfterRejectedSend(sent, { ...empty, text: '  \n' }).text).toBe('  my note ');
  });
  it('keeps text typed after sending and restores the empty parts', () => {
    expect(restoreAfterRejectedSend(sent, { ...empty, text: 'new' })).toEqual({ text: 'new', images: imgs, reply: chip });
  });
  it('keeps images added after sending and restores the empty parts', () => {
    expect(restoreAfterRejectedSend(sent, { ...empty, images: typed })).toEqual({ text: '  my note ', images: typed, reply: chip });
  });
  it('keeps a chip set after sending', () => {
    const other = { code: null, text: 'raw line' };
    expect(restoreAfterRejectedSend(sent, { ...empty, reply: other })).toEqual({ text: '  my note ', images: imgs, reply: other });
  });
  it('restores nothing over a composer that is full', () => {
    const now = { text: 'new', images: typed, reply: { code: 'ACME-A1', text: 'x' } };
    expect(restoreAfterRejectedSend(sent, now)).toEqual(now);
  });
  it('sends without a chip leave the chip empty', () => {
    expect(restoreAfterRejectedSend({ ...sent, reply: null }, empty).reply).toBeNull();
  });
});

describe('readImageFile', () => {
  // The vitest environment is node: a FileReader that reads a Blob is enough for what the helper uses.
  class FakeReader {
    result: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL(file: Blob & { type: string }) {
      void file.arrayBuffer().then((buf) => {
        this.result = `data:${file.type};base64,${Buffer.from(buf).toString('base64')}`;
        this.onload?.();
      });
    }
  }
  beforeEach(() => vi.stubGlobal('FileReader', FakeReader));
  afterEach(() => vi.unstubAllGlobals());

  it('returns the attachment of a valid image', async () => {
    const bytes = imageBytes('image/png');
    const file = new File([new Uint8Array(bytes)], 'a.png', { type: 'image/png' });
    expect(await readImageFile(file)).toEqual({ mediaType: 'image/png', data: bytes.toString('base64') });
  });
  it('says format when the bytes are not those of the declared type', async () => {
    expect(await readImageFile(new File([new TextEncoder().encode('not an image')], 'a.png', { type: 'image/png' }))).toBe('format');
  });
  it('says format for a type the app does not take', async () => {
    expect(await readImageFile(new File([new Uint8Array(imageBytes('image/png'))], 'a.svg', { type: 'image/svg+xml' }))).toBe('format');
  });
});
