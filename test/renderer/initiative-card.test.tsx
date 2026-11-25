import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InitiativeCard } from '../../src/renderer/InitiativeCard';
import type { Initiative } from '../../src/shared/types';

const now = new Date(2026, 10, 19, 12);
const base: Initiative = { slug: 'onboarding', title: 'Onboarding **flow**', state: 'active', updated: '2026-11-01', goal: 'Welcome new orgs', stateText: 'Spike done.', nextStep: 'Build it' };
const render = (patch: Partial<Initiative> = {}) =>
  renderToStaticMarkup(<InitiativeCard i={{ ...base, ...patch }} orgId="o" cosName="Ada" expanded={false} onToggleExpanded={() => undefined} onOpen={() => undefined} now={now} />);

describe('InitiativeCard', () => {
  it('shows the title as a button, the goal, the date, the state and the next step', () => {
    const html = render({ updated: '2026-11-18' });
    expect(html).toMatch(/<button class="i-title">.*<strong>flow<\/strong>.*<\/button>/);
    expect(html).toContain('Welcome new orgs');
    expect(html).toContain('Updated 18 Nov');
    expect(html).toContain('Spike done.');
    expect(html).toContain('Next: Build it');
    expect(html).not.toContain('Not updated');
    expect(html).not.toContain('Ask Ada for an update');
  });

  it('marks an open initiative not updated for more than 7 days, in text, with an always-visible button', () => {
    const html = render();
    expect(html).toContain('Not updated for 18 days');
    expect(html).toMatch(/<button class="btn quiet small">Ask Ada for an update<\/button>/);
  });

  it('is stale from 8 days, not at 7', () => {
    expect(render({ updated: '2026-11-12' })).not.toContain('Not updated');
    expect(render({ updated: '2026-11-11' })).toContain('Not updated for 8 days');
    expect(render({ state: 'paused', updated: '2026-11-11' })).toContain('Not updated for 8 days');
  });

  it('never marks done, dropped or undated ones', () => {
    expect(render({ state: 'done' })).not.toContain('Not updated');
    expect(render({ state: 'dropped' })).not.toContain('Not updated');
    expect(render({ updated: null })).not.toContain('Not updated');
  });

  it('shows the state alone or the next step alone', () => {
    expect(render({ nextStep: '' })).not.toContain('Next:');
    expect(render({ stateText: '' })).toContain('Next: Build it');
    expect(render({ stateText: '', nextStep: '' })).not.toContain('clamp-wrap');
  });
});
