import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore, localDay } from '../../src/main/claude/session-store';
import { ThreadLog, newEntryId } from '../../src/main/claude/thread-log';
import type { ThreadEntry } from '../../src/shared/types';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-store-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('SessionStore', () => {
  it('resumes only the same day', () => {
    const s = new SessionStore(path.join(dir, 'sub', 'sessions.json'));
    expect(s.get('cos')).toBeNull();
    s.set('cos', 'abc', '2026-11-17');
    expect(s.get('cos')).toEqual({ sessionId: 'abc', day: '2026-11-17' });
    expect(s.resumeIdFor('cos', '2026-11-17')).toBe('abc');
    expect(s.resumeIdFor('cos', '2026-11-18')).toBeNull();
    expect(s.resumeIdFor('other', '2026-11-17')).toBeNull();
    s.set('cos', 'def', '2026-11-18');
    expect(new SessionStore(path.join(dir, 'sub', 'sessions.json')).resumeIdFor('cos', '2026-11-18')).toBe('def');
  });

  it('remove forgets one thread only, and a missing key is a no-op', () => {
    const f = path.join(dir, 's.json');
    const s = new SessionStore(f);
    s.remove('nothing');
    s.set('tab:1', 'a', '2026-11-17');
    s.set('cos', 'b', '2026-11-17');
    s.remove('tab:1');
    expect(new SessionStore(f).get('tab:1')).toBeNull();
    expect(new SessionStore(f).get('cos')).toEqual({ sessionId: 'b', day: '2026-11-17' });
  });

  it('survives a corrupt file', () => {
    const f = path.join(dir, 's.json');
    fs.writeFileSync(f, '{nope');
    expect(new SessionStore(f).get('x')).toBeNull();
  });

  it('formats the local day', () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(localDay()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('ThreadLog', () => {
  const entry = (text: string): ThreadEntry => ({ id: newEntryId(), kind: 'user', author: 'You', text, time: new Date().toISOString() });

  it('appends and reads back, skipping corrupt lines', () => {
    const f = path.join(dir, 'a', 'b', 'cos.jsonl');
    const log = new ThreadLog(f);
    expect(log.readAll()).toEqual([]);
    const e1 = entry('one');
    const e2 = entry('two');
    log.append(e1);
    fs.appendFileSync(f, 'garbage line\n{"no":"id"}\n');
    log.append(e2);
    expect(log.readAll()).toEqual([e1, e2]);
  });

  it('makes unique ids', () => {
    expect(newEntryId()).not.toBe(newEntryId());
  });
});
