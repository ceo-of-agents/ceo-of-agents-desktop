import { describe, expect, it } from 'vitest';
import type { ThreadEntry } from '../../src/shared/types';
import { withDaySeparators } from '../../src/renderer/logic';
import {
  HINT_AFTER, HINT_KEY, activitySummary, bumpSentCount, clock, commandOf, errorAction, groupRows, isProcessExited, lastUserText, mergeLeaving, normalizeSteps,
  errorReason, readSentCount, replyMessage, sessionDividerLabel, showHint, stepDuration,
} from '../../src/renderer/thread-logic';

const e = (id: string, kind: ThreadEntry['kind'], patch: Partial<ThreadEntry> = {}): ThreadEntry => ({
  id, kind, author: kind === 'user' ? 'You' : kind === 'assistant' ? 'Ada' : '', text: id, time: '2026-11-18T10:00:00.000Z', ...patch,
});

describe('clock', () => {
  it('is m:ss', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(42_900)).toBe('0:42');
    expect(clock(605_000)).toBe('10:05');
    expect(clock(-5)).toBe('0:00');
  });
  it('hides step durations under a second', () => {
    expect(stepDuration(undefined)).toBe('');
    expect(stepDuration(400)).toBe('');
    expect(stepDuration(65_000)).toBe('1:05');
  });
});

describe('steps of an activity entry', () => {
  it('older logs hold plain strings', () => {
    expect(normalizeSteps(['Reading a.md', { text: 'Saving changes', detail: 'Bash · git commit', durationMs: 2000 }])).toEqual([
      { text: 'Reading a.md' },
      { text: 'Saving changes', detail: 'Bash · git commit', durationMs: 2000 },
    ]);
    expect(normalizeSteps(undefined)).toEqual([]);
  });
  it('the summary is "N steps · m:ss", or the stored text when there is no duration', () => {
    expect(activitySummary(e('a', 'activity', { steps: ['x', 'y'], durationMs: 42_000 }))).toBe('2 steps · 0:42');
    expect(activitySummary(e('a', 'activity', { steps: ['x'], durationMs: 5000 }))).toBe('1 step · 0:05');
    expect(activitySummary(e('a', 'activity', { steps: ['x', 'y'], text: '2 steps · 40 s' }))).toBe('2 steps · 40 s');
  });
});

describe('groupRows', () => {
  const group = (entries: ThreadEntry[]) => groupRows(withDaySeparators(entries)).flatMap((r) => (r.type === 'entry' ? [[r.entry.id, r.first, r.gap] as const] : []));
  it('only the first message of an author shows the name and the others sit closer', () => {
    expect(group([e('u1', 'user'), e('u2', 'user'), e('a1', 'assistant'), e('a2', 'assistant'), e('u3', 'user')])).toEqual([
      ['u1', true, 'new'], ['u2', false, 'same'], ['a1', true, 'new'], ['a2', false, 'same'], ['u3', true, 'new'],
    ]);
  });
  it('an activity row, a system line or another author ends a group', () => {
    expect(group([e('a1', 'assistant'), e('act', 'activity'), e('s', 'system'), e('a3', 'assistant'), e('a4', 'assistant', { author: 'Max' })]).map((r) => r[1])).toEqual([
      true, true, true, true, true,
    ]);
  });
  it('an activity summary joins the message after it and opens a group', () => {
    const rows = groupRows(withDaySeparators([e('u', 'user'), e('a0', 'assistant'), e('act', 'activity'), e('a1', 'assistant'), e('a2', 'assistant')]));
    const entries = rows.flatMap((r) => (r.type === 'entry' ? [r] : []));
    expect(entries.map((r) => [r.entry.id, r.first, r.activity?.id ?? null])).toEqual([['u', true, null], ['a0', true, null], ['a1', true, 'act'], ['a2', false, null]]);
  });
  it('an activity summary with no message after it stands alone, with its name line', () => {
    const entries = groupRows(withDaySeparators([e('u', 'user'), e('act', 'activity'), e('err', 'error')])).flatMap((r) => (r.type === 'entry' ? [r] : []));
    expect(entries.map((r) => [r.entry.id, r.first, r.activity ?? null])).toEqual([['u', true, null], ['act', true, null], ['err', true, null]]);
  });
  it('a session divider ends a group, like a system line, and is never the text of "Try again"', () => {
    const entries = [e('u1', 'user'), e('a1', 'assistant'), e('d', 'session', { author: '', text: '' }), e('a2', 'assistant'), e('u2', 'user')];
    expect(group(entries).map((r) => r[1])).toEqual([true, true, true, true, true]);
    expect(lastUserText([e('u1', 'user'), e('d', 'session', { text: '' })])).toBe('u1');
    expect(isProcessExited(e('d', 'session', { text: '' }))).toBe(false);
  });
  it('a day separator ends a group', () => {
    const rows = group([e('a1', 'assistant'), e('a2', 'assistant', { time: '2026-11-20T10:00:00.000Z' })]);
    expect(rows.map((r) => r[1])).toEqual([true, true]);
  });
});

describe('errorReason', () => {
  it('is one full sentence: trimmed, capitalised, with a full stop', () => {
    expect(errorReason('  rate limit reached  ')).toBe('Rate limit reached.');
    expect(errorReason('Could not reach the server.')).toBe('Could not reach the server.');
    expect(errorReason('why not?')).toBe('Why not?');
    expect(errorReason('')).toBe('');
    expect(errorReason('Claude Code stopped unexpectedly. Your next message starts it again.')).toBe('Claude Code stopped unexpectedly. Your next message starts it again.');
  });
});

describe('errors', () => {
  it('"Start again" for a stopped process, "Try again" otherwise when a retry is possible', () => {
    expect(errorAction(e('x', 'error', { text: 'Claude Code stopped unexpectedly. Your next message starts it again.' }), false)).toBe('start');
    expect(errorAction(e('x', 'error', { text: 'boom' }), true)).toBe('retry');
    expect(errorAction(e('x', 'error', { text: 'boom' }), false)).toBeNull();
  });
  it('"Ask to write it" for an error entry that carries the askNote action, whatever the retry state', () => {
    expect(errorAction(e('x', 'error', { text: 'No handoff note', action: 'askNote' }), false)).toBe('askNote');
    expect(errorAction(e('x', 'error', { text: 'No handoff note', action: 'askNote' }), true)).toBe('askNote');
  });
  it('process exited comes as a system line in old logs', () => {
    const text = 'Claude Code stopped unexpectedly. Your next message starts it again.';
    expect(isProcessExited(e('x', 'system', { text }))).toBe(true);
    expect(isProcessExited(e('x', 'error', { text }))).toBe(true);
    expect(isProcessExited(e('x', 'system', { text: 'other' }))).toBe(false);
  });
  it('the last message of the user is what Try again sends', () => {
    expect(lastUserText([e('u1', 'user', { text: 'first' }), e('a', 'assistant'), e('u2', 'user', { text: 'second' }), e('err', 'error')])).toBe('second');
    expect(lastUserText([e('a', 'assistant')])).toBeNull();
  });
});

describe('mergeLeaving', () => {
  const key = (x: { id: string }) => x.id;
  it('keeps what left, marked leaving, and appends what is new', () => {
    const a = { id: 'a' };
    const b = { id: 'b' };
    const c = { id: 'c' };
    const first = mergeLeaving([], [a, b], key);
    expect(first).toEqual([{ item: a, leaving: false }, { item: b, leaving: false }]);
    const second = mergeLeaving(first, [b, c], key);
    expect(second).toEqual([{ item: a, leaving: true }, { item: b, leaving: false }, { item: c, leaving: false }]);
  });
  it('an item that comes back stops leaving', () => {
    const a = { id: 'a' };
    const gone = mergeLeaving(mergeLeaving([], [a], key), [], key);
    expect(gone[0].leaving).toBe(true);
    expect(mergeLeaving(gone, [a], key)[0].leaving).toBe(false);
  });
});

describe('replyMessage', () => {
  it('is "<code> (<item text>): <message>"', () => {
    expect(replyMessage({ code: 'ACME-A12', text: 'Merge the PR' }, 'yes, go')).toBe('ACME-A12 (Merge the PR): yes, go');
  });
  it('flattens line breaks and cuts a long item text', () => {
    expect(replyMessage({ code: 'X-1', text: 'one\n two' }, 'm')).toBe('X-1 (one two): m');
    expect(replyMessage({ code: 'X-1', text: 'x'.repeat(500) }, 'm')).toBe(`X-1 (${'x'.repeat(200)}...): m`);
  });
  it('without item text (the Answer button) it is "<code>: <message>"', () => {
    expect(replyMessage({ code: 'X-1', text: '' }, 'option b')).toBe('X-1: option b');
  });
  it('for an unparsed line (no code) it is `About "<line>": <message>`', () => {
    expect(replyMessage({ code: null, text: '- Something the app could not read' }, 'what is this?')).toBe('About "- Something the app could not read": what is this?');
    expect(replyMessage({ code: null, text: 'a\n b' }, 'm')).toBe('About "a b": m');
    expect(replyMessage({ code: null, text: 'x'.repeat(300) }, 'm')).toBe(`About "${'x'.repeat(200)}...": m`);
  });
});

describe('composer hint counter', () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  };
  it('counts sent messages in storage and hides the hint after three', () => {
    const store = memory();
    expect(readSentCount(store)).toBe(0);
    expect(showHint(readSentCount(store))).toBe(true);
    expect(bumpSentCount(store)).toBe(1);
    expect(bumpSentCount(store)).toBe(2);
    expect(showHint(2)).toBe(true);
    expect(bumpSentCount(store)).toBe(HINT_AFTER);
    expect(showHint(HINT_AFTER)).toBe(false);
    expect(store.getItem(HINT_KEY)).toBe('3');
  });
  it('survives missing or broken storage and junk values', () => {
    expect(readSentCount(null)).toBe(0);
    expect(bumpSentCount(null)).toBe(1);
    expect(readSentCount({ getItem: () => 'abc', setItem: () => undefined })).toBe(0);
    const broken = { getItem: () => { throw new Error('no'); }, setItem: () => { throw new Error('no'); } };
    expect(readSentCount(broken)).toBe(0);
    expect(bumpSentCount(broken)).toBe(1);
  });
});

describe('commandOf', () => {
  it('reads a command after "!" and leaves other drafts alone', () => {
    expect(commandOf('! git status')).toBe('git status');
    expect(commandOf('!ls -la ')).toBe('ls -la');
    expect(commandOf('  !pwd')).toBe('pwd');
    expect(commandOf('!')).toBe('');
    expect(commandOf('hello !world')).toBeNull();
  });
});

describe('sessionDividerLabel', () => {
  it('is "New session, read from hq at <time>" with the time of the entry', () => {
    const time = '2026-11-18T10:05:00.000Z';
    const label = sessionDividerLabel({ time });
    expect(label).toMatch(/^New session, read from hq at \d{1,2}[:.]\d{2}/);
    expect(label.startsWith('New session, read from hq at ')).toBe(true);
    expect(label).toBe(`New session, read from hq at ${new Date(time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`);
  });

  it('is "New session (continued), read from hq at <time>" for a continued session', () => {
    const time = '2026-11-18T10:05:00.000Z';
    expect(sessionDividerLabel({ time, continued: true })).toBe(`New session (continued), read from hq at ${new Date(time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`);
  });
});
