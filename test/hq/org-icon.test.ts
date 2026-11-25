import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_ORG_ICON_FILE, MAX_ORG_ICON_UPLOAD, ORG_ICON_PATH, ORG_ICON_SIZE, orgIconStamp, pngSize, readOrgIcon, readOrgIconSource, removeOrgIcon, writeOrgIcon } from '../../src/main/hq/org-icon';
import { classify } from '../../src/main/hq/watch';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A PNG-shaped buffer: signature, an IHDR chunk of this size, then filler. Not a decodable image: main only checks the header. */
const png = (w: number, h: number, tail = 'x'): Buffer => {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);
  return Buffer.concat([SIG, ihdr, Buffer.from(tail)]);
};
const PNG = png(ORG_ICON_SIZE, ORG_ICON_SIZE, 'stub-png-one');
const PNG2 = png(ORG_ICON_SIZE, ORG_ICON_SIZE, 'stub-png-two-longer');
const SRC_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const SRC_WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const SRC_GIF = Buffer.from('GIF89a-stub');
const SRC_SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

let tmp: string;
let hq: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-icon-'));
  hq = path.join(tmp, 'hq');
  fs.mkdirSync(path.join(hq, 'company'), { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const iconFile = () => path.join(hq, ORG_ICON_PATH);
const leftovers = () => fs.readdirSync(path.join(hq, 'company')).filter((n) => n.endsWith('.tmp'));

describe('writeOrgIcon and readOrgIcon', () => {
  it('writes the PNG, reads it back as a data URL and has a stamp', () => {
    expect(orgIconStamp(hq)).toBeNull();
    expect(readOrgIcon(hq)).toBeNull();
    expect(writeOrgIcon(hq, PNG)).toEqual({ ok: true });
    expect(fs.readFileSync(iconFile())).toEqual(PNG);
    expect(readOrgIcon(hq)).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(orgIconStamp(hq)).toMatch(/^\d+-\d+$/);
    expect(leftovers()).toEqual([]);
  });
  it('creates company/ when it is missing', () => {
    fs.rmSync(path.join(hq, 'company'), { recursive: true });
    expect(writeOrgIcon(hq, PNG)).toEqual({ ok: true });
    expect(readOrgIcon(hq)).not.toBeNull();
  });
  it('overwrites an existing icon and the stamp changes', () => {
    writeOrgIcon(hq, PNG);
    const before = orgIconStamp(hq);
    expect(writeOrgIcon(hq, PNG2)).toEqual({ ok: true });
    expect(fs.readFileSync(iconFile())).toEqual(PNG2);
    expect(orgIconStamp(hq)).not.toBe(before);
    expect(leftovers()).toEqual([]);
  });
  it('refuses what is not a PNG (JPEG, WebP, GIF, SVG, garbage, empty, a short signature) as unsupported', () => {
    for (const b of [SRC_JPEG, SRC_WEBP, SRC_GIF, SRC_SVG, Buffer.from('garbage'), Buffer.alloc(0), SIG.subarray(0, 4)]) expect(writeOrgIcon(hq, b)).toEqual({ ok: false, error: 'unsupported' });
    expect(fs.existsSync(iconFile())).toBe(false);
  });
  it('refuses a PNG with the wrong dimensions or no IHDR first', () => {
    for (const b of [png(255, 256), png(256, 255), png(1024, 1024), png(0, 0), png(0xffffffff, 0xffffffff), Buffer.concat([SIG, Buffer.from('not-a-header-chunk-at-all')])])
      expect(writeOrgIcon(hq, b)).toEqual({ ok: false, error: 'unsupported' });
    expect(fs.existsSync(iconFile())).toBe(false);
  });
  it('refuses a PNG over the stored-icon cap as tooLarge', () => {
    expect(writeOrgIcon(hq, Buffer.concat([PNG, Buffer.alloc(MAX_ORG_ICON_FILE)]))).toEqual({ ok: false, error: 'tooLarge' });
    expect(fs.existsSync(iconFile())).toBe(false);
  });
  it('pngSize reads the IHDR', () => {
    expect(pngSize(png(256, 128))).toEqual({ width: 256, height: 128 });
    expect(pngSize(Buffer.from('nope'))).toBeNull();
  });
  it('a company symlink: writeFailed, nothing written outside', () => {
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    fs.rmSync(path.join(hq, 'company'), { recursive: true });
    fs.symlinkSync(outside, path.join(hq, 'company'));
    expect(writeOrgIcon(hq, PNG)).toEqual({ ok: false, error: 'writeFailed' });
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(readOrgIcon(hq)).toBeNull();
  });
  it('company that is a file: writeFailed', () => {
    fs.rmSync(path.join(hq, 'company'), { recursive: true });
    fs.writeFileSync(path.join(hq, 'company'), 'x');
    expect(writeOrgIcon(hq, PNG)).toEqual({ ok: false, error: 'writeFailed' });
  });
  it('an icon.png symlink: writeFailed, the target is untouched', () => {
    const target = path.join(tmp, 'target.png');
    fs.writeFileSync(target, PNG2);
    fs.symlinkSync(target, iconFile());
    expect(writeOrgIcon(hq, PNG)).toEqual({ ok: false, error: 'writeFailed' });
    expect(fs.readFileSync(target)).toEqual(PNG2);
    expect(leftovers()).toEqual([]);
  });
  it('an unknown hq folder: writeFailed, never throws', () => {
    expect(writeOrgIcon(path.join(tmp, 'gone'), PNG)).toEqual({ ok: false, error: 'writeFailed' });
  });
});

describe('reading', () => {
  it('an icon.png symlink: read and stamp are null', () => {
    const target = path.join(tmp, 'target.png');
    fs.writeFileSync(target, PNG);
    fs.symlinkSync(target, iconFile());
    expect(readOrgIcon(hq)).toBeNull();
    expect(orgIconStamp(hq)).toBeNull();
  });
  it('a company symlink: read and stamp are null', () => {
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'icon.png'), PNG);
    fs.rmSync(path.join(hq, 'company'), { recursive: true });
    fs.symlinkSync(outside, path.join(hq, 'company'));
    expect(readOrgIcon(hq)).toBeNull();
    expect(orgIconStamp(hq)).toBeNull();
  });
  it('the hq folder itself may be a link', () => {
    fs.writeFileSync(iconFile(), PNG);
    const link = path.join(tmp, 'hq-link');
    fs.symlinkSync(hq, link);
    expect(readOrgIcon(link)).not.toBeNull();
    expect(orgIconStamp(link)).not.toBeNull();
  });
  it('bytes that are not a PNG: null', () => {
    fs.writeFileSync(iconFile(), SRC_JPEG);
    expect(readOrgIcon(hq)).toBeNull();
  });
  it('empty or oversize file: null', () => {
    fs.writeFileSync(iconFile(), '');
    expect(readOrgIcon(hq)).toBeNull();
    expect(orgIconStamp(hq)).toBeNull();
    fs.writeFileSync(iconFile(), Buffer.concat([PNG, Buffer.alloc(MAX_ORG_ICON_FILE)]));
    expect(readOrgIcon(hq)).toBeNull();
    expect(orgIconStamp(hq)).toBeNull();
  });
  it('a directory named icon.png: null', () => {
    fs.mkdirSync(iconFile());
    expect(readOrgIcon(hq)).toBeNull();
  });
  it('a bad path or a missing hq: null, never throws', () => {
    expect(readOrgIcon(path.join(tmp, 'gone'))).toBeNull();
    expect(orgIconStamp(undefined as unknown as string)).toBeNull();
  });
});

describe('reading: the window between the path checks and the open', () => {
  /** Runs `swap` right after the realpath check of icon.png, i.e. after every path check and before the open. */
  const swapAfterChecks = (swap: () => void) => {
    const real = fs.realpathSync;
    let done = false;
    vi.spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
      const r = (real as (p: fs.PathLike, o?: unknown) => string)(p, o);
      if (!done && String(p).endsWith('icon.png')) {
        done = true;
        swap();
      }
      return r;
    }) as typeof fs.realpathSync);
  };
  it('a link swapped in after the checks is not followed (O_NOFOLLOW): null', () => {
    fs.writeFileSync(iconFile(), PNG);
    const target = path.join(tmp, 'secret.png');
    fs.writeFileSync(target, PNG2);
    swapAfterChecks(() => {
      fs.rmSync(iconFile());
      fs.symlinkSync(target, iconFile());
    });
    expect(readOrgIcon(hq)).toBeNull();
  });
  it('a link swapped in after the checks gives no stamp either', () => {
    fs.writeFileSync(iconFile(), PNG);
    const target = path.join(tmp, 'secret.png');
    fs.writeFileSync(target, PNG2);
    swapAfterChecks(() => {
      fs.rmSync(iconFile());
      fs.symlinkSync(target, iconFile());
    });
    expect(orgIconStamp(hq)).toBeNull();
  });
  it('a FIFO swapped in after the checks does not hang or get read: null', () => {
    fs.writeFileSync(iconFile(), PNG);
    swapAfterChecks(() => {
      fs.rmSync(iconFile());
      execFileSync('mkfifo', [iconFile()]);
    });
    expect(readOrgIcon(hq)).toBeNull();
  });
  it('a file that grew past the cap after the checks is refused by the fstat of the open file', () => {
    fs.writeFileSync(iconFile(), PNG);
    swapAfterChecks(() => fs.writeFileSync(iconFile(), Buffer.concat([PNG, Buffer.alloc(MAX_ORG_ICON_FILE)])));
    expect(readOrgIcon(hq)).toBeNull();
  });
  it('a normal icon still reads, and no descriptor is left open', () => {
    fs.writeFileSync(iconFile(), PNG);
    const closed: number[] = [];
    const opened: number[] = [];
    const open = fs.openSync;
    const close = fs.closeSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((...a: Parameters<typeof fs.openSync>) => {
      const fd = open(...a);
      opened.push(fd);
      return fd;
    }) as typeof fs.openSync);
    vi.spyOn(fs, 'closeSync').mockImplementation((fd: number) => {
      closed.push(fd);
      close(fd);
    });
    expect(readOrgIcon(hq)).not.toBeNull();
    expect(orgIconStamp(hq)).not.toBeNull();
    expect(opened.length).toBe(2);
    expect(closed).toEqual(opened);
  });
});

describe('readOrgIconSource (the picked file)', () => {
  const put = (name: string, content: Buffer) => {
    const f = path.join(tmp, name);
    fs.writeFileSync(f, content);
    return f;
  };
  it('PNG, JPEG and WebP are returned as base64 with their type', () => {
    expect(readOrgIconSource(put('a.png', PNG))).toEqual({ ok: true, mediaType: 'image/png', data: PNG.toString('base64') });
    expect(readOrgIconSource(put('a.jpg', SRC_JPEG))).toEqual({ ok: true, mediaType: 'image/jpeg', data: SRC_JPEG.toString('base64') });
    expect(readOrgIconSource(put('a.webp', SRC_WEBP))).toEqual({ ok: true, mediaType: 'image/webp', data: SRC_WEBP.toString('base64') });
  });
  it('GIF, SVG, garbage and an empty file: unsupported (the extension does not matter)', () => {
    for (const b of [SRC_GIF, SRC_SVG, Buffer.from('garbage'), Buffer.alloc(0)]) expect(readOrgIconSource(put('x.png', b))).toEqual({ ok: false, error: 'unsupported' });
  });
  it('a FIFO is refused as notAFile without being read (nothing ever writes to it)', () => {
    const fifo = path.join(tmp, 'pipe.png');
    execFileSync('mkfifo', [fifo]);
    expect(readOrgIconSource(fifo)).toEqual({ ok: false, error: 'notAFile' });
  });
  it('a folder is notAFile', () => {
    const dir = path.join(tmp, 'folder.png');
    fs.mkdirSync(dir);
    expect(readOrgIconSource(dir)).toEqual({ ok: false, error: 'notAFile' });
  });
  it('a device is notAFile', () => {
    expect(readOrgIconSource('/dev/null')).toEqual({ ok: false, error: 'notAFile' });
  });
  it('a link to a regular image is followed (the user chose it); a link to a FIFO is refused', () => {
    const real = put('real.png', PNG);
    fs.symlinkSync(real, path.join(tmp, 'link.png'));
    expect(readOrgIconSource(path.join(tmp, 'link.png')).ok).toBe(true);
    const fifo = path.join(tmp, 'pipe2');
    execFileSync('mkfifo', [fifo]);
    fs.symlinkSync(fifo, path.join(tmp, 'linkfifo.png'));
    expect(readOrgIconSource(path.join(tmp, 'linkfifo.png'))).toEqual({ ok: false, error: 'notAFile' });
  });
  it('over the upload cap: tooLarge without reading', () => {
    const f = path.join(tmp, 'big.png');
    fs.closeSync(fs.openSync(f, 'w'));
    fs.truncateSync(f, MAX_ORG_ICON_UPLOAD + 1);
    expect(readOrgIconSource(f)).toEqual({ ok: false, error: 'tooLarge' });
  });
  it('a missing file: writeFailed, never throws', () => {
    expect(readOrgIconSource(path.join(tmp, 'gone.png'))).toEqual({ ok: false, error: 'writeFailed' });
  });
});

describe('removeOrgIcon', () => {
  it('deletes the file, then read and stamp are null', () => {
    writeOrgIcon(hq, PNG);
    expect(removeOrgIcon(hq)).toEqual({ ok: true });
    expect(fs.existsSync(iconFile())).toBe(false);
    expect(readOrgIcon(hq)).toBeNull();
    expect(orgIconStamp(hq)).toBeNull();
  });
  it('a missing file or company folder counts as ok', () => {
    expect(removeOrgIcon(hq)).toEqual({ ok: true });
    fs.rmSync(path.join(hq, 'company'), { recursive: true });
    expect(removeOrgIcon(hq)).toEqual({ ok: true });
  });
  it('a symlink: the link is not followed, its target stays', () => {
    const target = path.join(tmp, 'target.png');
    fs.writeFileSync(target, PNG);
    fs.symlinkSync(target, iconFile());
    expect(removeOrgIcon(hq)).toEqual({ ok: false });
    expect(fs.existsSync(target)).toBe(true);
  });
  it('a company symlink: the file behind it stays', () => {
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'icon.png'), PNG);
    fs.rmSync(path.join(hq, 'company'), { recursive: true });
    fs.symlinkSync(outside, path.join(hq, 'company'));
    expect(removeOrgIcon(hq)).toEqual({ ok: false });
    expect(fs.existsSync(path.join(outside, 'icon.png'))).toBe(true);
  });
});

describe('watcher', () => {
  it('classifies company/icon.png as an icon change', () => {
    expect(classify('company/icon.png')).toBe('icon');
    expect(classify('company/other.png')).toBeNull();
  });
});
