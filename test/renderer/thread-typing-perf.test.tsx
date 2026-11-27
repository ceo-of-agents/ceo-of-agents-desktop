// @vitest-environment jsdom
// Typing in the composer of a long chat must not render any message (the draft lives in draft-text.ts, not in App state), and a long
// chat renders only the rows near the viewport. jsdom has no layout: the scroll box gets a fixed size and every row a fixed height here.
import { Profiler, act, createElement, type ComponentProps, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThreadEntry, ThreadInfo } from '../../src/shared/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Every render of an assistant message's Markdown counts as one message row render.
const counts = vi.hoisted(() => ({ markdown: 0 }));
vi.mock('../../src/renderer/Markdown', async (orig) => {
  const real = await orig<typeof import('../../src/renderer/Markdown')>();
  return {
    ...real,
    Markdown: (p: ComponentProps<typeof real.Markdown>) => {
      counts.markdown++;
      return createElement(real.Markdown, p);
    },
  };
});

import { VIRTUAL_MIN_ROWS, ThreadView } from '../../src/renderer/ThreadView';

const N = 500;
const KEYS = 20;
const MD = 'Here is a plan:\n\n- first item with `code`\n- second item\n\n```ts\nconst answer = 42;\nconsole.log(answer);\n```\n\nDone.';
const entries: ThreadEntry[] = Array.from({ length: N }, (_, i) => ({
  id: `e${i}`,
  kind: i % 2 === 0 ? 'user' : 'assistant',
  author: i % 2 === 0 ? 'You' : 'Ada',
  text: i % 2 === 0 ? `Question number ${i}` : `Answer ${i}. ${MD}`,
  time: new Date(Date.UTC(2026, 0, 5, 10, 0, i)).toISOString(),
}));
const thread = { entries, streaming: '', busy: false, speaker: 'Ada', title: 'Ada (Chief of Staff)' } as unknown as ThreadInfo;

const noop = () => undefined;
const view = (
  <ThreadView
    orgId="o1" threadId="cos" title="Ada" thread={thread} speakerFallback="Ada" isCos cosName="Ada" tabStatus={null} persona=""
    permissions={[]} reply={null} focusNonce={0} onClearReply={noop} onRestoreReply={noop}
    pendingWork={false} onHandOver={noop} onOpenSettings={noop} onSetSettings={noop}
  />
);

const VIEWPORT = 600;
const ROW = 90;
/** A scroll box that scrolls: scrollHeight is the virtual list's height, scrollTo moves scrollTop and fires a scroll event. */
function fakeLayout() {
  const proto = HTMLElement.prototype;
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => VIEWPORT });
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(proto, 'offsetHeight', { configurable: true, get: () => ROW });
  Object.defineProperty(proto, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return parseFloat(this.querySelector<HTMLElement>('.vlist')?.style.height || '0') || VIEWPORT;
    },
  });
  const tops = new WeakMap<Element, number>();
  Object.defineProperty(proto, 'scrollTop', { configurable: true, get(this: Element) { return tops.get(this) ?? 0; }, set(this: Element, v: number) { tops.set(this, v); } });
  // Like a browser, the scroll event comes after the call, not inside it.
  proto.scrollTo = function (this: HTMLElement, o?: ScrollToOptions | number) {
    tops.set(this, Math.max(0, Math.min(typeof o === 'object' ? o.top ?? 0 : 0, this.scrollHeight - VIEWPORT)));
    queueMicrotask(() => this.dispatchEvent(new Event('scroll')));
  } as typeof proto.scrollTo;
}

let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  fakeLayout();
  vi.stubGlobal('requestAnimationFrame', () => 0);
});
afterEach(() => {
  for (const k of ['clientHeight', 'clientWidth', 'offsetHeight', 'scrollHeight', 'scrollTop'] as const) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
  host.remove();
  vi.unstubAllGlobals();
});

const mount = async () => {
  const durations: number[] = [];
  const root = createRoot(host);
  const show = (el: ReactElement) =>
    act(async () =>
      root.render(
        <Profiler id="t" onRender={(_id, phase, actual) => { if (phase === 'update') durations.push(actual); }}>
          {el}
        </Profiler>,
      ),
    );
  await show(view);
  return { root, durations, show };
};

describe('a long chat', () => {
  it('renders only the rows near the viewport, the last ones at the bottom of a chat that just opened', async () => {
    const { root } = await mount();
    const rows = host.querySelectorAll('.vrow');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(60);
    const body = host.querySelector<HTMLElement>('.thread-body')!;
    expect(body.scrollTop).toBeGreaterThan(0);
    expect(host.textContent).toContain('Answer 499.');
    expect(host.textContent).not.toContain('Question number 0');
    act(() => root.unmount());
  });

  const withEntry = (n: number) =>
    createElement(ThreadView, { ...view.props, thread: { ...thread, entries: [...entries, ...Array.from({ length: n }, (_, i) => ({ ...entries[1], id: `new${i}`, text: `Fresh answer ${i}` }))] } as ThreadInfo });
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const bodyOf = () => host.querySelector<HTMLElement>('.thread-body')!;

  it('follows a new message while the reader is at the bottom', async () => {
    const { root, show } = await mount();
    await show(withEntry(1));
    await settle();
    expect(host.textContent).toContain('Fresh answer 0');
    expect(host.querySelector('.jump')).toBeNull(); // still following the end
    expect(bodyOf().scrollTop).toBeGreaterThan(bodyOf().scrollHeight - VIEWPORT - 2 * ROW);
    act(() => root.unmount());
  });

  it('leaves a reader who scrolled up where they are when a message arrives', async () => {
    const { root, show } = await mount();
    const body = bodyOf();
    body.scrollTop = 9000;
    await act(async () => { body.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true })); });
    await act(async () => { body.dispatchEvent(new Event('scroll')); });
    await settle();
    expect(host.textContent).not.toContain('Answer 499.');
    expect(host.textContent).toMatch(/Answer [1-9]\d\./);
    await show(withEntry(1));
    await settle();
    expect(body.scrollTop).toBe(9000);
    expect(host.textContent).not.toContain('Fresh answer 0');
    act(() => root.unmount());
  });

  it('shows every row of a short chat, as before', () => {
    const short = { ...thread, entries: entries.slice(0, VIRTUAL_MIN_ROWS - 5) } as ThreadInfo;
    const root = createRoot(host);
    act(() => root.render(createElement(ThreadView, { ...view.props, thread: short })));
    expect(host.querySelector('.vlist')).toBeNull();
    expect(host.querySelectorAll('.row-wrap')).toHaveLength(VIRTUAL_MIN_ROWS - 5);
    act(() => root.unmount());
  });

  it('typing renders no message', async () => {
    const { root, durations } = await mount();
    const box = host.querySelector('textarea')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    counts.markdown = 0;
    durations.length = 0;
    let text = '';
    for (let k = 0; k < KEYS; k++) {
      text += 'x';
      act(() => {
        setValue.call(box, text);
        box.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    const total = durations.reduce((a, b) => a + b, 0);
    if (process.env.COA_PERF) console.warn(`PERF rowsInDom=${host.querySelectorAll('.row-wrap').length} markdownRendersPerKeystroke=${counts.markdown / KEYS} commits=${durations.length} actualDurationTotal=${total.toFixed(1)}ms mean=${(total / KEYS).toFixed(2)}ms`);
    expect(box.value).toBe(text);
    expect(counts.markdown).toBe(0);
    expect(host.querySelector('.send.ready')).not.toBeNull();
    act(() => root.unmount());
  });
});
