import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { InlineMarkdown } from '../../src/renderer/Markdown';
import { stripMarkdown } from '../../src/renderer/markdown-safety';
import { SidePanel } from '../../src/renderer/SidePanel';
import type { WaitingItem } from '../../src/shared/types';

const inline = (md: string, noLinks = false) => renderToStaticMarkup(<InlineMarkdown text={md} noLinks={noLinks} />);

describe('InlineMarkdown', () => {
  it('renders bold, emphasis, code, strike-through and links', () => {
    const out = inline('**bold** and *it* and `code` and ~~gone~~ and [site](https://example.com/x)');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<em>it</em>');
    expect(out).toContain('<code>code</code>');
    expect(out).toContain('<del>gone</del>');
    expect(out).toContain('href="https://example.com/x"');
    expect(out).toContain('title="Opens example.com in your browser: https://example.com/x"');
    expect(out).not.toMatch(/\*\*|`|\]\(/);
  });
  it('renders no block element: they show as their text', () => {
    const out = inline('# Title\n\n- one\n- two\n\n> quoted\n\n```\nblock\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |');
    expect(out).not.toMatch(/<(h1|p|ul|ol|li|blockquote|pre|table|tr|td|th)[ >]/);
    for (const word of ['Title', 'one', 'two', 'quoted', 'block']) expect(out).toContain(word);
    expect(out).not.toContain('# ');
  });
  it('never runs raw HTML', () => {
    const out = inline('<script>alert(1)</script> <img src="https://x.y/a.png" onerror="x()"> <b>hi</b>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<b>');
  });
  it('opens only https links and never loads remote images', () => {
    const out = inline('[a](javascript:alert(1)) [b](http://x.y) ![cat](https://x.y/c.png)');
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('href="http://');
    expect(out).not.toContain('<img');
    expect(out).toContain('cat');
  });
  it('with noLinks shows a link as its text, no anchor', () => {
    const out = inline('see [the doc](https://example.com) and ![alt](https://x.y/c.png)', true);
    expect(out).not.toContain('<a');
    expect(out).toContain('the doc');
    expect(out).toContain('alt');
  });
});

describe('stripMarkdown', () => {
  it('removes the markers and keeps the text', () => {
    expect(stripMarkdown('**bold** and *it* and _under_ and `code` and ~~gone~~')).toBe('bold and it and under and code and gone');
    expect(stripMarkdown('see [the doc](https://example.com/a) now')).toBe('see the doc now');
    expect(stripMarkdown('![alt text](https://x.y/c.png)')).toBe('alt text');
    expect(stripMarkdown('## Heading')).toBe('Heading');
    expect(stripMarkdown('- item\n* other\n1. third\n> quote')).toBe('item other third quote');
  });
  it('keeps snake_case and plain text', () => {
    expect(stripMarkdown('use my_file_name.md')).toBe('use my_file_name.md');
    expect(stripMarkdown('a  b\n c')).toBe('a b c');
    expect(stripMarkdown('')).toBe('');
  });
});

describe('SidePanel with Markdown lines', () => {
  beforeAll(() => {
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  });
  const item: WaitingItem = {
    code: 'ACME-D1',
    kind: 'D',
    urgency: 'high',
    text: 'Pick **one** for `state.md` see [doc](https://example.com/d)',
    since: null,
    escalate: false,
    action: 'decide',
    options: [
      { key: 'a', label: 'Ship **now** with [notes](https://example.com/n)' },
      { key: 'b', label: 'Wait for `v2`' },
    ],
  } as WaitingItem;
  let html = '';
  beforeAll(() => {
    html = renderToStaticMarkup(
    <SidePanel
      orgId="o"
      cosName="Cos"
      waiting={[item, { unparsed: '- **raw** line' }]}
      initiatives={[{ slug: 's', title: 'The **big** one', state: 'active', updated: null, goal: 'Reach **the** goal', stateText: 'In `flight` now', nextStep: 'Do `x` then [y](https://example.com)' }]}
      departments={[{ id: 'e', agent: 'max', persona: 'Max', role: '**Eng**' } as never]}
      tabs={[]}
      busyTabIds={[]}
      cosBusy={false}
      cosTurnStartedAt={null}
      hidden={false}
      onAnswer={() => undefined}
      onChat={() => undefined}
      onOpenChart={() => undefined}
      looks={{}}
      revealWaiting={0}
    />,
    );
  });
  it('shows no Markdown markers in text', () => {
    const visible = html.replace(/<[^>]*>/g, '');
    expect(visible).not.toMatch(/\*\*|`|\]\(/);
    expect(html).toContain('<strong>one</strong>');
    expect(html).toContain('<code>state.md</code>');
    expect(html).toContain('<strong>big</strong>');
    expect(html).toContain('<strong>Eng</strong>');
    expect(html).toContain('<code>flight</code>');
    expect(html).toContain('<strong>the</strong>');
  });
  it('names the initiatives section and says what it holds', () => {
    expect(html).toContain('>Initiatives<');
    expect(html).not.toContain('In progress');
    expect(html).toContain('Work that spans several sessions or departments. Cos keeps a status page for each one.');
  });
  it('keeps the option label of a button plain and buttons free of links', () => {
    const buttons = html.match(/<button[^>]*>.*?<\/button>/g) ?? [];
    for (const b of buttons) expect(b).not.toContain('<a ');
    expect(html).toContain('aria-label="a · Ship now with notes"');
  });
});
