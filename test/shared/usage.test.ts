import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { limitReachedText, parseRateLimitInfo, parseResetText, parseUsageText, resetTime, usageLevel, windowLabel, windowShort } from '../../src/shared/usage';

const FIX = path.join(__dirname, '..', 'fixtures', 'claude');
const event = (f: string) =>
  fs
    .readFileSync(path.join(FIX, f), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .find((m) => m.type === 'rate_limit_event');

describe('parseRateLimitInfo', () => {
  it('reads the windows of a recorded rate_limit_event (Claude Code 2.1.327) and nothing else', () => {
    const info = parseRateLimitInfo(event('rate-limit-allowed.jsonl').rate_limit_info);
    expect(info).toEqual({
      status: 'allowed_warning',
      limitType: 'seven_day',
      resetsAt: new Date(1795064400 * 1000).toISOString(),
      windows: [
        { key: 'five_hour', utilization: 0.13, resetsAt: new Date(1795042800 * 1000).toISOString(), status: 'allowed' },
        { key: 'seven_day', utilization: 0.89, resetsAt: new Date(1795064400 * 1000).toISOString(), status: 'allowed_warning' },
      ],
    });
    expect(JSON.stringify(info)).not.toMatch(/overage/i);
  });

  it('orders per-model weekly windows after the weekly limit and drops bad entries', () => {
    const info = parseRateLimitInfo({
      status: 'allowed',
      unifiedWindows: { seven_day_opus: { utilization: 0.5, resetsAt: 1795064400 }, seven_day: { utilization: 0.2 }, five_hour: { utilization: -1 }, 'bad key': {}, x: 3 },
    });
    expect(info?.windows.map((w) => [w.key, w.utilization])).toEqual([
      ['five_hour', null],
      ['seven_day', 0.2],
      ['seven_day_opus', 0.5],
    ]);
  });

  it('falls back to the single top-level window; null for a non-object', () => {
    expect(parseRateLimitInfo({ status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt: 1795042800 })?.windows).toEqual([
      { key: 'five_hour', utilization: 1, resetsAt: new Date(1795042800 * 1000).toISOString(), status: 'rejected' },
    ]);
    expect(parseRateLimitInfo({ status: 'allowed' })?.windows).toEqual([]);
    expect(parseRateLimitInfo(null)).toBeNull();
    expect(parseRateLimitInfo([1])).toBeNull();
  });
});

describe('usage levels and labels', () => {
  const w = (utilization: number | null, status = 'allowed') => ({ key: 'five_hour', utilization, resetsAt: null, status });
  it('warns from 80 % or allowed_warning, full at 100 % or rejected', () => {
    expect(usageLevel(w(0.79))).toBe('ok');
    expect(usageLevel(w(0.8))).toBe('warn');
    expect(usageLevel(w(0.1, 'allowed_warning'))).toBe('warn');
    expect(usageLevel(w(1))).toBe('full');
    expect(usageLevel(w(null, 'rejected'))).toBe('full');
    expect(usageLevel(w(null))).toBe('ok');
  });
  it('names the windows', () => {
    expect(windowLabel('five_hour')).toBe('5-hour window');
    expect(windowLabel('seven_day')).toBe('Weekly limit');
    expect(windowLabel('seven_day_opus')).toBe('Weekly Opus limit');
    expect(windowShort('seven_day_sonnet')).toBe('Sonnet');
    expect(windowShort('five_hour')).toBe('Session');
  });
  it('explains a usage-limit stop with or without a reset time', () => {
    const now = new Date(2026, 10, 18, 10, 0);
    const at = new Date(2026, 10, 18, 15, 0);
    expect(limitReachedText('five_hour', at.toISOString(), now)).toBe(`Usage limit reached (5-hour window): this run stopped. It resets at ${resetTime(at.toISOString(), now)}.`);
    // another day names the weekday
    expect(resetTime(new Date(2026, 10, 20, 9, 0).toISOString(), now)).not.toBe(resetTime(new Date(2026, 10, 18, 9, 0).toISOString(), now));
    expect(limitReachedText('seven_day', null, now)).toBe('Usage limit reached (Weekly limit): this run stopped. The reset time is not known.');
    expect(limitReachedText(null, null, now)).toBe('Usage limit reached: this run stopped. The reset time is not known.');
  });
});

describe('parseUsageText', () => {
  const now = new Date('2026-11-18T19:00:00Z');
  it('maps each line to its window', () => {
    const text = 'Current session: 5% used · resets 9pm (UTC)\nCurrent week (all models): 100% used · resets Nov 20 at 6:30am (UTC)\nCurrent week (Sonnet only): 12% used\nLast 24h · 3 requests';
    const info = parseUsageText(text, now);
    expect(info?.windows).toEqual([
      { key: 'five_hour', utilization: 0.05, resetsAt: '2026-11-18T21:00:00.000Z', status: 'allowed' },
      { key: 'seven_day', utilization: 1, resetsAt: '2026-11-20T06:30:00.000Z', status: 'rejected' },
      { key: 'seven_day_sonnet', utilization: 0.12, resetsAt: null, status: 'allowed' },
    ]);
    expect(info?.status).toBe('rejected');
  });
  it('null without a window line', () => {
    expect(parseUsageText('No usage data', now)).toBeNull();
    expect(parseUsageText(undefined, now)).toBeNull();
  });
});

describe('parseResetText', () => {
  const now = new Date('2026-11-18T19:00:00Z');
  it('reads the time in the named zone', () => {
    expect(parseResetText('Nov 19 at 12am (Europe/Rome)', now)).toBe('2026-11-18T23:00:00.000Z');
    expect(parseResetText('Jul 1 at 12pm (Europe/Rome)', now)).toBe('2027-07-01T10:00:00.000Z');
  });
  it('a time only is the next one', () => {
    expect(parseResetText('8pm (UTC)', now)).toBe('2026-11-18T20:00:00.000Z');
    expect(parseResetText('6pm (UTC)', now)).toBe('2026-11-19T18:00:00.000Z');
  });
  it('a date in early January is next year', () => {
    expect(parseResetText('Jan 2 at 9am (UTC)', new Date('2026-12-30T12:00:00Z'))).toBe('2027-01-02T09:00:00.000Z');
  });
  it('null for what it cannot read', () => {
    expect(parseResetText('soon', now)).toBeNull();
    expect(parseResetText('Nov 19 at 13pm', now)).toBeNull();
  });
});
