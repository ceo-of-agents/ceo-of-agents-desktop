// Files sent with messages, kept once in <dataDir>/orgs/<orgId>/files/<id>/<name>, where the id is
// the sha256 of the name and the bytes (the same file under two names is two entries). The agent opens the copy by its
// absolute path. The thread log holds only the id, the name, the size and the kind, never the bytes.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cleanFileName, fileKind } from '../../shared/attachments';
import type { FileAttachment, ThreadFileRef } from '../../shared/types';

/** A file id: 64 lowercase hex characters. Nothing else reaches the file system. */
export const FILE_ID = /^[0-9a-f]{64}$/;

/** How long `usedWithin` remembers an id (ms); older entries are dropped. Longer than any clean-up grace period in use. */
const RECENT_KEEP_MS = 60 * 60 * 1000;

export class FileStore {
  /** The ids this process stored (or stored again) and when (ms): the clean-up skips them even if the time of the file could not be refreshed. */
  private readonly recent = new Map<string, number>();

  constructor(readonly dir: string) {}

  /**
   * Stores a file (already validated) and returns its reference and the path of the copy. A file that is already
   * there is not written again, but its time is refreshed (the clean-up's grace period counts from here); if it is gone it is written again.
   */
  put(file: FileAttachment): { ref: ThreadFileRef; path: string } {
    const name = cleanFileName(file.name);
    const bytes = Buffer.from(file.data.buffer, file.data.byteOffset, file.data.byteLength);
    const id = createHash('sha256').update(name).update('\0').update(bytes).digest('hex');
    const folder = path.join(this.dir, id);
    const target = path.join(folder, name);
    const nowMs = Date.now();
    this.markUsed(id, nowMs);
    try {
      const now = new Date(nowMs);
      fs.utimesSync(target, now, now);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        fs.mkdirSync(folder, { recursive: true });
        const tmp = path.join(folder, `.${process.pid}.tmp`);
        fs.writeFileSync(tmp, bytes);
        fs.renameSync(tmp, target);
      }
    }
    return { ref: { id, name, size: bytes.byteLength, kind: fileKind(name, file.mediaType) }, path: target };
  }

  /** The path a stored file has (or would have): null when the id or the name is not what the store makes. */
  pathOf(ref: Pick<ThreadFileRef, 'id' | 'name'>): string | null {
    if (typeof ref.id !== 'string' || !FILE_ID.test(ref.id) || typeof ref.name !== 'string' || cleanFileName(ref.name) !== ref.name) return null;
    return path.join(this.dir, ref.id, ref.name);
  }

  /** True when this process stored the file less than `withinMs` before `now`. */
  usedWithin(id: string, withinMs: number, now: number = Date.now()): boolean {
    const at = this.recent.get(id);
    return at !== undefined && now - at < withinMs;
  }

  private markUsed(id: string, now: number): void {
    for (const [other, at] of this.recent) if (now - at >= RECENT_KEEP_MS) this.recent.delete(other);
    this.recent.set(id, now);
  }
}
