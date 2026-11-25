// Elapsed time in plain words: "40 s", "2 min 5 s".
import { t } from './strings';

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return t('activity.seconds', { n: total });
  return t('activity.minutes', { m: Math.floor(total / 60), s: total % 60 });
}
