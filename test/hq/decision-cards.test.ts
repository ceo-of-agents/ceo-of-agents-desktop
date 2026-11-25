import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDecisionCards, parseDecisionOptions } from '../../src/main/hq/decisions';
import { loadHq } from '../../src/main/hq/read';
import type { WaitingItem } from '../../src/shared/types';

const md = fs.readFileSync('test/fixtures/hq/decision-queue-sample.md', 'utf8');

describe('parseDecisionCards', () => {
  const cards = parseDecisionCards(md);

  it('reads context, options, recommendation, proposed_by and escalate of a card', () => {
    expect(cards.get('ACME-D3')).toEqual({
      context: 'The beta has 40 testers and no pricing.\n- (x) a bullet in the context, not an option',
      options: [
        { key: 'a', label: 'Usage-based pricing from launch' },
        { key: 'b', label: 'Flat monthly price, revisit after 3 months with a continuation line' },
        { key: 'c', label: 'Do nothing yet' },
      ],
      recommendation: '(b), proposed by business.',
      proposedBy: 'business',
      escalate: true,
    });
  });

  it('lists a card with one option too, without proposed_by or escalate', () => {
    expect(cards.get('ACME-D4')).toEqual({
      context: 'Names are not decided.',
      options: [{ key: 'a', label: 'only one option listed' }],
      recommendation: 'needs analysis by design-brand',
      proposedBy: null,
      escalate: false,
    });
  });

  it('never reads the skeleton comment as a card', () => {
    expect([...cards.keys()]).toEqual(['ACME-D3', 'ACME-D4']);
  });

  it('leaves out a section the card does not have', () => {
    const only = parseDecisionCards('## ACME-D9: Q?\n- status: open\n### Context\nJust context.\n');
    expect(only.get('ACME-D9')).toEqual({ context: 'Just context.', options: [], recommendation: '', proposedBy: null, escalate: false });
  });

  it('keeps Markdown lists and paragraphs of the context as written, and stops a card at the next card', () => {
    const text = '## ACME-D1: A\n### Context\nFirst.\n\n- one\n- two\n### Recommendation\n(a)\n## ACME-D2: B\n### Context\nSecond.\n';
    const map = parseDecisionCards(text);
    expect(map.get('ACME-D1')?.context).toBe('First.\n\n- one\n- two');
    expect(map.get('ACME-D1')?.recommendation).toBe('(a)');
    expect(map.get('ACME-D2')?.context).toBe('Second.');
  });

  it('handles an empty queue and keeps parseDecisionOptions on top of it', () => {
    expect(parseDecisionCards('# Decision queue\n\n_No open decisions._\n').size).toBe(0);
    expect([...parseDecisionOptions(md).keys()]).toEqual(['ACME-D3']);
  });
});

describe('loadHq attaches the card to a decide item', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-cards-'));
    fs.mkdirSync(path.join(dir, 'company'));
    fs.writeFileSync(
      path.join(dir, 'company', 'state.md'),
      '## Waiting on the CEO\n- ACME-D3 [normal] {decide}: pricing for the beta (since 2026-01-10)\n- ACME-D5 [low] {decide}: a card the queue does not have (since 2026-01-10)\n- ACME-D4 [low] {decide}: pick a name (since 2026-01-11)\n\n## Next\n',
    );
    fs.copyFileSync('test/fixtures/hq/decision-queue-sample.md', path.join(dir, 'company', 'decision-queue.md'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('gives the card, and options only when there are two or more; no card when the queue lacks it', () => {
    const items = loadHq(dir).waiting.filter((w): w is WaitingItem => !('unparsed' in w));
    const by = Object.fromEntries(items.map((i) => [i.code, i]));
    expect(by['ACME-D3'].card?.proposedBy).toBe('business');
    expect(by['ACME-D3'].options).toHaveLength(3);
    expect(by['ACME-D4'].card?.options).toHaveLength(1);
    expect(by['ACME-D4'].options).toBeUndefined();
    expect(by['ACME-D5'].card).toBeUndefined();
  });
});
