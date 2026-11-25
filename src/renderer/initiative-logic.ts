import type { Initiative } from '../shared/types';

/** An open initiative not updated for more than this many local days is marked "not updated". */
export const STALE_DAYS = 7;

/**
 * Whole local calendar days from a `YYYY-MM-DD` date to `now` (negative for a future date). Null when the date is missing or not a real date.
 * Calendar days, not 24 h blocks, so a daylight-saving change never moves the count.
 */
export function daysSince(updated: string | null, now: Date = new Date()): number | null {
  const m = updated ? /^(\d{4})-(\d{2})-(\d{2})/.exec(updated) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  const a = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const b = Date.UTC(y, mo - 1, d);
  return Math.round((a - b) / 86_400_000);
}

/** Active, paused or unknown, with an `updated` date more than `STALE_DAYS` local days old. Done, dropped and undated ones never are. */
export function isStale(i: Pick<Initiative, 'state' | 'updated'>, now: Date = new Date()): boolean {
  if (i.state === 'done' || i.state === 'dropped') return false;
  const days = daysSince(i.updated, now);
  return days !== null && days > STALE_DAYS;
}
