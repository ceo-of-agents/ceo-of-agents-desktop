// Files other than images in the composer: how a file is told apart, the size caps, the name
// cleaning and the text that tells the agent where the files are. Pure, shared by the renderer (which checks early)
// and the main process (which checks again, never trusting the renderer). Images keep their own rules (images.ts).
import { t } from './strings';
import type { AttachmentKind, FileAttachment, ThreadFileRef } from './types';

const MB = 1024 * 1024;

/** Largest file per kind, in bytes (images have their own cap, see images.ts). The PDF cap is Claude's own 32 MB limit for a PDF. */
export const MAX_FILE_BYTES: Record<AttachmentKind, number> = { pdf: 32 * MB, video: 100 * MB, audio: 50 * MB, other: 25 * MB };
/** At most this many files (not counting images) in one message. */
export const MAX_FILES = 10;
/** Most bytes of all the files of one message together. */
export const MAX_FILES_TOTAL_BYTES = 150 * MB;
/** Longest stored file name (characters, extension included). */
export const MAX_FILE_NAME = 100;

const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv', 'mpg', 'mpeg', 'wmv', 'flv', '3gp']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'aif', 'aiff']);

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** The kind of a file, from its declared type first, then its extension. */
export function fileKind(name: string, mediaType: string): AttachmentKind {
  const type = (mediaType || '').toLowerCase();
  const ext = extOf(name);
  if (type === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (type.startsWith('video/') || VIDEO_EXT.has(ext)) return 'video';
  if (type.startsWith('audio/') || AUDIO_EXT.has(ext)) return 'audio';
  return 'other';
}

/**
 * A safe file name for the store: the last path segment, no control, bidi or zero-width characters, no separators,
 * no leading dots, at most `MAX_FILE_NAME` characters (the extension is kept), never empty.
 */
export function cleanFileName(raw: unknown): string {
  let name = typeof raw === 'string' ? raw : '';
  name = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
  name = name.replace(/^\.+/, '').trim();
  if (name.length > MAX_FILE_NAME) {
    const ext = extOf(name);
    const keep = ext && ext.length <= 12 ? `.${ext}` : '';
    name = name.slice(0, MAX_FILE_NAME - keep.length).trimEnd() + keep;
  }
  return name || 'file';
}

export type FileProblem = { code: 'count' | 'size' | 'total' | 'format'; name?: string; kind?: AttachmentKind };

export interface FileCandidate {
  name: string;
  type: string;
  size: number;
}

/**
 * Which of the dropped or picked files to read, given how many files (and bytes) are already in the composer: not
 * empty, within the cap of their kind, no more than `MAX_FILES` and `MAX_FILES_TOTAL_BYTES` in all.
 * `problem` is the first reason a file was left out.
 */
export function screenFiles(haveCount: number, haveBytes: number, files: FileCandidate[]): { accepted: number[]; problem: FileProblem | null } {
  const accepted: number[] = [];
  let problem: FileProblem | null = null;
  let count = haveCount;
  let bytes = haveBytes;
  files.forEach((f, i) => {
    const kind = fileKind(f.name, f.type);
    let why: FileProblem | null = null;
    if (!Number.isFinite(f.size) || f.size <= 0) why = { code: 'format', name: cleanFileName(f.name) };
    else if (f.size > MAX_FILE_BYTES[kind]) why = { code: 'size', name: cleanFileName(f.name), kind };
    else if (count >= MAX_FILES) why = { code: 'count' };
    else if (bytes + f.size > MAX_FILES_TOTAL_BYTES) why = { code: 'total' };
    if (why) problem = problem ?? why;
    else {
      accepted.push(i);
      count++;
      bytes += f.size;
    }
  });
  return { accepted, problem };
}

/** Checks what the renderer sent: a list of files that all pass `screenFiles`' rules (the main process's check). Null when fine, else the first problem. */
export function checkFiles(files: unknown): FileProblem | null {
  if (!Array.isArray(files)) return { code: 'format' };
  if (files.length > MAX_FILES) return { code: 'count' };
  let total = 0;
  for (const f of files as Array<Partial<FileAttachment> | null>) {
    if (!f || typeof f !== 'object' || typeof f.name !== 'string' || typeof f.mediaType !== 'string' || !(f.data instanceof Uint8Array)) return { code: 'format' };
    const name = cleanFileName(f.name);
    const size = f.data.byteLength;
    if (size === 0) return { code: 'format', name };
    const kind = fileKind(name, f.mediaType);
    if (size > MAX_FILE_BYTES[kind]) return { code: 'size', name, kind };
    total += size;
    if (total > MAX_FILES_TOTAL_BYTES) return { code: 'total' };
  }
  return null;
}

/** The size as a short text: "812 KB", "3.4 MB". */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / MB) * 10) / 10} MB`;
}

/** The sentence for a problem (en.json). */
export function fileProblemText(p: FileProblem): string {
  return t(`files.error.${p.code}`, {
    name: p.name ?? '',
    mb: p.kind ? MAX_FILE_BYTES[p.kind] / MB : 0,
    max: MAX_FILES,
    total: MAX_FILES_TOTAL_BYTES / MB,
  });
}

/** A PDF goes inline (as a document block) only up to this size each, and this many bytes for all the inline PDFs of one message. */
export const MAX_INLINE_PDF_BYTES = 10 * MB;
export const MAX_INLINE_PDFS_TOTAL_BYTES = 20 * MB;
/** ...and only up to this many pages. */
export const MAX_INLINE_PDF_PAGES = 100;

/** True when the PDF is encrypted (an `/Encrypt` entry in its bytes): the agent could not read it inline. */
export function isEncryptedPdf(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1').includes('/Encrypt');
}

/**
 * The number of pages of a PDF, from its bytes: the page objects (`/Type /Page`, not `/Pages` or another name), else
 * the largest `/Count` value (page trees); null when neither is found. A heuristic: compressed object streams hide it.
 */
export function pdfPageCount(bytes: Uint8Array): number | null {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
  const pages = text.match(/\/Type\s*\/Page(?![A-Za-z0-9])/g)?.length ?? 0;
  if (pages > 0) return pages;
  let max = 0;
  for (const m of text.matchAll(/\/Count\s+(\d+)/g)) max = Math.max(max, Number(m[1]));
  return max > 0 ? max : null;
}

/**
 * Which of the files (by index) go inline as document blocks: PDFs of at most `MAX_INLINE_PDF_BYTES`, `MAX_INLINE_PDFS_TOTAL_BYTES`
 * together for the message (first come, first kept), not encrypted, with a page count that is known and at most `MAX_INLINE_PDF_PAGES`.
 */
export function inlinePdfIndexes(files: FileAttachment[]): Set<number> {
  const inline = new Set<number>();
  let total = 0;
  files.forEach((f, i) => {
    if (fileKind(f.name, f.mediaType) !== 'pdf') return;
    const size = f.data.byteLength;
    if (size === 0 || size > MAX_INLINE_PDF_BYTES || total + size > MAX_INLINE_PDFS_TOTAL_BYTES) return;
    if (isEncryptedPdf(f.data)) return;
    const pages = pdfPageCount(f.data);
    if (pages === null || pages > MAX_INLINE_PDF_PAGES) return;
    inline.add(i);
    total += size;
  });
  return inline;
}

export interface PlacedFile {
  ref: ThreadFileRef;
  /** The absolute path of the stored copy the agent opens. */
  path: string;
  /** True for a PDF that also goes with the message as a document block. */
  inline?: boolean;
}

/**
 * The text the agent gets after the user's own words: one line per file with its name, kind, size and absolute path.
 * A PDF sent inline (`inline`) is also attached to the message as a document, so its line says to read it there; any
 * other PDF line says to open it with Read on the whole file, without `pages` (page ranges need a PDF renderer that may
 * be missing). For a video the line says the model does not see it, so the agent reaches for a tool. Empty when there are no files.
 */
export function attachmentsNote(files: PlacedFile[]): string {
  if (files.length === 0) return '';
  const lines = files.map(({ ref, path, inline }) => {
    const tail = ref.kind === 'video' ? ', video: you cannot watch it directly, so use a tool (for example frame extraction) if one is available' : ref.kind === 'audio' ? ', audio: you cannot listen to it directly, so use a tool if one is available' : '';
    const after = ref.kind === 'pdf' ? (inline ? ' (also attached to this message as a document: read it there, no tool needed; the path is for tools that need the file)' : ' (open it with the Read tool on the whole file, without the pages parameter, because page ranges need a PDF renderer that may be missing; Read returns the whole document at once)') : '';
    return `- ${ref.name} (${ref.kind === 'other' ? 'file' : ref.kind}, ${sizeText(ref.size)}${tail}): ${path}${after}`;
  });
  return `[The user attached ${files.length === 1 ? 'a file' : `${files.length} files`}, saved on this computer. Open each with your tools; do not guess what it contains.]\n${lines.join('\n')}`;
}

/** The text of the message as Claude Code gets it: the user's words, then the note about the files (a blank line between, none when either is missing). */
export function messageWithFiles(text: string, files: PlacedFile[]): string {
  const note = attachmentsNote(files);
  if (!note) return text;
  return text ? `${text}\n\n${note}` : note;
}
