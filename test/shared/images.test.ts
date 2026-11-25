import { describe, expect, it } from 'vitest';
import { IMAGE_TYPES, MAX_IMAGES, MAX_IMAGE_BASE64_LENGTH, MAX_IMAGE_BYTES, base64Bytes, checkImages, hasImageMagic, imageProblemText, isImageSizeOk, isImageType } from '../../src/shared/images';
import { attachment, imageBytes } from '../helpers-images';

describe('limits', () => {
  it('accepts four types, 5 images, 3.75 MB each (base64 stays under 5 MB)', () => {
    expect([...IMAGE_TYPES]).toEqual(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
    expect(MAX_IMAGES).toBe(5);
    expect(MAX_IMAGE_BYTES).toBe(3.75 * 1024 * 1024);
    expect(Math.ceil(MAX_IMAGE_BYTES / 3) * 4).toBeLessThanOrEqual(5 * 1024 * 1024);
  });
});

describe('isImageType', () => {
  it('only the four types', () => {
    for (const t of IMAGE_TYPES) expect(isImageType(t)).toBe(true);
    for (const t of ['image/bmp', 'image/svg+xml', 'image/tiff', 'text/plain', '', 'IMAGE/PNG', null, 3, undefined]) expect(isImageType(t)).toBe(false);
  });
});

describe('isImageSizeOk', () => {
  it('rejects empty and over the cap, accepts the cap itself', () => {
    expect(isImageSizeOk(0)).toBe(false);
    expect(isImageSizeOk(-1)).toBe(false);
    expect(isImageSizeOk(NaN)).toBe(false);
    expect(isImageSizeOk(1)).toBe(true);
    expect(isImageSizeOk(MAX_IMAGE_BYTES)).toBe(true);
    expect(isImageSizeOk(MAX_IMAGE_BYTES + 1)).toBe(false);
  });
});

describe('hasImageMagic', () => {
  it('matches the bytes of each type', () => {
    for (const t of IMAGE_TYPES) expect(hasImageMagic(imageBytes(t), t)).toBe(true);
  });
  it('rejects bytes of another type', () => {
    for (const a of IMAGE_TYPES) for (const b of IMAGE_TYPES) if (a !== b) expect(hasImageMagic(imageBytes(a), b)).toBe(false);
  });
  it('rejects short, empty and text bytes; WebP needs RIFF and WEBP', () => {
    expect(hasImageMagic(new Uint8Array(), 'image/png')).toBe(false);
    expect(hasImageMagic(Buffer.from('hello world'), 'image/gif')).toBe(false);
    expect(hasImageMagic(Buffer.from('RIFF....WAVE'), 'image/webp')).toBe(false);
    expect(hasImageMagic(Buffer.from('RIFF'), 'image/webp')).toBe(false);
    expect(hasImageMagic(Buffer.from([0xff, 0xd8]), 'image/jpeg')).toBe(false);
  });
});

describe('base64Bytes', () => {
  it('counts decoded bytes, 0 for invalid text', () => {
    expect(base64Bytes(Buffer.alloc(10).toString('base64'))).toBe(10);
    expect(base64Bytes(Buffer.alloc(11).toString('base64'))).toBe(11);
    expect(base64Bytes(Buffer.alloc(12).toString('base64'))).toBe(12);
    expect(base64Bytes('')).toBe(0);
    expect(base64Bytes('abc')).toBe(0);
    expect(base64Bytes('data:image/png;base64,AAAA')).toBe(0);
    expect(base64Bytes('AA A')).toBe(0);
  });
});

describe('checkImages', () => {
  it('accepts up to 5 valid images', () => {
    expect(checkImages([])).toBeNull();
    expect(checkImages([attachment('image/png'), attachment('image/jpeg'), attachment('image/gif'), attachment('image/webp'), attachment('image/png', 20)])).toBeNull();
  });
  it('rejects more than 5', () => {
    expect(checkImages(Array.from({ length: 6 }, () => attachment()))).toBe('count');
  });
  it('rejects a type that is not accepted, or not a string', () => {
    expect(checkImages([{ ...attachment(), mediaType: 'image/bmp' }])).toBe('type');
    expect(checkImages([{ data: attachment().data }])).toBe('type');
    expect(checkImages([null])).toBe('type');
    expect(checkImages(['image/png'])).toBe('type');
  });
  it('rejects bytes that do not match the declared type', () => {
    expect(checkImages([{ mediaType: 'image/jpeg', data: attachment('image/png').data }])).toBe('format');
    expect(checkImages([{ mediaType: 'image/png', data: Buffer.from('<svg></svg> not an image').toString('base64') }])).toBe('format');
  });
  it('rejects a data: prefix, non-base64 and a non-string', () => {
    expect(checkImages([{ mediaType: 'image/png', data: `data:image/png;base64,${attachment().data}` }])).toBe('format');
    expect(checkImages([{ mediaType: 'image/png', data: '!!!!' }])).toBe('format');
    expect(checkImages([{ mediaType: 'image/png', data: 42 }])).toBe('format');
    expect(checkImages('nope')).toBe('format');
  });
  it('rejects an image over the size cap, accepts one at the cap', () => {
    expect(checkImages([attachment('image/png', MAX_IMAGE_BYTES - 8)])).toBeNull();
    expect(checkImages([attachment('image/png', MAX_IMAGE_BYTES - 7)])).toBe('size');
  });
  it('refuses a 50 MB string as size, fast, before any decoding', () => {
    const huge = 'A'.repeat(50 * 1024 * 1024);
    const t0 = performance.now();
    expect(checkImages([{ mediaType: 'image/png', data: huge }])).toBe('size');
    expect(performance.now() - t0).toBeLessThan(50);
    // Even text that is not base64 is a size problem first when it is that long.
    expect(checkImages([{ mediaType: 'image/png', data: '!'.repeat(MAX_IMAGE_BASE64_LENGTH + 1) }])).toBe('size');
  });
  it('the base64 length cap is the one of the byte cap; the boundary length passes and one more fails', () => {
    expect(MAX_IMAGE_BASE64_LENGTH).toBe(Math.ceil(MAX_IMAGE_BYTES / 3) * 4);
    const at = attachment('image/png', MAX_IMAGE_BYTES - 8);
    expect(at.data.length).toBe(MAX_IMAGE_BASE64_LENGTH);
    expect(checkImages([at])).toBeNull();
    expect(checkImages([{ ...at, data: `${at.data}AAAA` }])).toBe('size');
    expect(checkImages([{ ...at, data: `${at.data}A` }])).toBe('size');
  });
  it('rejects whitespace, misplaced padding and other characters as format, without a regex', () => {
    const ok = attachment().data;
    for (const bad of [`${ok.slice(0, 4)} ${ok.slice(4)}`, `${ok}\n`, 'AA=A', 'A===', '====', 'AAA*', 'ÄÄÄÄ']) {
      expect(checkImages([{ mediaType: 'image/png', data: bad }])).toBe('format');
    }
  });
  it('a long run of valid characters followed by a bad one is checked in linear time', () => {
    const data = `${'A'.repeat(MAX_IMAGE_BASE64_LENGTH - 4)}AA!A`;
    const t0 = performance.now();
    expect(checkImages([{ mediaType: 'image/png', data }])).toBe('format');
    expect(performance.now() - t0).toBeLessThan(200);
  });
  it('has a sentence for every problem', () => {
    expect(imageProblemText('count')).toBe('At most 5 images in one message.');
    expect(imageProblemText('size')).toBe('This image is over 3.75 MB.');
    expect(imageProblemText('type')).toMatch(/PNG, JPEG, GIF and WebP/);
    expect(imageProblemText('format')).toMatch(/not a valid image/);
  });
});
