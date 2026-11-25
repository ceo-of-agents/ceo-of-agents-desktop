// Clean-up of the file store (see file-store.ts), the same rules as the image store's (image-cleanup.ts): a file is
// kept while a thread that can still be shown references it; the rest goes after a grace period. Only folders named
// like the store names them are ever touched.
import fs from 'node:fs';
import path from 'node:path';
import { FILE_ID } from './file-store';
import { IMAGE_GRACE_MS, type ReferencedSource } from './image-cleanup';

const SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** The file ids found in these thread logs (user entries carry `files: [{ id, name, size, kind }]`). A missing file or a bad line is skipped. */
export async function referencedFileIds(logFiles: readonly string[]): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const file of logFiles) {
    let raw: string;
    try {
      raw = await fs.promises.readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.includes('"files"')) continue;
      try {
        const entry = JSON.parse(line) as { files?: unknown };
        if (!entry || typeof entry !== 'object' || !Array.isArray(entry.files)) continue;
        for (const ref of entry.files as Array<{ id?: unknown } | null>) {
          if (ref && typeof ref.id === 'string' && FILE_ID.test(ref.id)) ids.add(ref.id);
        }
      } catch {
        // corrupt line
      }
    }
  }
  return ids;
}

export interface FileSweepOptions {
  graceMs?: number;
  now?: number;
  /** True when this process stored (or stored again) the file a moment ago: it is skipped (see `FileStore.usedWithin`). */
  isInUse?: (id: string) => boolean;
  onStage?: (stage: 'listed' | 'checked') => void | Promise<void>;
}

/**
 * Deletes the folders of `filesDir` (named by a file id) whose file no visible thread references and that are older
 * than the grace period (the newest time of anything inside, so a leftover temporary file of an interrupted write goes
 * with its folder). Touches only real folders with an id as name: links, files and other names are left alone.
 * Returns the number of folders deleted. A missing folder is not an error. The delete phase has no `await`, like the images'.
 */
export async function sweepFiles(filesDir: string, referenced: ReferencedSource, opts: FileSweepOptions = {}): Promise<number> {
  const graceMs = opts.graceMs ?? IMAGE_GRACE_MS;
  const now = opts.now ?? Date.now();
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(filesDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw e;
  }
  const candidates = entries.filter((e) => e.isDirectory() && FILE_ID.test(e.name)).map((e) => e.name);
  if (candidates.length === 0) return 0;
  await opts.onStage?.('listed');
  const refs = typeof referenced === 'function' ? await referenced() : referenced;
  await opts.onStage?.('checked');
  // No await from here on.
  let deleted = 0;
  for (const id of candidates) {
    if (refs.has(id) || opts.isInUse?.(id)) continue;
    const folder = path.join(filesDir, id);
    try {
      const st = fs.lstatSync(folder);
      if (!st.isDirectory()) continue;
      let newest = st.mtimeMs;
      for (const name of fs.readdirSync(folder)) {
        const inner = fs.lstatSync(path.join(folder, name));
        newest = Math.max(newest, inner.mtimeMs);
      }
      if (now - newest < graceMs) continue;
      fs.rmSync(folder, { recursive: true, force: true });
      deleted++;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error('could not delete a stored file', e);
    }
  }
  return deleted;
}

/** Deletes all stored files of an org (call when the org is removed from the app; the app has no such action yet). The org id must be a safe path segment. */
export async function removeOrgFiles(dataDir: string, orgId: string): Promise<void> {
  if (typeof orgId !== 'string' || !SAFE_SEGMENT.test(orgId)) throw new Error('Unsafe org id.');
  await fs.promises.rm(path.join(dataDir, 'orgs', orgId, 'files'), { recursive: true, force: true });
}
