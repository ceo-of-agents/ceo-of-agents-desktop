// Tiny valid-looking images for tests: only the leading bytes matter to the app's checks.
import { createHash } from 'node:crypto';
import type { ImageAttachment, ImageMediaType } from '../src/shared/types';

const HEADS: Record<ImageMediaType, number[]> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff, 0xe0],
  'image/gif': [...Buffer.from('GIF89a')],
  'image/webp': [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')],
};

/** Bytes of an image of this type, `extra` filler bytes after the header (varies the hash). */
export function imageBytes(type: ImageMediaType, extra = 8, fill = 1): Buffer {
  return Buffer.concat([Buffer.from(HEADS[type]), Buffer.alloc(extra, fill)]);
}

export function attachment(type: ImageMediaType = 'image/png', extra = 8, fill = 1): ImageAttachment {
  return { mediaType: type, data: imageBytes(type, extra, fill).toString('base64') };
}

export const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
