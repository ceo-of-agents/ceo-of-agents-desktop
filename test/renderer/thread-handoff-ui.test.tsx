import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A tiny hook runtime so the components can be driven without a DOM: state and refs live in slots, one pass renders the tree.
const rt = vi.hoisted(() => ({ slots: [] as unknown[], i: 0 }));
vi.mock('react', async (orig) => {
  const real = await orig<typeof import('react')>();
  const mocked = {
    ...real,
    useState: (init: unknown) => {
      const k = rt.i++;
      if (!(k in rt.slots)) rt.slots[k] = typeof init === 'function' ? (init as () => unknown)() : init;
      return [rt.slots[k], (v: unknown) => { rt.slots[k] = typeof v === 'function' ? (v as (p: unknown) => unknown)(rt.slots[k]) : v; }];
    },
    useRef: (init: unknown) => {
      const k = rt.i++;
      if (!(k in rt.slots)) rt.slots[k] = { current: init };
      return rt.slots[k];
    },
    useEffect: () => undefined,
    useMemo: (f: () => unknown) => f(),
    useId: () => 'id',
    useLayoutEffect: () => undefined,
  };
  return { ...mocked, default: mocked };
});

import { HandOverButton, InboxBanner } from '../../src/renderer/ThreadView';
import { Button } from '../../src/renderer/ui/Button';
import { Tooltip } from '../../src/renderer/ui/Tooltip';
import { t } from '../../src/shared/strings';
import type { InboxPendingNote } from '../../src/shared/types';

interface El { type: unknown; props: { children?: ReactNode; [k: string]: unknown } }
/** Every element of one render pass: function components are expanded, except Button and Tooltip (kept as leaves with their props). */
function render(make: () => ReactNode): El[] {
  rt.i = 0;
  const out: El[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object' || !('props' in n)) return;
    const el = n as ReactElement as unknown as El;
    out.push(el);
    if (typeof el.type === 'function' && el.type !== Button && el.type !== Tooltip) walk((el.type as (p: unknown) => ReactNode)(el.props));
    else walk(el.props.children);
  };
  walk(make());
  return out;
}
const text = (n: ReactNode): string =>
  Array.isArray(n) ? n.map(text).join('') : typeof n === 'string' || typeof n === 'number' ? String(n) : n && typeof n === 'object' && 'props' in n ? text((n as unknown as El).props.children) : '';

beforeEach(() => {
  rt.slots = [];
  rt.i = 0;
});

describe('HandOverButton', () => {
  it('is enabled with no tooltip when the chat has work', () => {
    const els = render(() => HandOverButton({ pendingWork: true, cosName: 'Ada', persona: 'Max', onClick: () => undefined }));
    expect(els.some((e) => e.type === Tooltip)).toBe(false);
    const b = els.find((e) => e.type === Button)!;
    expect(b.props.disabled).toBe(false);
    expect(text(b.props.children)).toBe('Hand over to Ada');
  });
  it('is disabled and explains why in a tooltip when there is no work to hand over', () => {
    const els = render(() => HandOverButton({ pendingWork: false, cosName: 'Ada', persona: 'Max', onClick: () => undefined }));
    expect(els.find((e) => e.type === Button)!.props.disabled).toBe(true);
    expect(els.find((e) => e.type === Tooltip)!.props.label).toBe(t('dept.handOverNoWork', { persona: 'Max' }));
  });
});

describe('InboxBanner', () => {
  const notes: InboxPendingNote[] = [{ path: 'inbox/a.md', name: 'Max' }, { path: 'inbox/b.md', name: 'Bea' }, { path: 'inbox/c.md', name: 'Max' }, { path: 'inbox/d.md', name: null }];
  const banner = (o: Partial<Parameters<typeof InboxBanner>[0]> = {}) => render(() => InboxBanner({ notes, cosName: 'Ada', disabled: false, busy: false, onAsk: async () => undefined, ...o }));
  const button = (els: El[]) => els.find((e) => e.type === Button)!;

  it('shows nothing without notes', () => expect(banner({ notes: [] })).toEqual([]));
  it('shows the count and the department names once each', () => {
    const els = banner();
    expect(text(els.find((e) => e.props.className === 'inbox-banner-text')!.props.children)).toBe('4 handoff notes waiting: Max, Bea, unknown sender');
    expect(text(button(els).props.children)).toBe('Ask Ada to read them');
  });
  it('says one note in the singular', () => {
    const els = banner({ notes: [notes[0]] });
    expect(text(els.find((e) => e.props.className === 'inbox-banner-text')!.props.children)).toBe('1 handoff note waiting: Max');
  });
  it('the button is disabled while the chief of staff is busy or cannot write', () => {
    expect(button(banner({ busy: true })).props.disabled).toBe(true);
    expect(button(banner({ disabled: true })).props.disabled).toBe(true);
    expect(button(banner()).props.disabled).toBe(false);
  });
  it('a click sends once, however many times it is clicked before the thread is busy', async () => {
    const onAsk = vi.fn(async () => undefined);
    const first = button(banner({ onAsk })).props.onClick as () => void;
    first();
    first(); // a second click on the same render
    expect(onAsk).toHaveBeenCalledTimes(1);
    const again = button(banner({ onAsk }));
    expect(again.props.disabled).toBe(true); // disabled until the thread state updates
    (again.props.onClick as () => void)();
    expect(onAsk).toHaveBeenCalledTimes(1);
  });
  it('a failed send makes the button usable again', async () => {
    const onAsk = vi.fn(async () => { throw new Error('no'); });
    (button(banner({ onAsk })).props.onClick as () => void)();
    await new Promise((r) => setTimeout(r, 0));
    expect(button(banner({ onAsk })).props.disabled).toBe(false);
    (button(banner({ onAsk })).props.onClick as () => void)();
    expect(onAsk).toHaveBeenCalledTimes(2);
  });
});
