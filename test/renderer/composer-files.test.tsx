import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ComposerFiles, MessageFiles, hasVideo } from '../../src/renderer/ComposerFiles';
import { draftBytes, draftFiles, splitFiles, type DraftFile } from '../../src/renderer/composer-files';
import { t } from '../../src/shared/strings';

const draft = (key: string, name: string, type: string, size = 2048): DraftFile => ({ key, attachment: { name, mediaType: type, data: new Uint8Array(size) } });

describe('splitFiles', () => {
  it('sends PNG, JPEG, GIF and WebP as images and everything else, other image types included, as files', () => {
    const r = splitFiles([{ type: 'image/png' }, { type: 'application/pdf' }, { type: 'image/svg+xml' }, { type: 'video/mp4' }, { type: '' }, { type: 'image/webp' }]);
    expect(r.images.map((f) => f.type)).toEqual(['image/png', 'image/webp']);
    expect(r.others).toHaveLength(4);
  });
});

describe('ComposerFiles', () => {
  it('shows one chip per file with its name, size and a remove button', () => {
    const html = renderToStaticMarkup(<ComposerFiles files={[draft('f1', 'report.pdf', 'application/pdf'), draft('f2', 'clip.mp4', 'video/mp4', 3 * 1024 * 1024)]} onRemove={() => undefined} />);
    expect(html.match(/class="file-chip"/g)).toHaveLength(2);
    expect(html).toContain('report.pdf');
    expect(html).toContain('2 KB');
    expect(html).toContain('3 MB');
    expect(html).toContain(`aria-label="${t('composer.removeFile', { name: 'clip.mp4' })}"`);
  });
  it('nothing for no files', () => {
    expect(renderToStaticMarkup(<ComposerFiles files={[]} onRemove={() => undefined} />)).toBe('');
  });
  it('hasVideo tells when the video hint is due', () => {
    expect(hasVideo([draft('a', 'a.pdf', 'application/pdf')])).toBe(false);
    expect(hasVideo([draft('a', 'a.pdf', 'application/pdf'), draft('b', 'x.mov', '')])).toBe(true);
    expect(t('composer.videoHint')).toMatch(/not read natively/);
  });
});

describe('MessageFiles', () => {
  it('shows the files of a sent message as chips without a remove button', () => {
    const html = renderToStaticMarkup(<MessageFiles files={[{ id: 'a'.repeat(64), name: 'notes.docx', size: 4096, kind: 'other' }]} />);
    expect(html).toContain('notes.docx');
    expect(html).toContain('4 KB');
    expect(html).not.toContain('<button');
  });
});

describe('draftFiles', () => {
  it('keeps files per chat, frees a chat or an org', () => {
    const a = [draft('a', 'a.txt', 'text/plain', 10)];
    draftFiles.set('o1|cos', a);
    draftFiles.set('o1|tab:1', a);
    draftFiles.set('o2|cos', a);
    expect(draftFiles.get('o1|cos')).toBe(a);
    expect(draftBytes(a)).toBe(10);
    draftFiles.delete('o1|cos');
    expect(draftFiles.get('o1|cos')).toEqual([]);
    draftFiles.deleteOrg('o1');
    expect(draftFiles.size()).toBe(1);
    draftFiles.set('o2|cos', []);
    expect(draftFiles.size()).toBe(0);
  });
});
