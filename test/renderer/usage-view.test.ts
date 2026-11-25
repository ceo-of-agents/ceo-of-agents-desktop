import { describe, expect, it } from 'vitest';
import { reducer, initialState } from '../../src/renderer/logic';
import { span, usageView } from '../../src/renderer/usage-view';
import { resetTime, type PlanUsage } from '../../src/shared/usage';

const now = new Date(2026, 10, 18, 10, 0);
const usage: PlanUsage = {
  status: 'allowed_warning',
  limitType: 'seven_day',
  resetsAt: null,
  at: new Date(2026, 10, 18, 9, 58).toISOString(),
  windows: [
    { key: 'five_hour', utilization: 0.13, resetsAt: new Date(2026, 10, 18, 15, 0).toISOString(), status: 'allowed' },
    { key: 'seven_day', utilization: 0.89, resetsAt: new Date(2026, 10, 20, 9, 0).toISOString(), status: 'allowed_warning' },
    { key: 'seven_day_opus', utilization: 1, resetsAt: null, status: 'rejected' },
  ],
};

describe('usageView', () => {
  it('shows "usage unknown" before the first report', () => {
    expect(usageView(null, now)).toMatchObject({ chips: [], aria: 'Plan usage: Usage unknown' });
  });
  it('one chip per window with its level, reset times in the rows', () => {
    const v = usageView(usage, now);
    expect(v.chips).toEqual([
      { key: 'five_hour', text: 'Session 13% · 5 h', level: 'ok' },
      { key: 'seven_day', text: 'Week 89% · 47 h', level: 'warn' },
      // unknown reset time: no countdown
      { key: 'seven_day_opus', text: 'Opus 100%', level: 'full' },
    ]);
    expect(v.rows).toHaveLength(5);
    expect(v.rows[0]).toBe(`5-hour window: 13% used, resets at ${resetTime(usage.windows[0].resetsAt, now)} (in 5 h)`);
    expect(v.rows[1]).toBe(`Weekly limit: 89% used, resets at ${resetTime(usage.windows[1].resetsAt, now)} (in 47 h)`);
    expect(v.rows[2]).toBe('Weekly Opus limit: 100% used, resets at an unknown time');
    expect(v.rows[3]).toBe('As of 2 min ago. Updated after each reply, and every few minutes while every chat is idle.');
    expect(v.rows[4]).toMatch(/^Click to refresh now: .*no model call/);
    expect(v.aria.startsWith('Plan usage: 5-hour window: 13% used')).toBe(true);
  });
  it('the age and the countdown move with the clock; a passed reset waits for a new reading', () => {
    const later = new Date(2026, 10, 18, 15, 30);
    const v = usageView(usage, later);
    expect(v.chips[0]).toEqual({ key: 'five_hour', text: 'Session ?%', level: 'ok' });
    expect(v.chips[1].text).toBe('Week 89% · 41 h 30 min');
    expect(v.rows[0]).toBe(`5-hour window: reset at ${resetTime(usage.windows[0].resetsAt, later)}, waiting for a new reading`);
    expect(v.rows[3]).toMatch(/^As of 5 h 32 min ago\./);
  });
  it('the chip counts down to the reset with the clock, without a new reading', () => {
    const at = (h: number, m: number) => new Date(2026, 10, 18, h, m).toISOString();
    const u: PlanUsage = {
      ...usage,
      windows: [
        { key: 'five_hour', utilization: 0.13, resetsAt: at(12, 5), status: 'allowed' },
        { key: 'seven_day', utilization: 0.41, resetsAt: new Date(2026, 10, 21, 14, 0).toISOString(), status: 'allowed' },
        { key: 'seven_day_sonnet', utilization: 0.2, resetsAt: 'not a date', status: 'allowed' },
      ],
    };
    expect(usageView(u, now).chips.map((c) => c.text)).toEqual(['Session 13% · 2 h 5 min', 'Week 41% · 3 d 4 h', 'Sonnet 20%']);
    expect(usageView(u, new Date(2026, 10, 18, 10, 1)).chips[0].text).toBe('Session 13% · 2 h 4 min');
    expect(usageView(u, new Date(2026, 10, 18, 12, 4, 30)).chips[0].text).toBe('Session 13% · less than a minute');
    // the tooltip and the accessible name keep every window with its reset time
    const v = usageView(u, now);
    expect(v.rows[0]).toBe(`5-hour window: 13% used, resets at ${resetTime(u.windows[0].resetsAt, now)} (in 2 h 5 min)`);
    expect(v.rows[2]).toBe('Weekly Sonnet limit: 20% used, resets at an unknown time');
    expect(v.aria).toBe(`Plan usage: ${v.rows.slice(0, 3).join('; ')}`);
  });
  it('says when a refresh runs', () => {
    expect(usageView(usage, now, true).rows.at(-1)).toBe('Refreshing…');
    expect(usageView(null, now).rows).toHaveLength(2);
  });
  it('span', () => {
    expect(span(20000)).toBe('less than a minute');
    expect(span(12 * 60000)).toBe('12 min');
    expect(span(125 * 60000)).toBe('2 h 5 min');
    expect(span(76 * 3600000)).toBe('3 d 4 h');
  });
  it('the reducer keeps the last usage event', () => {
    expect(reducer(initialState, { type: 'usage', usage }).usage).toBe(usage);
  });
});
