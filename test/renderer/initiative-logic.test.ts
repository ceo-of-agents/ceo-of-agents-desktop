import { describe, expect, it } from 'vitest';
import { daysSince, isStale, STALE_DAYS } from '../../src/renderer/initiative-logic';

// Local noon and a late evening: the count is by calendar day, not by elapsed hours.
const now = new Date(2026, 10, 19, 12, 0, 0);
const late = new Date(2026, 10, 19, 23, 59, 0);
const early = new Date(2026, 10, 19, 0, 1, 0);

describe('daysSince', () => {
  it('counts local calendar days', () => {
    expect(daysSince('2026-11-19', now)).toBe(0);
    expect(daysSince('2026-11-18', early)).toBe(1);
    expect(daysSince('2026-11-18', late)).toBe(1);
    expect(daysSince('2026-11-12', now)).toBe(7);
    expect(daysSince('2026-10-31', now)).toBe(19);
    expect(daysSince('2025-11-19', now)).toBe(365);
  });
  it('is negative for a future date and survives a daylight-saving change', () => {
    expect(daysSince('2026-11-20', now)).toBe(-1);
    expect(daysSince('2026-03-20', new Date(2026, 2, 30, 12))).toBe(10);
    expect(daysSince('2026-10-20', new Date(2026, 10, 3, 1))).toBe(14);
  });
  it('is null for a missing or invalid date', () => {
    expect(daysSince(null, now)).toBeNull();
    expect(daysSince('', now)).toBeNull();
    expect(daysSince('yesterday', now)).toBeNull();
    expect(daysSince('2026-13-01', now)).toBeNull();
    expect(daysSince('2026-02-30', now)).toBeNull();
  });
  it('reads the date part of a longer string', () => {
    expect(daysSince('2026-11-10T09:00:00Z', now)).toBe(9);
  });
});

describe('isStale', () => {
  const at = (state: 'active' | 'paused' | 'done' | 'dropped' | 'unknown', updated: string | null) => ({ state, updated });
  it('is not stale at exactly 7 days and is at 8', () => {
    expect(STALE_DAYS).toBe(7);
    expect(isStale(at('active', '2026-11-12'), now)).toBe(false);
    expect(isStale(at('active', '2026-11-11'), now)).toBe(true);
    expect(isStale(at('paused', '2026-11-12'), now)).toBe(false);
    expect(isStale(at('paused', '2026-11-11'), now)).toBe(true);
  });
  it('marks an unknown state too', () => {
    expect(isStale(at('unknown', '2026-10-01'), now)).toBe(true);
  });
  it('never marks done, dropped, undated or badly dated ones', () => {
    expect(isStale(at('done', '2026-01-01'), now)).toBe(false);
    expect(isStale(at('dropped', '2026-01-01'), now)).toBe(false);
    expect(isStale(at('active', null), now)).toBe(false);
    expect(isStale(at('active', 'soon'), now)).toBe(false);
  });
  it('does not mark a future date', () => {
    expect(isStale(at('active', '2027-01-01'), now)).toBe(false);
  });
});
