import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TipCard } from '../../src/renderer/TipCard';
import { afterGotIt, nextTip, phraseInsertion } from '../../src/renderer/tip-logic';
import { t } from '../../src/shared/strings';

describe('TipCard', () => {
  const tip = { id: 'resume', text: 'Back after a pause?', phrase: 'Resume' };
  const html = renderToStaticMarkup(<TipCard tip={tip} onUse={() => undefined} onDismiss={() => undefined} />);
  it('is a panel section with a static header, the tip text and a "Got it" button', () => {
    expect(html).toContain('class="panel-section tip-box"');
    expect(html).toContain(`<span class="section-name">${t('tips.title')}</span>`);
    expect(html).toContain('Back after a pause?');
    expect(html).toContain(t('tips.dismiss'));
    expect(t('tips.dismiss')).toBe('Got it');
  });
  it('"Next tip" is hidden when only one tip applies: two buttons (use and Got it)', () => {
    expect(html).not.toContain(t('tips.next'));
    expect(html.match(/<button/g)).toHaveLength(2);
  });
  it('"Next tip" shows when several apply: three buttons, the header is not a button', () => {
    const many = renderToStaticMarkup(<TipCard tip={tip} many onUse={() => undefined} onDismiss={() => undefined} onNext={() => undefined} />);
    expect(many).toContain(t('tips.next'));
    expect(many.match(/<button/g)).toHaveLength(3);
  });
});

describe('browsing tips', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  it('Next tip cycles in order and wraps around', () => {
    expect(nextTip(list, 'a')!.id).toBe('b');
    expect(nextTip(list, 'b')!.id).toBe('c');
    expect(nextTip(list, 'c')!.id).toBe('a');
    expect(nextTip([{ id: 'a' }], 'a')!.id).toBe('a');
    expect(nextTip([], 'a')).toBeNull();
  });
  it('Got it removes the tip and shows the one that followed it', () => {
    const r = afterGotIt(list, 'a');
    expect(r.tips.map((x) => x.id)).toEqual(['b', 'c']);
    expect(r.current!.id).toBe('b');
    expect(afterGotIt(list, 'b').current!.id).toBe('c');
  });
  it('Got it on the last tip of the list wraps to the start', () => {
    const r = afterGotIt(list, 'c');
    expect(r.tips.map((x) => x.id)).toEqual(['a', 'b']);
    expect(r.current!.id).toBe('a');
  });
  it('Got it on the only tip left hides the box', () => {
    expect(afterGotIt([{ id: 'a' }], 'a')).toEqual({ tips: [], current: null });
  });
});

describe('phraseInsertion', () => {
  it('an empty box gets the phrase; the "..." part is selected, else the cursor goes to the end', () => {
    expect(phraseInsertion('Resume')).toEqual({ text: 'Resume', selStart: 6, selEnd: 6 });
    expect(phraseInsertion('Decide whether ...')).toEqual({ text: 'Decide whether ...', selStart: 15, selEnd: 18 });
    expect(phraseInsertion('Resume', '')).toEqual({ text: 'Resume', selStart: 6, selEnd: 6 });
  });
  it('a box with only whitespace is replaced', () => {
    expect(phraseInsertion('Decide whether ...', '  \n ')).toEqual({ text: 'Decide whether ...', selStart: 15, selEnd: 18 });
  });
  it('text already typed is kept: the phrase goes on a new line after it', () => {
    expect(phraseInsertion('Resume', 'Hello')).toEqual({ text: 'Hello\nResume', selStart: 12, selEnd: 12 });
    expect(phraseInsertion('Decide whether ...', 'Hello')).toEqual({ text: 'Hello\nDecide whether ...', selStart: 21, selEnd: 24 });
  });
  it('no extra newline when the text already ends with one', () => {
    expect(phraseInsertion('Resume', 'Hello\n')).toEqual({ text: 'Hello\nResume', selStart: 12, selEnd: 12 });
    expect(phraseInsertion('Decide whether ...', 'Hello\n')).toEqual({ text: 'Hello\nDecide whether ...', selStart: 21, selEnd: 24 });
  });
});
