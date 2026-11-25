import fs from 'node:fs';
import path from 'node:path';

export interface StoredSession {
  sessionId: string;
  day: string;
}

/** Local date as YYYY-MM-DD. */
export function localDay(date: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** Remembers the claude session id per thread key and the day it was last used. */
export class SessionStore {
  constructor(private readonly filePath: string) {}

  private load(): Record<string, StoredSession> {
    try {
      const v = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as unknown;
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, StoredSession>) : {};
    } catch {
      return {};
    }
  }

  get(key: string): StoredSession | null {
    return this.load()[key] ?? null;
  }

  set(key: string, sessionId: string, day: string): void {
    const all = this.load();
    all[key] = { sessionId, day };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n');
    fs.renameSync(tmp, this.filePath);
  }

  /** Forgets a thread's session: it can never be resumed. */
  remove(key: string): void {
    const all = this.load();
    if (!(key in all)) return;
    delete all[key];
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n');
    fs.renameSync(tmp, this.filePath);
  }

  /** The session to resume, only when it was last used today. */
  resumeIdFor(key: string, today: string): string | null {
    const s = this.get(key);
    return s && s.day === today ? s.sessionId : null;
  }
}
