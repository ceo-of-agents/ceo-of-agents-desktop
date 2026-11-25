import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ThreadEntry } from '../../shared/types';

export function newEntryId(): string {
  return randomUUID();
}

/** Append-only JSONL log of one thread. */
export class ThreadLog {
  constructor(private readonly filePath: string) {}

  append(entry: ThreadEntry): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n');
  }

  readAll(): ThreadEntry[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return [];
    }
    const out: ThreadEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const v = JSON.parse(line) as ThreadEntry;
        if (v && typeof v === 'object' && typeof v.id === 'string' && typeof v.kind === 'string') out.push(v);
      } catch {
        // skip corrupt line
      }
    }
    return out;
  }
}
