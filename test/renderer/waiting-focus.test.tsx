import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SidePanel } from '../../src/renderer/SidePanel';
import { WaitingFocus } from '../../src/renderer/WaitingFocus';
import { pendingStore } from '../../src/renderer/pending-send';
import type { WaitingItem } from '../../src/shared/types';

const noop = () => undefined;
const item = (code: string, patch: Partial<WaitingItem> = {}): WaitingItem => ({
  code, kind: 'A', urgency: 'normal', text: `Text of ${code}`, since: '2026-11-10', escalate: false, action: 'ok', ...patch,
});
const decide = item('D-1', {
  kind: 'D', action: 'decide', urgency: 'high', text: 'Which plan?',
  options: [{ key: 'a', label: 'Free tier' }, { key: 'b', label: 'Paid tier now, with a long label that must show in full without any cut at all' }],
  card: {
    context: 'Context line.\n\n- bullet one\n- bullet two', recommendation: '(b), because it scales. See https://github.com/acme/app/pull/7',
    options: [{ key: 'a', label: 'Free tier' }, { key: 'b', label: 'Paid tier now, with a long label that must show in full without any cut at all' }],
    proposedBy: 'Max', escalate: true,
  },
});
const html = (items: WaitingItem[], open = true) => renderToStaticMarkup(<WaitingFocus open={open} orgId="o1" items={items} onClose={noop} onReply={noop} />);

beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse('2026-11-19T10:00:00Z'));
});
afterEach(() => {
  pendingStore.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('WaitingFocus', () => {
  it('renders nothing when closed', () => {
    expect(html([item('A-1')], false)).toBe('');
  });

  it('is a modal dialog with the slide region labelled "i of n: code", the position and the hint', () => {
    const h = html([item('A-1'), item('A-2', { since: '2026-11-12' })]);
    expect(h).toContain('role="dialog"');
    expect(h).toContain('aria-modal="true"');
    expect(h).toContain('aria-label="Waiting on you, focus view"');
    expect(h).toContain('aria-roledescription="slide"');
    expect(h).toContain('aria-label="1 of 2: A-1"');
    expect(h).toContain('1 of 2');
    expect(h).toContain('← → to move · Esc to close');
    expect(h).toContain('Waiting since 10 Nov · 9 d');
  });

  it('disables Previous on the first item and Next on the last', () => {
    const one = html([item('A-1')]);
    expect(one).toMatch(/aria-label="Previous item"[^>]*disabled/);
    expect(one).toMatch(/aria-label="Next item"[^>]*disabled/);
    const two = html([item('A-1'), item('A-2', { since: '2026-11-12' })]);
    expect(two).toMatch(/disabled=""[^>]*aria-label="Previous item"|aria-label="Previous item"[^>]*disabled/);
    expect(two).not.toMatch(/aria-label="Next item"[^>]*disabled/);
  });

  it('an {ok} item: Approve, Decline, Reply, the kind chip and the violet bar; text is not clamped', () => {
    const h = html([item('A-1', { urgency: 'high', text: 'x'.repeat(600) })]);
    expect(h).toContain('data-tagged="true"');
    expect(h).toContain('APPROVE');
    expect(h).toContain('HIGH');
    for (const label of ['Approve', 'Decline', 'Reply']) expect(h).toContain(`>${label}</button>`);
    expect(h).not.toContain('Show more');
    expect(h).toContain('x'.repeat(600));
  });

  it('a decide item with options: Context, all options with full labels, RECOMMENDED on the named one, Recommendation, proposed by, HOLDING; footer has Reply only', () => {
    const h = html([decide]);
    expect(h).toContain('>Context<');
    expect(h).toContain('>Options<');
    expect(h).toContain('>Recommendation<');
    expect(h).toContain('<li>bullet one</li>');
    expect(h).toContain('Paid tier now, with a long label that must show in full without any cut at all');
    expect((h.match(/class="fv-rec"/g) ?? []).length).toBe(1);
    expect(h.indexOf('fv-rec')).toBeGreaterThan(h.indexOf('>b</span>'));
    expect(h).toContain('Proposed by Max');
    expect(h).toContain('Holding');
    expect(h).toContain('>Reply</button>');
    expect(h).not.toContain('>Answer</button>');
    expect(h).not.toContain('More options');
  });

  it('a decide item with fewer than two options: Answer and Reply; with no card: the muted "not in the decision queue" line', () => {
    const one = html([item('D-2', { kind: 'D', action: 'decide', card: { context: 'c', options: [{ key: 'a', label: 'Only' }], recommendation: '', proposedBy: null, escalate: false } })]);
    expect(one).toContain('>Answer</button>');
    expect(one).toContain('>Reply</button>');
    const none = html([item('D-3', { kind: 'D', action: 'decide' })]);
    expect(none).toContain('The decision card for D-3 is not in the decision queue.');
    expect(none).toContain('>Answer</button>');
  });

  it('{do} has Done and Reply; a todo item shows its status; an untagged item has Reply and the hint, no bar', () => {
    const d = html([item('A-2', { action: 'do' })]);
    expect(d).toContain('>Done</button>');
    expect(d).toContain('TO DO');
    const todo = html([item('T-1', { kind: 'T', action: 'do', status: 'waiting for the vendor' })]);
    expect(todo).toContain('YOUR TASK');
    expect(todo).toContain('Status: waiting for the vendor');
    const u = html([item('A-3', { action: null })]);
    expect(u).toContain('data-tagged="false"');
    expect(u).toContain('>Reply</button>');
    expect(u).not.toContain('>Approve</button>');
    expect(u).toContain('older format');
  });

  it('link chips: ISSUE and PR labels and hosts, as buttons with the full URL', () => {
    const h = html([item('A-1', { text: 'See https://github.com/acme/app/issues/94 and [doc](https://example.com/d) and https://github.com/acme/app/pull/12' })]);
    expect(h).toContain('Issue #94');
    expect(h).toContain('PR #12');
    expect(h).toContain('example.com');
    expect(h).not.toContain('href="http://');
  });

  it('empty deck: the empty state and a Close button, no position and no hint', () => {
    const h = html([]);
    expect(h).toContain('Nothing waiting on you');
    expect(h).toContain('>Close</button>');
    expect(h).not.toContain('to move');
    expect(h).not.toContain('Previous item');
  });

  it('an item in its undo window is out of the deck and the strip says what runs, with Undo', () => {
    pendingStore.start('o1', 'A-1', 'approve', undefined, () => undefined);
    const h = html([item('A-1'), item('A-2', { since: '2026-11-12' })]);
    expect(h).toContain('aria-label="1 of 1: A-2"');
    expect(h).toContain('Approving A-1…');
    expect(h).toContain('>Undo</button>');
    expect(h).toContain('fv-undo-bar');
    expect(h).not.toContain('to move');
  });

  it('only theme tokens in the stylesheet, no raw colours', async () => {
    const css = (await import('node:fs')).readFileSync('src/renderer/styles/focus.css', 'utf8');
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/rgba?\(/);
  });
});

describe('the Waiting header button', () => {
  const panel = (waiting: WaitingItem[], onOpenFocus?: () => void) =>
    renderToStaticMarkup(
      <SidePanel
        orgId="o1" cosName="Ada" waiting={waiting} initiatives={[]} departments={[]} tabs={[]} busyTabIds={[]} cosBusy={false} cosTurnStartedAt={null} hidden={false}
        onAnswer={noop} onChat={noop} onOpenChart={noop} looks={{}} revealWaiting={0} onOpenFocus={onOpenFocus}
      />,
    );
  it('is a sibling of the collapse toggle, shown only when something waits', () => {
    const h = panel([item('A-1')], noop);
    expect(h).toContain('aria-label="Open focus view"');
    const head = h.slice(h.indexOf('<h4'), h.indexOf('</h4>'));
    expect(head).toContain('aria-expanded');
    expect(head.indexOf('</button>')).toBeLessThan(head.indexOf('aria-label="Open focus view"'));
    expect(panel([], noop)).not.toContain('Open focus view');
  });
});
