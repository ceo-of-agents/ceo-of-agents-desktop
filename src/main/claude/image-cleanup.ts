// Clean-up of the image store (see image-store.ts). An image is kept while a thread that can still be shown
// references it; the rest is deleted after a grace period. Only files named like the store names them are ever touched.
import fs from 'node:fs';
import path from 'node:path';
import { IMAGE_EXT } from '../../shared/images';
import { IMAGE_ID } from './image-store';

/** An image is kept this long after it was stored (or stored again) even when no log references it: its log entry may not exist yet. */
export const IMAGE_GRACE_MS = 10 * 60 * 1000;

const STORE_FILE = new RegExp(`^([0-9a-f]{64})\\.(${Object.values(IMAGE_EXT).join('|')})$`);
/** A temporary file of `ImageStore.put` (`<id>.<ext>.<pid>.tmp`), left behind when the app stopped mid-write. */
const TEMP_FILE = new RegExp(`^([0-9a-f]{64})\\.(${Object.values(IMAGE_EXT).join('|')})\\.[0-9]+\\.tmp$`);
/** An org id or tab id used as a path segment: letters, digits, dot, dash, underscore; never `.` or `..`. */
const SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/**
 * The thread logs that can still be shown: the chief of staff's log and the log of every department chat that is not
 * closed. `closedTabIds` are the chats known to be closed; a log of any other chat (even one tabs.json does not list)
 * counts, so that a damaged tabs.json can only keep images, never lose them.
 */
export async function visibleLogFiles(orgDataDir: string, closedTabIds: ReadonlySet<string>): Promise<string[]> {
  const files = [path.join(orgDataDir, 'cos.jsonl')];
  let names: string[] = [];
  try {
    names = await fs.promises.readdir(path.join(orgDataDir, 'tabs'));
  } catch {
    // no tabs folder: only the chief of staff's thread
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    if (closedTabIds.has(name.slice(0, -'.jsonl'.length))) continue;
    files.push(path.join(orgDataDir, 'tabs', name));
  }
  return files;
}

/** The image ids found in these thread logs (user entries carry `images: [{ id, mediaType }]`). A missing file or a bad line is skipped. */
export async function referencedImageIds(logFiles: readonly string[]): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const file of logFiles) {
    let raw: string;
    try {
      raw = await fs.promises.readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.includes('"images"')) continue;
      try {
        const entry = JSON.parse(line) as { images?: unknown };
        if (!entry || typeof entry !== 'object' || !Array.isArray(entry.images)) continue;
        for (const ref of entry.images as Array<{ id?: unknown } | null>) {
          if (ref && typeof ref.id === 'string' && IMAGE_ID.test(ref.id)) ids.add(ref.id);
        }
      } catch {
        // corrupt line
      }
    }
  }
  return ids;
}

/** The ids no visible thread references: a fixed set, or a function read after the folder is listed (so it sees entries added meanwhile). */
export type ReferencedSource = ReadonlySet<string> | (() => Promise<ReadonlySet<string>>);

export interface SweepOptions {
  /** Unreferenced images younger than this stay (ms, default `IMAGE_GRACE_MS`). */
  graceMs?: number;
  /** The current time in ms (tests). */
  now?: number;
  /** True when this process stored (or stored again) the image a moment ago: it is skipped (see `ImageStore.usedWithin`). */
  isInUse?: (id: string) => boolean;
  /** Called at the two points where the process can do other work: after the folder is listed, and after the references were read (tests). */
  onStage?: (stage: 'listed' | 'checked') => void | Promise<void>;
}

/**
 * Deletes the image files in `orgImagesDir` that are not referenced and are older than the grace period, and the
 * store's own temporary files (`<id>.<ext>.<pid>.tmp`) older than the grace period. Touches only regular files named
 * like that: symlinks, folders and any other name are left alone.
 * Returns the number of files deleted. A missing folder is not an error.
 *
 * The race with `ImageStore.put` (which refreshes or re-creates a file, after which the send appends a log entry that
 * references it, all in one synchronous step on the main thread): the references are read after the folder is
 * listed, and the delete phase has no `await`, so a `put` cannot happen between the last checks of a file (still
 * unreferenced, still a regular file older than the grace period, not just stored by this process) and its `unlink`.
 */
export async function sweepImages(orgImagesDir: string, referenced: ReferencedSource, opts: SweepOptions = {}): Promise<number> {
  const graceMs = opts.graceMs ?? IMAGE_GRACE_MS;
  const now = opts.now ?? Date.now();
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(orgImagesDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw e;
  }
  const candidates: Array<{ name: string; id: string; temp: boolean }> = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue; // false for a symlink
    const m = STORE_FILE.exec(entry.name);
    if (m) candidates.push({ name: entry.name, id: m[1], temp: false });
    else if (TEMP_FILE.test(entry.name)) candidates.push({ name: entry.name, id: '', temp: true });
  }
  if (candidates.length === 0) return 0;
  await opts.onStage?.('listed');
  const refs = typeof referenced === 'function' ? await referenced() : referenced;
  await opts.onStage?.('checked');
  // No await from here on.
  let deleted = 0;
  for (const { name, id, temp } of candidates) {
    // A temporary file is never referenced: only its age counts (a write in progress is younger than the grace period).
    if (!temp && (refs.has(id) || opts.isInUse?.(id))) continue;
    const file = path.join(orgImagesDir, name);
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || now - st.mtimeMs < graceMs) continue;
      fs.unlinkSync(file);
      deleted++;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error('could not delete a stored image', e);
    }
  }
  return deleted;
}

/**
 * Deletes all stored images of an org (call when the org is removed from the app). The org id must be a safe path segment.
 * Not called yet: the app has no way to remove an org. Wire it into that flow when it exists.
 */
export async function removeOrgImages(dataDir: string, orgId: string): Promise<void> {
  if (typeof orgId !== 'string' || !SAFE_SEGMENT.test(orgId)) throw new Error('Unsafe org id.');
  // rm removes a symlink itself, never what it points to.
  await fs.promises.rm(path.join(dataDir, 'orgs', orgId, 'images'), { recursive: true, force: true });
}
