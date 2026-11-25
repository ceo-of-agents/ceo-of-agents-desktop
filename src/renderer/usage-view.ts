// What the top bar's plan usage shows (pure: tested in node).
import { t } from '../shared/strings';
import { percent, resetTime, usageLevel, windowLabel, windowShort, type PlanUsage, type UsageLevel } from '../shared/usage';

export interface UsageChip {
  key: string;
  /** "Session 13% · 2 h 5 min"; no countdown when the reset time is unknown or has passed ("Session ?%"). */
  text: string;
  level: UsageLevel;
}

export interface UsageView {
  /** Empty when the usage is not known yet. */
  chips: UsageChip[];
  /** Tooltip lines: one per window, then "As of …", then how to refresh. */
  rows: string[];
  /** The accessible name of the whole indicator. */
  aria: string;
}

/** "less than a minute", "12 min", "2 h 5 min", "3 d 4 h". */
export function span(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60000);
  if (min < 1) return t('usage.span.lessThanMinute');
  if (min < 60) return t('usage.span.min', { m: min });
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 === 0 ? t('usage.span.h', { h }) : t('usage.span.hMin', { h, m: min % 60 });
  return h % 24 === 0 ? t('usage.span.d', { d: Math.floor(h / 24) }) : t('usage.span.dH', { d: Math.floor(h / 24), h: h % 24 });
}

const timeOf = (iso: string | null): number | null => {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
};

/** `refreshing`: a refresh the user asked for is running. */
export function usageView(usage: PlanUsage | null, now: Date = new Date(), refreshing = false): UsageView {
  const tail = refreshing ? t('usage.refreshing') : t('usage.refreshHint');
  if (!usage || usage.windows.length === 0) return { chips: [], rows: [t('usage.unknown.tooltip'), tail], aria: t('usage.aria', { summary: t('usage.unknown') }) };
  const nowMs = now.getTime();
  // A window whose reset time has passed no longer has a known value: it waits for the next reading.
  const passed = (iso: string | null) => {
    const ms = timeOf(iso);
    return ms !== null && ms <= nowMs;
  };
  // Each chip shows the time left to its reset, not only the window's name.
  const chips = usage.windows.map((w): UsageChip => {
    const window = windowShort(w.key);
    if (passed(w.resetsAt)) return { key: w.key, text: t('usage.chip', { window, percent: percent(null) }), level: 'ok' };
    const ms = timeOf(w.resetsAt);
    const vars = { window, percent: percent(w.utilization) };
    return { key: w.key, text: ms === null ? t('usage.chip', vars) : t('usage.chip.in', { ...vars, in: span(ms - nowMs) }), level: usageLevel(w) };
  });
  const rows = usage.windows.map((w) => {
    const vars = { window: windowLabel(w.key), percent: percent(w.utilization), time: resetTime(w.resetsAt, now) };
    if (passed(w.resetsAt)) return t('usage.row.reset', vars);
    const ms = timeOf(w.resetsAt);
    return ms === null ? t('usage.row', vars) : t('usage.row.in', { ...vars, in: span(ms - nowMs) });
  });
  const at = timeOf(usage.at);
  if (at !== null) rows.push(nowMs - at < 60000 ? t('usage.asOf.now') : t('usage.asOf', { ago: span(nowMs - at) }));
  rows.push(tail);
  return { chips, rows, aria: t('usage.aria', { summary: rows.slice(0, usage.windows.length).join('; ') }) };
}
