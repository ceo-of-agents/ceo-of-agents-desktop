// @vitest-environment jsdom
// Copy buttons on assistant messages and code blocks.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CopyButton } from '../../src/renderer/CopyButton';
import { Markdown } from '../../src/renderer/Markdown';
import { COPIED_MS, codeBlockText } from '../../src/renderer/copy-logic';
import { t } from '../../src/shared/strings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let writeText: ReturnType<typeof vi.fn>;

const buttons = () => Array.from(host.querySelectorAll<HTMLButtonElement>('button.copy-btn'));
const click = async (el: Element) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('codeBlockText', () => {
  it('drops only the final newline', () => {
    expect(codeBlockText('a\n  b\n')).toBe('a\n  b');
    expect(codeBlockText('a\n\n')).toBe('a\n');
    expect(codeBlockText('x')).toBe('x');
  });
});

describe('CopyButton', () => {
  it('copies the raw Markdown source of a message as plain text', async () => {
    const source = '# Title\n\n**bold** and `code`\n\n```ts\nconst a = 1;\n```\n';
    act(() => root.render(<CopyButton text={source} label={t('copy.message')} />));
    const [btn] = buttons();
    expect(btn.getAttribute('aria-label')).toBe('Copy message');
    expect(btn.getAttribute('title')).toBe('Copy message');
    await click(btn);
    expect(writeText).toHaveBeenCalledExactlyOnceWith(source);
  });

  it('switches to the confirmation, then reverts after the timeout', async () => {
    act(() => root.render(<CopyButton text="x" label="Copy message" />));
    const btn = buttons()[0];
    expect(btn.dataset.state).toBe('idle');
    await click(btn);
    expect(btn.dataset.state).toBe('copied');
    expect(btn.getAttribute('aria-label')).toBe('Copied');
    act(() => void vi.advanceTimersByTime(COPIED_MS - 1));
    expect(btn.dataset.state).toBe('copied');
    act(() => void vi.advanceTimersByTime(1));
    expect(btn.dataset.state).toBe('idle');
    expect(btn.getAttribute('aria-label')).toBe('Copy message');
  });

  it('shows a failure, without crashing, when the clipboard refuses', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    act(() => root.render(<CopyButton text="x" label="Copy message" />));
    const btn = buttons()[0];
    await click(btn);
    expect(btn.dataset.state).toBe('failed');
    expect(btn.getAttribute('aria-label')).toBe('Could not copy');
    act(() => void vi.advanceTimersByTime(COPIED_MS));
    expect(btn.dataset.state).toBe('idle');
  });

  it('clears its timer on unmount', async () => {
    act(() => root.render(<CopyButton text="x" label="Copy message" />));
    await click(buttons()[0]);
    expect(vi.getTimerCount()).toBe(1);
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(host);
  });

  it('is a focusable button', () => {
    act(() => root.render(<CopyButton text="x" label="Copy message" />));
    const btn = buttons()[0];
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.type).toBe('button');
    expect(btn.tabIndex).toBe(0);
  });
});

describe('code blocks in Markdown', () => {
  it('copies only the code: no fences, no language label', async () => {
    act(() => root.render(<Markdown text={'Before\n\n```python\nprint("hi")\nx = 2\n```\n\nAfter'} />));
    const [btn] = buttons();
    expect(btn.getAttribute('aria-label')).toBe('Copy code');
    await click(btn);
    expect(writeText).toHaveBeenCalledExactlyOnceWith('print("hi")\nx = 2');
  });

  it('gives each block its own button, and inline code none', async () => {
    act(() => root.render(<Markdown text={'`inline`\n\n```\none\n```\n\n```\ntwo\n```\n'} />));
    expect(buttons()).toHaveLength(2);
    await click(buttons()[1]);
    expect(writeText).toHaveBeenCalledExactlyOnceWith('two');
  });

  it('copies a long line and indentation exactly as written (wrapping is CSS only)', async () => {
    const code = ['function f() {', `    return "${'x'.repeat(300)}";`, '\t\tdeep', `https://acme.example.com/${'a/'.repeat(120)}`].join('\n');
    act(() => root.render(<Markdown text={'```ts\n' + code + '\n```\n'} />));
    await click(buttons()[0]);
    expect(writeText).toHaveBeenCalledExactlyOnceWith(code);
  });
});
