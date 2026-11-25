import { describe, expect, it } from 'vitest';
import { parseWaiting } from '../../src/main/hq/parse';
import type { WaitingItem } from '../../src/shared/types';

// Format from the plugin's schemas/state.md (0.14.0): a kind tag after the urgency. Older lines have none.
const state = `## Waiting on the CEO
- ACME-A2 [high] {do}: Approve the store listing in the developer console, Listings > Draft > Approve (since 2026-01-13)
- ACME-A4 [normal] {ok}: approve merging the release pull request https://github.com/acme/app/pull/12 (since 2026-01-14)
- ACME-D3 [normal] {decide}: decide pricing model for the beta, see decision queue (since 2026-01-10)
- ACME-A5 [low]: an older line without a kind (since 2026-01-09)
- ACME-A6 [low] {maybe}: unknown kind stays unparsed (since 2026-01-09)

## Next
`;

describe('parseWaiting kind tag', () => {
  const items = parseWaiting(state);
  it('reads the kind when present and null when absent', () => {
    const parsed = items.filter((i): i is WaitingItem => !('unparsed' in i));
    expect(parsed.map((i) => [i.code, i.action, i.urgency])).toEqual([
      ['ACME-A2', 'do', 'high'],
      ['ACME-A4', 'ok', 'normal'],
      ['ACME-D3', 'decide', 'normal'],
      ['ACME-A5', null, 'low'],
    ]);
    expect(parsed[0].text).toBe('Approve the store listing in the developer console, Listings > Draft > Approve');
    expect(parsed[2].since).toBe('2026-01-10');
  });
  it('keeps an unknown kind as an unparsed line', () => {
    expect(items[4]).toEqual({ unparsed: '- ACME-A6 [low] {maybe}: unknown kind stays unparsed (since 2026-01-09)' });
  });
});
