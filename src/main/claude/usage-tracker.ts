// The last plan usage Claude Code reported (any chat of any org: they all run on the same sign-in), kept in memory.
// Sends it to the renderer, and one notice when a window gets close to its limit or reaches it (once per window,
// level and reset time).
import type { AppEvent } from '../../shared/types';
import { t } from '../../shared/strings';
import { percent, resetTime, usageLevel, windowLabel, type PlanUsage, type RateLimitInfo } from '../../shared/usage';

export interface UsageTrackerDeps {
  emit: (e: AppEvent) => void;
  /** A desktop notification (shown only when the window is not focused). */
  notify?: (title: string, body: string) => void;
  now?: () => Date;
}

export class UsageTracker {
  private last: PlanUsage | null = null;
  /** `<window>|<resetsAt>` -> the highest level already announced for that window period. */
  private readonly told = new Map<string, 'warn' | 'full'>();

  constructor(private readonly d: UsageTrackerDeps) {}

  get(): PlanUsage | null {
    return this.last;
  }

  update(info: RateLimitInfo): void {
    const now = this.d.now?.() ?? new Date();
    // An event with no window keeps the windows already known; its status still counts.
    const windows = info.windows.length > 0 ? info.windows : (this.last?.windows ?? []);
    this.last = { ...info, windows, at: now.toISOString() };
    this.d.emit({ type: 'usage', usage: this.last });
    for (const w of info.windows) {
      const level = usageLevel(w);
      if (level === 'ok') continue;
      const key = `${w.key}|${w.resetsAt ?? ''}`;
      const before = this.told.get(key);
      if (before === 'full' || before === level) continue;
      this.told.set(key, level);
      const vars = { window: windowLabel(w.key), percent: percent(w.utilization), time: resetTime(w.resetsAt, now) };
      const text = t(level === 'full' ? 'usage.toast.full' : 'usage.toast.warn', vars);
      this.d.emit({ type: 'notice', orgId: null, text });
      this.d.notify?.(t('app.title'), text);
    }
  }
}
