// The org's icon: `company/icon.png` in the hq folder (a fixed path, no org.yaml key). It travels with git, but the
// app never commits or pushes it: it only writes and deletes the file in the working tree. Nothing is kept in userData.
import fs from 'node:fs';
import path from 'node:path';
import { hasImageMagic } from '../../shared/images';
import type { ImageMediaType, OrgIconPick, OrgIconResult } from '../../shared/types';

export const ORG_ICON_PATH = 'company/icon.png';
/** The stored icon is a square PNG of this many pixels (crisp at 40 px on a retina screen). */
export const ORG_ICON_SIZE = 256;
/** Largest stored icon the app reads back. */
export const MAX_ORG_ICON_FILE = 1024 * 1024;
/** Largest source file the user may pick. */
export const MAX_ORG_ICON_UPLOAD = 10 * 1024 * 1024;
/** Source formats the renderer decodes (Electron's nativeImage cannot decode WebP on macOS; Chromium can). */
export const ORG_ICON_SOURCE_TYPES: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp'];

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** True when the bytes start with the full 8-byte PNG signature. */
function hasPngSignature(b: Uint8Array): boolean {
  return b.length >= 8 && PNG_SIGNATURE.every((v, i) => b[i] === v);
}

/** The width and height in the PNG's IHDR chunk (always the first chunk), or null when the header is not one. */
export function pngSize(b: Uint8Array): { width: number; height: number } | null {
  if (!hasPngSignature(b) || b.length < 24) return null;
  const type = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (type !== 'IHDR') return null;
  const u32 = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  return { width: u32(16), height: u32(20) };
}

interface IconFile {
  file: string;
  stat: fs.Stats;
}

/** The icon file, opened read-only and non-blocking without following a link at the last step, with its fstat; the caller closes `fd`. Null on any problem. Never throws. */
function openIcon(hqPath: string): (IconFile & { fd: number }) | null {
  let fd = -1;
  try {
    if (typeof hqPath !== 'string' || !hqPath) return null;
    const realHq = fs.realpathSync(hqPath);
    const dir = path.join(realHq, 'company');
    const file = path.join(dir, 'icon.png');
    if (!fs.lstatSync(dir).isDirectory()) return null; // lstat: a link is not a directory
    if (!fs.lstatSync(file).isFile()) return null;
    if (!fs.realpathSync(file).startsWith(realHq + path.sep)) return null;
    // O_NOFOLLOW: a link swapped in after the checks above fails the open. O_NONBLOCK: a FIFO swapped in cannot hang it.
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    // fstat of the open descriptor is what is read, whatever the path points to now.
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ORG_ICON_FILE) {
      fs.closeSync(fd);
      return null;
    }
    return { file, stat, fd };
  } catch {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
    return null;
  }
}

/** `<mtimeMs>-<size>` of a usable icon file, else null. The renderer refetches the icon when it changes. */
export function orgIconStamp(hqPath: string): string | null {
  const f = openIcon(hqPath);
  if (!f) return null;
  fs.closeSync(f.fd);
  return `${Math.round(f.stat.mtimeMs)}-${f.stat.size}`;
}

/** The icon as a `data:image/png;base64,` URL, or null when there is none or it is not a usable PNG. */
export function readOrgIcon(hqPath: string): string | null {
  const f = openIcon(hqPath);
  if (!f) return null;
  try {
    const bytes = Buffer.alloc(f.stat.size);
    let got = 0;
    while (got < bytes.length) {
      const n = fs.readSync(f.fd, bytes, got, bytes.length - got, got);
      if (n <= 0) break;
      got += n;
    }
    if (got !== bytes.length || !hasPngSignature(bytes)) return null;
    return `data:image/png;base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(f.fd);
    } catch {
      // already closed
    }
  }
}

/**
 * Writes the icon from the PNG the renderer made (it decodes and resizes the picked image). The bytes are not trusted:
 * full PNG signature, at most MAX_ORG_ICON_FILE, and an IHDR of exactly ORG_ICON_SIZE x ORG_ICON_SIZE; nothing else is written.
 */
export function writeOrgIcon(hqPath: string, png: Buffer): OrgIconResult {
  try {
    if (!Buffer.isBuffer(png) || png.length === 0) return { ok: false, error: 'unsupported' };
    if (png.length > MAX_ORG_ICON_FILE) return { ok: false, error: 'tooLarge' };
    const size = pngSize(png);
    if (!size || size.width !== ORG_ICON_SIZE || size.height !== ORG_ICON_SIZE) return { ok: false, error: 'unsupported' };

    const realHq = fs.realpathSync(hqPath);
    const dir = path.join(realHq, 'company');
    let dirStat: fs.Stats | null = null;
    try {
      dirStat = fs.lstatSync(dir);
    } catch {
      dirStat = null;
    }
    if (dirStat) {
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return { ok: false, error: 'writeFailed' };
    } else {
      fs.mkdirSync(dir);
    }
    const file = path.join(dir, 'icon.png');
    try {
      if (fs.lstatSync(file).isSymbolicLink()) return { ok: false, error: 'writeFailed' };
    } catch {
      // no icon yet
    }
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, png);
      fs.renameSync(tmp, file);
    } catch {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // nothing to clean
      }
      return { ok: false, error: 'writeFailed' };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'writeFailed' };
  }
}

/** Deletes the icon file when it is a regular file (never a link's target). A missing file counts as done. */
export function removeOrgIcon(hqPath: string): { ok: boolean } {
  try {
    const realHq = fs.realpathSync(hqPath);
    const dir = path.join(realHq, 'company');
    const file = path.join(dir, 'icon.png');
    let dirStat: fs.Stats;
    try {
      dirStat = fs.lstatSync(dir);
    } catch {
      return { ok: true };
    }
    if (!dirStat.isDirectory()) return { ok: false };
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(file);
    } catch {
      return { ok: true };
    }
    if (!stat.isFile()) return { ok: false };
    fs.unlinkSync(file);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * Reads a file the user picked as the source of an icon, for the renderer to decode. It must be a regular file: the open is
 * non-blocking (a FIFO cannot hang it) and the check is an fstat of the open descriptor, so a FIFO, a device or a folder is
 * refused ("notAFile") without being read. The size cap is checked before reading, the type by its first bytes.
 */
export function readOrgIconSource(file: string): OrgIconPick {
  let fd = -1;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { ok: false, error: 'notAFile' };
    if (stat.size > MAX_ORG_ICON_UPLOAD) return { ok: false, error: 'tooLarge' };
    if (stat.size === 0) return { ok: false, error: 'unsupported' };
    const bytes = Buffer.alloc(stat.size);
    let got = 0;
    while (got < bytes.length) {
      const n = fs.readSync(fd, bytes, got, bytes.length - got, got);
      if (n <= 0) break;
      got += n;
    }
    const data = bytes.subarray(0, got);
    const mediaType = ORG_ICON_SOURCE_TYPES.find((t) => hasImageMagic(data, t));
    if (!mediaType) return { ok: false, error: 'unsupported' };
    return { ok: true, mediaType, data: data.toString('base64') };
  } catch {
    return { ok: false, error: 'writeFailed' };
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}
