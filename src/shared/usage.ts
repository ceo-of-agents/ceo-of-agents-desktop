// Plan usage as Claude Code reports it in stream-json: a `rate_limit_event` after each model call, with
// `rate_limit_info.unifiedWindows` (checked with Claude Code 2.1.327). Only the windows' utilization, reset time and
// status are kept; every other field of the event (overage, billing) is dropped unread.
import { t } from './strings';

/** One usage window: `five_hour`, `seven_day`, or a per-model weekly window (`seven_day_<model>`). */
export interface UsageWindow {
  key: string;
  /** 0..1, null when absent. */
  utilization: number | null;
  /** ISO time, null when absent. */
  resetsAt: string | null;
  /** Claude Code's word: `allowed`, `allowed_warning`, `rejected`. */
  status: string;
}

/** What one `rate_limit_event` says. */
export interface RateLimitInfo {
  /** The status of the limit that applies now (`rejected`: the request was refused). */
  status: string;
  /** The window that status is about (`five_hour`, `seven_day`, ...), null when absent. */
  limitType: string | null;
  resetsAt: string | null;
  windows: UsageWindow[];
}

/** The last known plan usage, app-wide (every chat runs on the same Claude Code sign-in). */
export interface PlanUsage extends RateLimitInfo {
  /** When the app received it (ISO). */
  at: string;
}

export type UsageLevel = 'ok' | 'warn' | 'full';

/** At or over this share a window shows as close to its limit. */
export const USAGE_WARN = 0.8;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const KEY = /^[a-z0-9_]{1,40}$/;

function epochIso(v: unknown): string | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  // Seconds (as seen); a value already in milliseconds is taken as it is.
  return new Date(v < 1e12 ? v * 1000 : v).toISOString();
}

const share = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const word = (v: unknown, dflt: string): string => (typeof v === 'string' && KEY.test(v) ? v : dflt);

/** Order: the 5-hour window, the weekly limit, then per-model weekly windows by name. */
function rank(key: string): number {
  return key === 'five_hour' ? 0 : key === 'seven_day' ? 1 : 2;
}

/** Reads `rate_limit_info`; null when it is not an object or has neither a window nor a status. Never throws. */
export function parseRateLimitInfo(v: unknown): RateLimitInfo | null {
  if (!isObj(v)) return null;
  const windows: UsageWindow[] = [];
  if (isObj(v.unifiedWindows)) {
    for (const [key, w] of Object.entries(v.unifiedWindows)) {
      if (!KEY.test(key) || !isObj(w)) continue;
      windows.push({ key, utilization: share(w.utilization), resetsAt: epochIso(w.resetsAt), status: word(w.status, 'allowed') });
    }
  }
  const limitType = typeof v.rateLimitType === 'string' && KEY.test(v.rateLimitType) ? v.rateLimitType : null;
  // An older shape with one window only: that window.
  if (windows.length === 0 && limitType) windows.push({ key: limitType, utilization: share(v.utilization), resetsAt: epochIso(v.resetsAt), status: word(v.status, 'allowed') });
  windows.sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key));
  if (windows.length === 0 && typeof v.status !== 'string') return null; // says nothing
  return { status: word(v.status, 'allowed'), limitType, resetsAt: epochIso(v.resetsAt), windows };
}

export function usageLevel(w: UsageWindow): UsageLevel {
  if (w.status === 'rejected' || (w.utilization !== null && w.utilization >= 1)) return 'full';
  if (w.status === 'allowed_warning' || (w.utilization !== null && w.utilization >= USAGE_WARN)) return 'warn';
  return 'ok';
}

/** "5-hour window", "Weekly limit", "Weekly limit (Opus)". */
export function windowLabel(key: string): string {
  if (key === 'five_hour') return t('usage.window.fiveHour');
  if (key === 'seven_day') return t('usage.window.weekly');
  const m = /^seven_day_([a-z0-9]+)$/.exec(key);
  if (m) return t('usage.window.weeklyModel', { model: m[1].charAt(0).toUpperCase() + m[1].slice(1) });
  return key.replace(/_/g, ' ');
}

/** Short label for the top bar: "5h", "Week", "Opus". */
export function windowShort(key: string): string {
  if (key === 'five_hour') return t('usage.short.fiveHour');
  if (key === 'seven_day') return t('usage.short.weekly');
  const m = /^seven_day_([a-z0-9]+)$/.exec(key);
  return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1) : key.replace(/_/g, ' ');
}

export const percent = (u: number | null): string => (u === null ? '?' : String(Math.round(u * 100)));

/** A reset time in the local zone: "15:00" today, else "Fri 09:00". */
export function resetTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return t('usage.resetUnknown');
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return t('usage.resetUnknown');
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}

/** The thread line for a turn stopped by a usage limit. */
export function limitReachedText(limitType: string | null, resetsAt: string | null, now: Date = new Date()): string {
  const label = limitType ? windowLabel(limitType) : null;
  if (!resetsAt) return label ? t('usage.stopped.noReset', { window: label }) : t('usage.stopped.bare');
  return t('usage.stopped', { window: label ?? t('usage.window.unknown'), time: resetTime(resetsAt, now) });
}

// ---------- `claude -p /usage` (no model call) ----------
// Claude Code 2.1.327 runs `/usage` as a local command in print mode: the result carries `local_command: "usage"`,
// `num_turns: 0` and no model usage. Its text has one line per window:
//   Current session: 27% used · resets Nov 19 at 12am (Europe/Rome)
//   Current week (all models): 90% used · resets Nov 19 at 6am (Europe/Rome)
//   Current week (Sonnet): 23% used · resets Nov 19 at 6am (Europe/Rome)
// Only those lines are read; the rest of the text (what contributes to usage: sessions, agents, servers) is dropped unread.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const LINE = /^\s*Current (session|week \(([^)]{1,40})\)):\s*(\d{1,3}(?:\.\d+)?)\s*% used(?:\s*[·•-]\s*resets\s+(.{1,80}?))?\s*$/i;
const RESET = /^(?:([A-Za-z]{3})[a-z]*\.? (\d{1,2})(?:,? (\d{4}))?(?: at)? )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([A-Za-z0-9_+\-/]{1,40})\))?$/i;

/** Minutes the zone is ahead of UTC at `ms`, null when the zone is not known. */
function zoneOffsetMin(ms: number, zone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(ms));
    const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const wall = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour') % 24, n('minute'));
    return Number.isFinite(wall) ? Math.round((wall - Math.floor(ms / 60000) * 60000) / 60000) : null;
  } catch {
    return null;
  }
}

/** A wall-clock time in `zone` (or the local zone) as epoch ms. */
function wallToMs(y: number, mo: number, d: number, h: number, mi: number, zone: string | null): number {
  if (!zone) return new Date(y, mo, d, h, mi).getTime();
  const guess = Date.UTC(y, mo, d, h, mi);
  const off1 = zoneOffsetMin(guess, zone);
  if (off1 === null) return new Date(y, mo, d, h, mi).getTime();
  const off2 = zoneOffsetMin(guess - off1 * 60000, zone) ?? off1;
  return guess - off2 * 60000;
}

/** "Nov 19 at 12am (Europe/Rome)", "6:30pm", "Dec 2, 2026 at 9am" -> ISO; the next such time after `now` when no year is given. */
export function parseResetText(s: string, now: Date = new Date()): string | null {
  const m = RESET.exec(s.trim());
  if (!m) return null;
  const [, mon, day, year, hh, mm, ampm, zone] = m;
  let h = Number(hh);
  const mi = mm ? Number(mm) : 0;
  if (mi > 59) return null;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ampm.toLowerCase() === 'pm' ? 12 : 0);
  } else if (h > 23) return null;
  const z = zone && zoneOffsetMin(now.getTime(), zone) !== null ? zone : null;
  const nowMs = now.getTime();
  if (mon) {
    const mo = MONTHS.indexOf(mon.toLowerCase());
    const d = Number(day);
    if (mo < 0 || d < 1 || d > 31) return null;
    let y = year ? Number(year) : now.getFullYear();
    let ms = wallToMs(y, mo, d, h, mi, z);
    // No year: a date more than a day in the past is next year's (a reset near New Year).
    if (!year && ms < nowMs - 86400000) ms = wallToMs(++y, mo, d, h, mi, z);
    return new Date(ms).toISOString();
  }
  // A time only: today (in that zone), or tomorrow when it has passed.
  const today = z ? new Date(nowMs + (zoneOffsetMin(nowMs, z) ?? 0) * 60000) : null;
  const [y, mo, d] = today ? [today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()] : [now.getFullYear(), now.getMonth(), now.getDate()];
  let ms = wallToMs(y, mo, d, h, mi, z);
  if (ms <= nowMs) ms += 86400000;
  return new Date(ms).toISOString();
}

/** The window key of a `/usage` line label: "session" -> five_hour, "week (all models)" -> seven_day, "week (Sonnet)" -> seven_day_sonnet. */
function usageLineKey(label: string, model: string | undefined): string | null {
  if (label.toLowerCase() === 'session') return 'five_hour';
  const name = (model ?? '').toLowerCase();
  if (name === '' || name.startsWith('all')) return 'seven_day';
  const word = /[a-z0-9]+/.exec(name)?.[0];
  return word ? `seven_day_${word}` : null;
}

/** Reads the window lines of `/usage`'s text; null when there is none. Never throws. */
export function parseUsageText(text: unknown, now: Date = new Date()): RateLimitInfo | null {
  if (typeof text !== 'string') return null;
  const windows: UsageWindow[] = [];
  for (const line of text.split('\n')) {
    const m = LINE.exec(line);
    if (!m) continue;
    const key = usageLineKey(m[1], m[2]);
    if (!key || !KEY.test(key) || windows.some((w) => w.key === key)) continue;
    const utilization = Number(m[3]) / 100;
    windows.push({ key, utilization, resetsAt: m[4] ? parseResetText(m[4], now) : null, status: utilization >= 1 ? 'rejected' : 'allowed' });
  }
  if (windows.length === 0) return null;
  windows.sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key));
  return { status: windows.some((w) => w.status === 'rejected') ? 'rejected' : 'allowed', limitType: null, resetsAt: null, windows };
}
