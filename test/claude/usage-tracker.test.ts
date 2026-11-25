import { describe, expect, it } from 'vitest';
import { UsageTracker } from '../../src/main/claude/usage-tracker';
import type { AppEvent } from '../../src/shared/types';
import type { RateLimitInfo } from '../../src/shared/usage';

const R5 = '2026-11-18T15:00:00.000Z';
const info = (u5: number, s5 = 'allowed', reset = R5): RateLimitInfo => ({
  status: s5,
  limitType: 'five_hour',
  resetsAt: reset,
  windows: [
    { key: 'five_hour', utilization: u5, resetsAt: reset, status: s5 },
    { key: 'seven_day', utilization: 0.4, resetsAt: '2026-11-20T09:00:00.000Z', status: 'allowed' },
  ],
});

function make() {
  const events: AppEvent[] = [];
  const notes: string[] = [];
  const tr = new UsageTracker({ emit: (e) => events.push(e), notify: (_t, b) => notes.push(b), now: () => new Date('2026-11-18T10:00:00.000Z') });
  const notices = () => events.filter((e) => e.type === 'notice').map((e) => (e.type === 'notice' ? e.text : ''));
  return { tr, events, notes, notices };
}

describe('UsageTracker', () => {
  it('keeps and emits the last usage with the time it arrived', () => {
    const { tr, events } = make();
    expect(tr.get()).toBeNull();
    tr.update(info(0.13));
    expect(tr.get()).toMatchObject({ at: '2026-11-18T10:00:00.000Z', windows: [{ key: 'five_hour', utilization: 0.13 }, { key: 'seven_day' }] });
    expect(events).toEqual([{ type: 'usage', usage: tr.get() }]);
  });

  it('tells once when a window gets close, once when it is reached, and again for the next period', () => {
    const { tr, notices, notes } = make();
    tr.update(info(0.5));
    expect(notices()).toEqual([]);
    tr.update(info(0.82));
    tr.update(info(0.9));
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatch(/^Plan usage: 5-hour window at 82%\. It resets at /);
    tr.update(info(1, 'rejected'));
    tr.update(info(1, 'rejected'));
    expect(notices()).toHaveLength(2);
    expect(notices()[1]).toMatch(/^Usage limit reached \(5-hour window\): runs stop until it resets at /);
    // a full window never steps back to "close"
    tr.update(info(0.85));
    expect(notices()).toHaveLength(2);
    // the next 5-hour period
    tr.update(info(0.81, 'allowed', '2026-11-18T20:00:00.000Z'));
    expect(notices()).toHaveLength(3);
    expect(notes).toEqual(notices());
  });

  it('an event with no window keeps the known windows', () => {
    const { tr } = make();
    tr.update(info(0.2));
    tr.update({ status: 'allowed', limitType: null, resetsAt: null, windows: [] });
    expect(tr.get()?.windows).toHaveLength(2);
  });
});
