import { describe, expect, it } from 'vitest';
import { MAX_INLINE_PDF_BYTES, MAX_INLINE_PDF_PAGES, MAX_INLINE_PDFS_TOTAL_BYTES, inlinePdfIndexes, pdfPageCount, MAX_FILES, MAX_FILES_TOTAL_BYTES, MAX_FILE_BYTES, attachmentsNote, checkFiles, cleanFileName, fileKind, messageWithFiles, screenFiles, sizeText } from '../../src/shared/attachments';
import type { FileAttachment, ThreadFileRef } from '../../src/shared/types';

const MB = 1024 * 1024;
const bytes = (n: number) => new Uint8Array(n).fill(1);

describe('fileKind', () => {
  it('goes by the declared type, then the extension', () => {
    expect(fileKind('a.pdf', '')).toBe('pdf');
    expect(fileKind('noext', 'application/pdf')).toBe('pdf');
    expect(fileKind('clip.MOV', '')).toBe('video');
    expect(fileKind('x', 'video/webm')).toBe('video');
    expect(fileKind('talk.m4a', '')).toBe('audio');
    expect(fileKind('x', 'audio/mpeg')).toBe('audio');
    expect(fileKind('sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('other');
    expect(fileKind('notes.docx', '')).toBe('other');
    expect(fileKind('.mp4', '')).toBe('other'); // a dotfile has no extension
  });
});

describe('cleanFileName', () => {
  it('keeps the last segment and drops what a path or a display could abuse', () => {
    expect(cleanFileName('../../etc/passwd')).toBe('passwd');
    expect(cleanFileName('C:\\dir\\a b.pdf')).toBe('a b.pdf');
    expect(cleanFileName('.hidden')).toBe('hidden');
    expect(cleanFileName('a\u0000b\u202ec.txt')).toBe('abc.txt');
    expect(cleanFileName('  spaced   out .md ')).toBe('spaced out .md');
    expect(cleanFileName('')).toBe('file');
    expect(cleanFileName(5)).toBe('file');
    expect(cleanFileName('///')).toBe('file');
  });
  it('shortens a long name and keeps the extension', () => {
    const name = cleanFileName(`${'a'.repeat(300)}.pdf`);
    expect(name).toHaveLength(100);
    expect(name.endsWith('.pdf')).toBe(true);
  });
});

describe('size caps per kind', () => {
  it('screenFiles accepts what fits and names the first problem', () => {
    const r = screenFiles(0, 0, [
      { name: 'a.pdf', type: 'application/pdf', size: 32 * MB },
      { name: 'b.pdf', type: 'application/pdf', size: 32 * MB + 1 },
      { name: 'c.docx', type: '', size: 26 * MB },
      { name: 'd.mp4', type: 'video/mp4', size: 100 * MB },
      { name: 'empty.txt', type: 'text/plain', size: 0 },
    ]);
    expect(r.accepted).toEqual([0, 3]);
    expect(r.problem).toEqual({ code: 'size', name: 'b.pdf', kind: 'pdf' });
  });
  it('counts the files and the bytes already in the composer', () => {
    expect(screenFiles(MAX_FILES, 0, [{ name: 'a.txt', type: '', size: 1 }])).toEqual({ accepted: [], problem: { code: 'count' } });
    const r = screenFiles(0, MAX_FILES_TOTAL_BYTES - 5, [{ name: 'a.txt', type: '', size: 5 }, { name: 'b.txt', type: '', size: 1 }]);
    expect(r.accepted).toEqual([0]);
    expect(r.problem).toEqual({ code: 'total' });
  });
  it('checkFiles (main side) applies the same rules', () => {
    expect(checkFiles([])).toBeNull();
    expect(checkFiles([{ name: 'a.txt', mediaType: 'text/plain', data: bytes(10) }])).toBeNull();
    expect(checkFiles([{ name: 'a.zip', mediaType: '', data: bytes(MAX_FILE_BYTES.other + 1) }])).toEqual({ code: 'size', name: 'a.zip', kind: 'other' });
    expect(checkFiles([{ name: 'a.txt', mediaType: '', data: bytes(0) }])).toEqual({ code: 'format', name: 'a.txt' });
    expect(checkFiles([{ name: 'a.txt', mediaType: '', data: 'abc' }])).toEqual({ code: 'format' });
    expect(checkFiles(null)).toEqual({ code: 'format' });
    expect(checkFiles(Array.from({ length: MAX_FILES + 1 }, () => ({ name: 'a', mediaType: '', data: bytes(1) })))).toEqual({ code: 'count' });
  });
  it('the total of one message is capped', () => {
    const big = { name: 'v.mp4', mediaType: 'video/mp4', data: bytes(MAX_FILE_BYTES.video) };
    expect(checkFiles([big, { ...big, name: 'w.mp4' }])).toEqual({ code: 'total' });
  });
});

describe('message assembly', () => {
  const ref = (name: string, kind: ThreadFileRef['kind'], size: number): ThreadFileRef => ({ id: 'a'.repeat(64), name, kind, size });
  it('sizeText', () => {
    expect([sizeText(500), sizeText(2048), sizeText(3.45 * MB)]).toEqual(['500 B', '2 KB', '3.5 MB']);
  });
  it('lists each file with its absolute path after the text', () => {
    const out = messageWithFiles('summarise', [
      { ref: ref('report.pdf', 'pdf', 2048), path: '/data/files/x/report.pdf' },
      { ref: ref('notes.docx', 'other', 4096), path: '/data/files/y/notes.docx' },
    ]);
    expect(out.startsWith('summarise\n\n[The user attached 2 files')).toBe(true);
    expect(out).toContain('- report.pdf (pdf, 2 KB): /data/files/x/report.pdf (open it with the Read tool');
    expect(out).toContain('- notes.docx (file, 4 KB): /data/files/y/notes.docx');
  });
  it('tells the agent it cannot watch a video', () => {
    const note = attachmentsNote([{ ref: ref('clip.mp4', 'video', 5 * MB), path: '/data/files/z/clip.mp4' }]);
    expect(note).toContain('[The user attached a file');
    expect(note).toContain('video: you cannot watch it directly');
    expect(note).toContain('/data/files/z/clip.mp4');
  });
  it('no files: the text is unchanged; no text: only the note', () => {
    expect(messageWithFiles('hello', [])).toBe('hello');
    expect(messageWithFiles('', [{ ref: ref('a.txt', 'other', 1), path: '/p/a.txt' }]).startsWith('[The user attached a file')).toBe(true);
  });
});

describe('inline PDFs', () => {
  const pdfOf = (pages: number, extra = '', pad = 0): Uint8Array => {
    const body = Array.from({ length: pages }, (_, i) => `${i + 1} 0 obj\n<< /Type /Page /Parent 1 0 R >>\nendobj\n`).join('');
    return new Uint8Array(Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Pages /Count ${pages} >>\nendobj\n${body}${extra}${' '.repeat(pad)}\n%%EOF`, 'latin1'));
  };
  const file = (data: Uint8Array, name = 'a.pdf'): FileAttachment => ({ name, mediaType: 'application/pdf', data });
  const ref = (name: string, size: number): ThreadFileRef => ({ id: 'a'.repeat(64), name, kind: 'pdf', size });

  it('a small PDF goes inline', () => {
    expect([...inlinePdfIndexes([file(pdfOf(3))])]).toEqual([0]);
  });
  it('counts pages objects, not /Pages or /PageMode', () => {
    expect(pdfPageCount(pdfOf(3, '/PageMode /UseNone /PageLabels'))).toBe(3);
  });
  it('a PDF over 10 MB stays out', () => {
    expect(inlinePdfIndexes([file(pdfOf(2, '', MAX_INLINE_PDF_BYTES))]).size).toBe(0);
    expect(inlinePdfIndexes([file(pdfOf(2, '', MAX_INLINE_PDF_BYTES - 1000))]).size).toBe(1);
  });
  it('inline PDFs together stay within 20 MB (first come, first kept)', () => {
    const big = file(pdfOf(2, '', 9 * MB));
    expect([...inlinePdfIndexes([big, big, big])]).toEqual([0, 1]);
    expect(MAX_INLINE_PDFS_TOTAL_BYTES).toBe(20 * MB);
  });
  it('an encrypted PDF stays out', () => {
    expect(inlinePdfIndexes([file(pdfOf(2, '/Encrypt 9 0 R'))]).size).toBe(0);
  });
  it('more than 100 pages stays out, exactly 100 is fine', () => {
    expect(inlinePdfIndexes([file(pdfOf(MAX_INLINE_PDF_PAGES + 1))]).size).toBe(0);
    expect(inlinePdfIndexes([file(pdfOf(MAX_INLINE_PDF_PAGES))]).size).toBe(1);
  });
  it('an unknown page count stays out', () => {
    expect(pdfPageCount(new Uint8Array(Buffer.from('%PDF-1.4 test')))).toBeNull();
    expect(inlinePdfIndexes([file(new Uint8Array(Buffer.from('%PDF-1.4 test')))]).size).toBe(0);
  });
  it('falls back to the largest /Count when no page object is visible', () => {
    const data = new Uint8Array(Buffer.from('%PDF-1.5 << /Type /Pages /Count 4 >> << /Type /Pages /Count 12 /Kids [] >>'));
    expect(pdfPageCount(data)).toBe(12);
    expect(inlinePdfIndexes([file(data)]).size).toBe(1);
    expect(inlinePdfIndexes([file(new Uint8Array(Buffer.from('/Type /Pages /Count 101')))]).size).toBe(0);
  });
  it('other kinds are never inline', () => {
    expect(inlinePdfIndexes([{ name: 'n.txt', mediaType: 'text/plain', data: pdfOf(1) }]).size).toBe(0);
  });
  it('the note: an inline PDF is read from the message, any other with Read and no pages', () => {
    const inlineNote = attachmentsNote([{ ref: ref('a.pdf', 100), path: '/d/a.pdf', inline: true }]);
    expect(inlineNote).toContain('- a.pdf (pdf, 100 B): /d/a.pdf (also attached to this message as a document: read it there, no tool needed');
    expect(inlineNote).not.toContain('pages parameter');
    const plain = attachmentsNote([{ ref: ref('b.pdf', 100), path: '/d/b.pdf' }]);
    expect(plain).toContain('open it with the Read tool on the whole file, without the pages parameter');
    expect(plain).not.toContain('as a document');
  });
});
