// Files other than images in the composer: reading them, telling them from images, and the drafts
// kept per chat while another tab is shown. The size and count rules are shared (src/shared/attachments.ts).
import { isImageType } from '../shared/images';
import type { FileAttachment } from '../shared/types';

/** A file waiting in the composer. */
export interface DraftFile {
  key: string;
  attachment: FileAttachment;
}

/** Splits dropped or picked files: the images the app sends as image blocks (PNG, JPEG, GIF, WebP) and everything else (any other image type included: it goes as a file). */
export function splitFiles<F extends { type: string }>(files: F[]): { images: F[]; others: F[] } {
  const images: F[] = [];
  const others: F[] = [];
  for (const f of files) (isImageType(f.type) ? images : others).push(f);
  return { images, others };
}

/** Reads a screened file; null when it cannot be read. */
export async function readAttachment(file: File): Promise<FileAttachment | null> {
  try {
    return { name: file.name, mediaType: file.type, data: new Uint8Array(await file.arrayBuffer()) };
  } catch {
    return null;
  }
}

export function draftBytes(list: DraftFile[]): number {
  return list.reduce((n, f) => n + f.attachment.data.byteLength, 0);
}

const kept = new Map<string, DraftFile[]>();

/** Files waiting in a chat's composer, kept while another tab is shown (like the images). Keyed by `orgId|threadId`. */
export const draftFiles = {
  get: (key: string): DraftFile[] => kept.get(key) ?? [],
  set: (key: string, list: DraftFile[]): void => {
    if (list.length === 0) kept.delete(key);
    else kept.set(key, list);
  },
  delete: (key: string): void => {
    kept.delete(key);
  },
  deleteOrg: (orgId: string): void => {
    const prefix = `${orgId}|`;
    for (const key of [...kept.keys()]) if (key.startsWith(prefix)) kept.delete(key);
  },
  size: (): number => kept.size,
};
