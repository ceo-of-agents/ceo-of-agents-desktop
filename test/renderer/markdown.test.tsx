import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../../src/renderer/Markdown';
import { MAX_STRIP, imageText, linkTitle, safeHref, stripMarkdown } from '../../src/renderer/markdown-safety';

describe('safeHref', () => {
  it('accepts https only', () => {
    expect(safeHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(safeHref('  https://example.com  ')).toBe('https://example.com/');
    expect(safeHref('HTTPS://Example.com')).toBe('https://example.com/');
  });
  it('rejects everything else', () => {
    for (const bad of ['http://example.com', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'mailto:a@b.c', 'ftp://x.y', '//example.com', '/relative', 'relative/path', '#top', '', '   ', 'https://', 'https:example', 'https://exa mple.com', 'https://a.com/\nx'])
      expect(safeHref(bad), bad).toBeNull();
    for (const v of [undefined, null, 5, {}]) expect(safeHref(v)).toBeNull();
  });
});

describe('linkTitle', () => {
  it('names the host and the full address', () => {
    expect(linkTitle('https://example.com/x?y=1')).toBe('Opens example.com in your browser: https://example.com/x?y=1');
    expect(linkTitle('https://sub.example.org:8443/')).toContain('Opens sub.example.org in your browser');
  });
});

describe('imageText', () => {
  it('prefers the alt text, then the address', () => {
    expect(imageText('A cat', 'https://x.y/c.png')).toBe('A cat');
    expect(imageText('  ', 'https://x.y/c.png')).toBe('https://x.y/c.png');
    expect(imageText(undefined, undefined)).toBe('');
  });
});

const html = (md: string) => renderToStaticMarkup(<Markdown text={md} />);

describe('Markdown', () => {
  it('renders GitHub-flavored Markdown', () => {
    const out = html('# Title\n\n**bold** and *it* and `code`\n\n- one\n- two\n\n```\nblock\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n~~gone~~');
    expect(out).toContain('<h1>Title</h1>');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<em>it</em>');
    expect(out).toContain('<code>code</code>');
    expect(out).toContain('<li>one</li>');
    expect(out).toContain('<pre><code>block');
    expect(out).toContain('<table>');
    expect(out).toContain('<del>gone</del>');
  });
  it('does not run raw HTML', () => {
    const out = html('<script>alert(1)</script> <img src="https://evil.test/x.png" onerror="x()"> <b onclick="x()">hi</b>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<b ');
    expect(out).not.toContain('onerror="');
  });
  it('links: https is a link, anything else is plain text', () => {
    expect(html('[site](https://example.com)')).toContain('<a href="https://example.com/" title="Opens example.com in your browser: https://example.com/">site</a>');
    for (const url of ['javascript:alert(1)', 'http://example.com', 'file:///etc/hosts']) {
      const out = html(`[click](${url})`);
      expect(out).not.toContain('<a ');
      expect(out).toContain('click');
    }
  });
  it('never loads images: alt text instead', () => {
    const out = html('![A cat](https://example.com/cat.png) ![](http://example.com/x.png)');
    expect(out).not.toContain('<img');
    expect(out).toContain('A cat');
    expect(out).toContain('http://example.com/x.png');
  });
  it('gives an image link the same hover title as a link', () => {
    const out = html('![A cat](https://example.com/cat.png)');
    expect(out).toContain('title="Opens example.com in your browser: https://example.com/cat.png"');
  });
});

describe('stripMarkdown cap', () => {
  it('looks only at the first MAX_STRIP characters', () => {
    expect(stripMarkdown(`${'a'.repeat(MAX_STRIP)}TAIL`)).toBe('a'.repeat(MAX_STRIP));
    expect(stripMarkdown('**bold** text')).toBe('bold text');
  });
  it('stays within the cap on very long pathological input', () => {
    for (const bad of ['*'.repeat(100000), '['.repeat(100000), '_*'.repeat(50000), '**a '.repeat(25000)]) {
      expect(stripMarkdown(bad).length).toBeLessThanOrEqual(MAX_STRIP);
    }
  });
});
