// The first input of a "continued" new session of the chief of staff: the session starts with an empty
// context but the chat goes on, so the first message carries a marker line and the last messages of the chat verbatim.
import type { ThreadEntry } from '../../shared/types';

/**
 * The first line of the first message of a continued session. The ceo-of-agents plugin recognises this exact text
 * (the chief of staff then reads the hq silently and gives no status recap), so it changes only together with the plugin.
 */
export const CONTINUATION_MARKER = '[ceo-of-agents] Continued session: read the hq silently, give no status recap, then answer the new message. The last messages of this chat follow verbatim.';

/** How many of the last user and assistant messages a continued session gets. */
export const CONTINUATION_MESSAGES = 6;

export interface RecentMessage {
  author: string;
  /** ISO time of the entry. */
  time: string;
  text: string;
}

/** `HH:MM` in local time (empty for an invalid time). */
function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The text of the first message of a continued session: the marker, the recent messages (oldest first), then the new message. */
export function continuationText(recent: RecentMessage[], message: string): string {
  const blocks = recent.map((m) => `--- ${m.author}, ${hhmm(m.time)} ---\n${m.text}`);
  return [CONTINUATION_MARKER, ...blocks, `--- New message ---\n${message}`].join('\n\n');
}

/** The last `n` user and assistant entries (verbatim text, no other kinds), oldest first. A user message with only images reads `(image)`. */
export function recentMessages(entries: ThreadEntry[], n = CONTINUATION_MESSAGES): RecentMessage[] {
  const out: RecentMessage[] = [];
  for (let i = entries.length - 1; i >= 0 && out.length < n; i--) {
    const e = entries[i];
    if (e.kind !== 'user' && e.kind !== 'assistant') continue;
    const text = e.kind === 'user' && !e.text && e.images?.length ? '(image)' : e.kind === 'user' && !e.text && e.files?.length ? '(file)' : e.text;
    out.push({ author: e.author, time: e.time, text });
  }
  return out.reverse();
}
