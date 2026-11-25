import { describe, expect, it } from 'vitest';
import { CONTINUATION_MARKER, CONTINUATION_MESSAGES, continuationText, recentMessages } from '../../src/main/org/continuation';
import type { ThreadEntry } from '../../src/shared/types';

const at = (h: number, m: number) => new Date(2026, 10, 18, h, m).toISOString();
const entry = (kind: ThreadEntry['kind'], text: string, over: Partial<ThreadEntry> = {}): ThreadEntry => ({ id: `${kind}-${text}`, kind, author: kind === 'user' ? 'You' : 'Ada', text, time: at(9, 5), ...over });

describe('CONTINUATION_MARKER', () => {
  it('is the exact line the plugin recognises', () => {
    expect(CONTINUATION_MARKER).toBe('[ceo-of-agents] Continued session: read the hq silently, give no status recap, then answer the new message. The last messages of this chat follow verbatim.');
    expect(CONTINUATION_MESSAGES).toBe(6);
  });
});

describe('continuationText', () => {
  it('is the marker, one block per message (oldest first, local HH:MM), then the new message', () => {
    const text = continuationText(
      [
        { author: 'You', time: at(9, 5), text: 'first\nsecond line' },
        { author: 'Ada', time: at(14, 30), text: 'answer' },
      ],
      'next',
    );
    expect(text).toBe(`${CONTINUATION_MARKER}\n\n--- You, 09:05 ---\nfirst\nsecond line\n\n--- Ada, 14:30 ---\nanswer\n\n--- New message ---\nnext`);
  });

  it('with nothing recent, the marker is followed by the new message', () => {
    expect(continuationText([], 'hi')).toBe(`${CONTINUATION_MARKER}\n\n--- New message ---\nhi`);
  });
});

describe('recentMessages', () => {
  it('takes the last 6 user and assistant entries verbatim, oldest first, and no other kinds', () => {
    const entries: ThreadEntry[] = [];
    for (let i = 1; i <= 5; i++) entries.push(entry('user', `u${i}`), entry('activity', `act${i}`), entry('assistant', `a${i}`), entry('system', `sys${i}`));
    entries.push(entry('handoff', 'handed'), entry('session', ''), entry('error', 'boom'), entry('command', 'ls'), entry('permission', 'p'), entry('tool', 't'));
    const r = recentMessages(entries);
    expect(r.map((m) => m.text)).toEqual(['u3', 'a3', 'u4', 'a4', 'u5', 'a5']);
    expect(r[0]).toEqual({ author: 'You', time: at(9, 5), text: 'u3' });
    expect(recentMessages(entries, 2).map((m) => m.text)).toEqual(['u5', 'a5']);
  });

  it('returns fewer when the chat is short, and "(image)" for a user message with only images', () => {
    expect(recentMessages([])).toEqual([]);
    const r = recentMessages([entry('user', '', { images: [{ id: 'abc', mediaType: 'image/png' }] }), entry('assistant', 'nice'), entry('user', '')]);
    expect(r.map((m) => m.text)).toEqual(['(image)', 'nice', '']);
  });
});
