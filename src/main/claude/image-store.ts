// Images sent with messages, kept once in <dataDir>/orgs/<orgId>/images/<sha256>.<ext> (content-addressed, written
// atomically). The thread log holds only the id (the hash) and the type, never the bytes.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { IMAGE_EXT, IMAGE_TYPES, hasImageMagic } from '../../shared/images';
import type { ImageAttachment, ThreadImageRef } from '../../shared/types';

/** An image id: the sha256 of the file's bytes, 64 lowercase hex characters. Nothing else reaches the file system. */
export const IMAGE_ID = /^[0-9a-f]{64}$/;

/** How long `usedWithin` remembers an id (ms); older entries are dropped. Longer than any clean-up grace period in use. */
const RECENT_KEEP_MS = 60 * 60 * 1000;

export class ImageStore {
  /** The ids this process stored (or stored again) and when (ms): the clean-up skips them even if the file's time could not be refreshed. */
  private readonly recent = new Map<string, number>();

  constructor(private readonly dir: string) {}

  /**
   * Stores an image (already validated) and returns its reference. An image that is already there is not written
   * again, but its time is refreshed: the clean-up's grace period counts from here (see image-cleanup.ts). If the
   * file is gone (the clean-up just deleted it), it is written again.
   */
  put(img: ImageAttachment): ThreadImageRef {
    const bytes = Buffer.from(img.data, 'base64');
    const id = createHash('sha256').update(bytes).digest('hex');
    const file = path.join(this.dir, `${id}.${IMAGE_EXT[img.mediaType]}`);
    const nowMs = Date.now();
    this.markUsed(id, nowMs);
    try {
      const now = new Date(nowMs);
      fs.utimesSync(file, now, now);
    } catch (e) {
      // Missing: write it. Any other failure: the file is there, only its time is not refreshed (`usedWithin` covers it).
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        fs.mkdirSync(this.dir, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, bytes);
        fs.renameSync(tmp, file);
      }
    }
    return { id, mediaType: img.mediaType };
  }

  /** True when this process stored the image less than `withinMs` before `now`. */
  usedWithin(id: string, withinMs: number, now: number = Date.now()): boolean {
    const at = this.recent.get(id);
    return at !== undefined && now - at < withinMs;
  }

  private markUsed(id: string, now: number): void {
    for (const [other, at] of this.recent) if (now - at >= RECENT_KEEP_MS) this.recent.delete(other);
    this.recent.set(id, now);
  }

  /** The image as a `data:` URL, or null when the id is not 64 hex characters, the file is missing or unreadable or its bytes do not match its type. Never throws. */
  get(id: unknown): string | null {
    if (typeof id !== 'string' || !IMAGE_ID.test(id)) return null;
    for (const type of IMAGE_TYPES) {
      try {
        const bytes = fs.readFileSync(path.join(this.dir, `${id}.${IMAGE_EXT[type]}`));
        if (!hasImageMagic(bytes, type)) return null;
        return `data:${type};base64,${bytes.toString('base64')}`;
      } catch {
        // not stored under this extension
      }
    }
    return null;
  }
}
