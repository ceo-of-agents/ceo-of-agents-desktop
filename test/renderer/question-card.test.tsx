import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A tiny hook runtime so the card can be driven without a DOM: state lives in slots, one pass renders the whole tree.
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
    useMemo: (f: () => unknown) => f(),
    useId: () => 'id',
    useLayoutEffect: () => undefined,
  };
  return { ...mocked, default: mocked };
});

import { QuestionCard } from '../../src/renderer/QuestionCard';
import { Button } from '../../src/renderer/ui/Button';
import { t } from '../../src/shared/strings';
import type { PermissionRequest } from '../../src/shared/types';

const answerQuestion = vi.fn(async (_id: string, _a: Record<string, string>) => true);
const respondPermission = vi.fn(async () => undefined);
vi.stubGlobal('window', { coa: { answerQuestion, respondPermission } });

const input = {
  questions: [
    { question: 'Which database?', header: 'Database', multiSelect: false, options: [{ label: 'SQLite (Recommended)', description: 'Local file' }, { label: 'Postgres', description: 'Server' }] },
    { question: 'Which checks?', header: 'Checks', multiSelect: true, options: [{ label: 'Lint', description: '' }, { label: 'Tests', description: '' }, { label: 'Types', description: '' }] },
  ],
};
const request = { requestId: 'r1', threadKey: 'o|cos', orgId: 'o', threadId: 'cos', toolName: 'AskUserQuestion', input, summary: 'Which database? (+1 more)', rule: '' } as PermissionRequest;

interface El { type: unknown; props: { children?: ReactNode; [k: string]: unknown } }
/** One render pass: expands function components (except Button, kept as a leaf) and returns every element in order. */
function pass(): El[] {
  rt.i = 0;
  const out: El[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object' || !('props' in n)) return;
    const el = n as ReactElement as unknown as El;
    out.push(el);
    if (typeof el.type === 'function' && el.type !== Button) walk((el.type as (p: unknown) => ReactNode)(el.props));
    else walk(el.props.children);
  };
  walk(QuestionCard({ request }));
  return out;
}
const text = (n: ReactNode): string =>
  Array.isArray(n) ? n.map(text).join('') : typeof n === 'string' ? n : n && typeof n === 'object' && 'props' in n ? text((n as unknown as El).props.children) : '';
const option = (label: string) => pass().find((e) => e.type === 'button' && e.props.role && text(e.props.children).includes(label)) as El;
const click = (e: El) => (e.props.onClick as () => void)();
const send = () => pass().find((e) => e.type === Button && e.props.variant === 'you') as El;
const type = (idx: number, value: string) => (pass().filter((e) => e.type === 'input')[idx].props.onChange as (ev: unknown) => void)({ target: { value } });
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  rt.slots = [];
  answerQuestion.mockClear();
  respondPermission.mockClear();
});

describe('QuestionCard', () => {
  it('renders the header chips, the questions, the options and the Recommended marker', () => {
    rt.i = 0;
    const html = renderToStaticMarkup(<QuestionCard request={request} />);
    expect(html).toContain('card question');
    expect(html).toContain('question-chip');
    for (const s of ['Database', 'Which database?', 'Local file', 'Postgres', 'Which checks?', t('question.pickOne'), t('question.pickMany'), t('question.send'), t('question.skip')]) expect(html).toContain(s);
    expect(html).toContain(t('question.recommended'));
    expect(html).not.toContain('(Recommended)');
    expect(html).toContain('role="radio"');
    expect(html).toContain('role="checkbox"');
  });

  it('keeps Send disabled until every question is answered', () => {
    expect(send().props.disabled).toBe(true);
    click(option('Postgres'));
    expect(send().props.disabled).toBe(true);
    click(option('Lint'));
    expect(send().props.disabled).toBe(false);
  });

  it('single choice plus multi-select: Send answers with the labels as sent', async () => {
    click(option('SQLite'));
    click(option('Types'));
    click(option('Lint'));
    click(send());
    await flush();
    expect(answerQuestion).toHaveBeenCalledWith('r1', { 'Which database?': 'SQLite (Recommended)', 'Which checks?': 'Lint, Types' });
  });

  it('picking another single option replaces the first; unticking a multi option removes it', async () => {
    click(option('SQLite'));
    click(option('Postgres'));
    click(option('Lint'));
    click(option('Tests'));
    click(option('Lint'));
    click(send());
    expect(answerQuestion).toHaveBeenCalledWith('r1', { 'Which database?': 'Postgres', 'Which checks?': 'Tests' });
  });

  it('Other text replaces a single choice and is added to a multi-select', () => {
    click(option('Postgres'));
    type(0, 'DuckDB');
    click(option('Tests'));
    type(1, 'e2e');
    click(send());
    expect(answerQuestion).toHaveBeenCalledWith('r1', { 'Which database?': 'DuckDB', 'Which checks?': 'Tests, e2e' });
  });

  it('Skip denies the request and sends no answer', () => {
    const skip = pass().find((e) => e.type === Button && !e.props.variant) as El;
    click(skip);
    expect(respondPermission).toHaveBeenCalledWith('r1', 'deny');
    expect(answerQuestion).not.toHaveBeenCalled();
  });

  it('when the answers are refused (answerQuestion returns false) the card stays and Send can be tried again', async () => {
    answerQuestion.mockResolvedValueOnce(false);
    click(option('SQLite'));
    click(option('Lint'));
    click(send());
    expect(send().props.disabled).toBe(true);
    await flush();
    expect(send().props.disabled).toBe(false);
    click(send());
    await flush();
    expect(answerQuestion).toHaveBeenCalledTimes(2);
  });

  it('when the call fails the card also lets the user try again', async () => {
    answerQuestion.mockRejectedValueOnce(new Error('ipc'));
    click(option('SQLite'));
    click(option('Lint'));
    click(send());
    await flush();
    expect(send().props.disabled).toBe(false);
  });
});
