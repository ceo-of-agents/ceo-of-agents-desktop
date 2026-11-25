import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDecisionOptions } from '../../src/main/hq/decisions';

const md = readFileSync('test/fixtures/hq/decision-queue-sample.md', 'utf8');

describe('parseDecisionOptions', () => {
  const map = parseDecisionOptions(md);
  it('reads the lettered options of a card', () => {
    expect(map.get('ACME-D3')).toEqual([
      { key: 'a', label: 'Usage-based pricing from launch' },
      { key: 'b', label: 'Flat monthly price, revisit after 3 months with a continuation line' },
      { key: 'c', label: 'Do nothing yet' },
    ]);
  });
  it('ignores the skeleton comment, context bullets and cards with fewer than two options', () => {
    expect([...map.keys()]).toEqual(['ACME-D3']);
  });
  it('handles an empty queue', () => {
    expect(parseDecisionOptions('# Decision queue\n\n_No open decisions._\n').size).toBe(0);
  });
});
