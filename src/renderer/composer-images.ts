// Images in the composer: screening a paste or drop, reading files, and the drafts kept while the user switches chats.
// The checks are those of src/shared/images.ts, which the main process runs again before anything is sent.
import { MAX_IMAGES, checkImages, isImageSizeOk, isImageType, type ImageProblem } from '../shared/images';
import type { ImageAttachment } from '../shared/types';
import type { ReplyTarget } from './thread-logic';

/** An image waiting in the composer. */
export interface DraftImage {
  key: string;
  attachment: ImageAttachment;
}

export interface Candidate {
  type: string;
  size: number;
}

/**
 * Which of the files to read, given how many images are already in the composer: those of an accepted type, not empty,
 * within the size cap, and no more than `MAX_IMAGES` in all. `problem` is the first reason a file was left out.
 */
export function screenCandidates(have: number, files: Candidate[]): { accepted: number[]; problem: ImageProblem | null } {
  const accepted: number[] = [];
  let problem: ImageProblem | null = null;
  files.forEach((f, i) => {
    let why: ImageProblem | null = null;
    if (!isImageType(f.type)) why = 'type';
    else if (f.size === 0) why = 'format';
    else if (!isImageSizeOk(f.size)) why = 'size';
    else if (have + accepted.length >= MAX_IMAGES) why = 'count';
    if (why) problem = problem ?? why;
    else accepted.push(i);
  });
  return { accepted, problem };
}

/** The base64 part of a `data:<type>;base64,<data>` URL, or null. */
export function splitDataUrl(url: string): string | null {
  const m = /^data:[^,;]*;base64,([\s\S]*)$/.exec(url);
  return m ? m[1] : null;
}

interface ClipboardItemLike<F> {
  kind: string;
  type: string;
  getAsFile(): F | null;
}

/**
 * The image files of a paste, or [] when the clipboard also holds plain text (copying from a document or a page puts a
 * preview image next to the text: the text is what the user meant).
 */
export function imageFilesFromPaste<F>(items: ArrayLike<ClipboardItemLike<F>>): F[] {
  const list = Array.from(items);
  if (list.some((it) => it.kind === 'string' && it.type === 'text/plain')) return [];
  const out: F[] = [];
  for (const it of list) {
    if (it.kind !== 'file' || !it.type.startsWith('image/')) continue;
    const f = it.getAsFile();
    if (f) out.push(f);
  }
  return out;
}

/** True when a drag carries files (so the composer lights up for it). */
export function dragHasFiles(types: ArrayLike<string> | null | undefined): boolean {
  return !!types && Array.from(types).includes('Files');
}

/** Reads a screened file; 'format' when it cannot be read or its bytes are not those of its declared type. */
export function readImageFile(file: File): Promise<ImageAttachment | ImageProblem> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve('format');
    reader.onload = () => {
      const data = typeof reader.result === 'string' ? splitDataUrl(reader.result) : null;
      if (!data || !isImageType(file.type)) return resolve('format');
      const attachment: ImageAttachment = { mediaType: file.type, data };
      resolve(checkImages([attachment]) ?? attachment);
    };
    reader.readAsDataURL(file);
  });
}

/** The text of a rejected IPC call: Electron wraps the main process error ("Error invoking remote method 'send': Error: ..."). */
export function ipcErrorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split('Error: ').pop() ?? msg;
}

/** What the composer holds: the typed text, the images and the reply chip (CoS chat only). */
export interface ComposerContent {
  text: string;
  images: DraftImage[];
  reply: ReplyTarget | null;
}

/**
 * What to put back in the composer when the main process refused a send, given what was sent and what the composer holds now.
 * Rule: each part (text, images, reply chip) comes back only if that part is empty now, so what the user typed or attached after
 * pressing send is never overwritten. The text counts as empty when it is only whitespace. A part that is not restored is returned as it is.
 */
export function restoreAfterRejectedSend(sent: ComposerContent, now: ComposerContent): ComposerContent {
  return {
    text: now.text.trim() === '' ? sent.text : now.text,
    images: now.images.length === 0 ? sent.images : now.images,
    reply: now.reply === null ? sent.reply : now.reply,
  };
}

const kept = new Map<string, DraftImage[]>();

/** Images waiting in a chat's composer, kept while another tab is shown (like the text draft). Keyed by `orgId|threadId`. */
export const draftImages = {
  get: (key: string): DraftImage[] => kept.get(key) ?? [],
  set: (key: string, list: DraftImage[]): void => {
    if (list.length === 0) kept.delete(key);
    else kept.set(key, list);
  },
  /** Frees a chat's images (the chat ended). */
  delete: (key: string): void => {
    kept.delete(key);
  },
  /** Frees every chat's images of an org (keys start with `orgId|`). */
  deleteOrg: (orgId: string): void => {
    const prefix = `${orgId}|`;
    for (const key of [...kept.keys()]) if (key.startsWith(prefix)) kept.delete(key);
  },
  /** How many chats hold images (tests). */
  size: (): number => kept.size,
};
