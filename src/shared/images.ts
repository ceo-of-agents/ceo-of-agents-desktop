// Images in the composer: what is accepted, the limits, and the pure checks shared by the renderer (which checks
// early, for the user) and the main process (which checks again, never trusting the renderer).
import { t } from './strings';
import type { ImageAttachment, ImageMediaType } from './types';

export const IMAGE_TYPES: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
/** At most this many images in one message. */
export const MAX_IMAGES = 5;
/** Largest image, in decoded bytes: 3.75 MB, so its base64 text stays under 5 MB (Claude's per-image limit). */
export const MAX_IMAGE_BYTES = 3.75 * 1024 * 1024;

/** Longest base64 text of an allowed image (no whitespace or line breaks are accepted): 4 characters per 3 bytes, rounded up. */
export const MAX_IMAGE_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

export function isImageType(type: unknown): type is ImageMediaType {
  return typeof type === 'string' && (IMAGE_TYPES as readonly string[]).includes(type);
}

/** The file extension an image of this type is stored under. */
export const IMAGE_EXT: Record<ImageMediaType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** True when the size is allowed: not empty, not over `MAX_IMAGE_BYTES`. */
export function isImageSizeOk(bytes: number): boolean {
  return Number.isFinite(bytes) && bytes > 0 && bytes <= MAX_IMAGE_BYTES;
}

const ascii = (b: Uint8Array, from: number, s: string): boolean => {
  if (b.length < from + s.length) return false;
  for (let i = 0; i < s.length; i++) if (b[from + i] !== s.charCodeAt(i)) return false;
  return true;
};

/** True when the first bytes of a file are those of the declared type (PNG, JPEG, GIF, WebP). */
export function hasImageMagic(bytes: Uint8Array, type: ImageMediaType): boolean {
  switch (type) {
    case 'image/png':
      return bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    case 'image/jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/gif':
      return ascii(bytes, 0, 'GIF8');
    case 'image/webp':
      return ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP');
  }
}

/** True for plain base64: only A-Z a-z 0-9 + /, then at most two `=` at the end. One pass, no regex. */
function isPlainBase64(data: string): boolean {
  const n = data.length;
  let end = n;
  while (end > 0 && n - end < 2 && data.charCodeAt(end - 1) === 61) end--;
  if (end === 0) return false;
  for (let i = 0; i < end; i++) {
    const c = data.charCodeAt(i);
    const ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47;
    if (!ok) return false;
  }
  return true;
}

/** The number of bytes a base64 string decodes to (0 when it is not valid base64). */
export function base64Bytes(data: string): number {
  if (data.length === 0 || data.length % 4 !== 0 || !isPlainBase64(data)) return 0;
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return (data.length / 4) * 3 - pad;
}

export type ImageProblem = 'count' | 'type' | 'format' | 'size';

/** The first bytes of a base64 string (16 characters are 12 bytes, enough for every magic number). */
function base64Head(data: string): Uint8Array {
  const bin = atob(data.slice(0, 16));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Checks what the renderer sent with a message: a list of at most `MAX_IMAGES` attachments, each of an accepted type,
 * valid base64 with no `data:` prefix, within the size cap, whose bytes start like the declared type.
 * Returns null when everything is fine, else the first problem.
 */
export function checkImages(images: unknown): ImageProblem | null {
  if (!Array.isArray(images)) return 'format';
  if (images.length > MAX_IMAGES) return 'count';
  for (const img of images as Array<Partial<ImageAttachment> | null>) {
    if (!img || typeof img !== 'object' || !isImageType(img.mediaType)) return 'type';
    if (typeof img.data !== 'string') return 'format';
    // The length first: an oversized string is refused before anything reads it.
    if (img.data.length > MAX_IMAGE_BASE64_LENGTH) return 'size';
    const size = base64Bytes(img.data);
    if (size === 0) return 'format';
    if (!isImageSizeOk(size)) return 'size';
    if (!hasImageMagic(base64Head(img.data), img.mediaType)) return 'format';
  }
  return null;
}

/** The sentence for a problem (en.json). */
export function imageProblemText(problem: ImageProblem): string {
  return t(`images.error.${problem}`, { max: MAX_IMAGES, mb: MAX_IMAGE_BYTES / (1024 * 1024) });
}
