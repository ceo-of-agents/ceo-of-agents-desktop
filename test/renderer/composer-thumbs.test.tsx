import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ComposerThumbs, MessageImage } from '../../src/renderer/ComposerImages';
import { t } from '../../src/shared/strings';
import { attachment } from '../helpers-images';

describe('ComposerThumbs', () => {
  it('renders nothing for an empty list', () => {
    expect(renderToStaticMarkup(<ComposerThumbs images={[]} onRemove={() => undefined} />)).toBe('');
  });
  it('shows one thumbnail per image, each with a labelled remove button', () => {
    const a = attachment('image/png');
    const html = renderToStaticMarkup(
      <ComposerThumbs images={[{ key: 'i1', attachment: a }, { key: 'i2', attachment: attachment('image/jpeg') }]} onRemove={() => undefined} />,
    );
    expect(html.match(/<img /g)).toHaveLength(2);
    expect(html).toContain(`src="data:image/png;base64,${a.data}"`);
    expect(html).toContain(`alt="${t('images.attached', { n: 2 })}"`);
    expect(html.match(new RegExp(`aria-label="${t('composer.removeImage')}"`, 'g'))).toHaveLength(2);
  });
});

describe('MessageImage', () => {
  it('shows the image once loaded', () => {
    const html = renderToStaticMarkup(<MessageImage src="data:image/png;base64,AAAA" n={1} />);
    expect(html).toContain('<img');
    expect(html).toContain(t('images.attached', { n: 1 }));
  });
  it('shows a muted placeholder when the image is gone, and a blank box while it loads', () => {
    expect(renderToStaticMarkup(<MessageImage src={null} n={1} />)).toContain(t('images.notAvailable'));
    const loading = renderToStaticMarkup(<MessageImage src={undefined} n={1} />);
    expect(loading).toContain('loading');
    expect(loading).not.toContain('<img');
  });
});

describe('image styles', () => {
  const css = readFileSync(join(__dirname, '../../src/renderer/styles/thread.css'), 'utf8');
  it('use semantic tokens only', () => {
    const block = css.slice(css.indexOf('/* Images'), css.indexOf('/* Composer (5.2)'));
    expect(block.length).toBeGreaterThan(100);
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
  it('the composer border turns --muted under a drag', () => {
    expect(css).toMatch(/\.composer\.dragover\s*\{\s*border-color:\s*var\(--muted\)/);
  });
});
