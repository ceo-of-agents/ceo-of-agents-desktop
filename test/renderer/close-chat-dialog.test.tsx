import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CloseChatBody } from '../../src/renderer/CloseChatDialog';
import type { CloseChoice } from '../../src/renderer/logic';

/** Every element of a rendered tree (function components are called), in document order. */
function walk(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) node.forEach((n) => walk(n, out));
  else if (node && typeof node === 'object' && 'props' in node) {
    const el = node as ReactElement<{ children?: ReactNode; onClick?: () => void }>;
    out.push(el);
    walk(el.props.children, out);
  }
  return out;
}
const textOf = (el: ReactElement): string => walk((el.props as { children?: ReactNode }).children).length ? '' : String((el.props as { children?: ReactNode }).children);

describe('CloseChatBody', () => {
  const props = { persona: 'Max', cosName: 'Ada', busy: false };
  const buttons = (onChoose: (c: CloseChoice) => void, busy = false) =>
    walk(CloseChatBody({ ...props, busy, onChoose })).filter((e) => typeof (e.props as { onClick?: unknown }).onClick === 'function');

  it('offers Hand over (first, so it takes the focus), Close without handover and Cancel', () => {
    const buttons3 = buttons(vi.fn());
    expect(buttons3.map(textOf)).toEqual(['Hand over to Ada', 'Close without handover', 'Cancel']);
  });

  it('each button reports its own choice', () => {
    const onChoose = vi.fn();
    buttons(onChoose).forEach((b) => (b.props as { onClick(): void }).onClick());
    expect(onChoose.mock.calls.map((c) => c[0])).toEqual(['handover', 'close', 'cancel']);
  });

  it('names the persona and the chief of staff, and says the reply stops only when busy', () => {
    const idle = renderToStaticMarkup(<CloseChatBody {...props} onChoose={() => undefined} />);
    expect(idle).toContain('Close the chat with Max?');
    expect(idle).toContain('Max has not handed over to Ada. Without a handover, the work in this chat is lost.');
    expect(idle).not.toContain('current reply');
    const busy = renderToStaticMarkup(<CloseChatBody {...props} busy onChoose={() => undefined} />);
    expect(busy).toContain('Its current reply will be stopped.');
  });
});
