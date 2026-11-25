// The model ids seen in Claude Code's init messages of one org, kept in <dataDir>/orgs/<orgId>/models-seen.json (newest first,
// without duplicates). Claude Code has no command that lists models, so these are the only specific ids the picker offers.
import { readJsonObject, writeFileAtomic } from './local-settings';
import { isModel } from '../settings';

const MAX_SEEN = 30;

/** Pure: the ids of a parsed file; anything that is not a list of valid ids is ignored (a corrupt file counts as empty). */
export function cleanSeen(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) if (isModel(x) && !out.includes(x)) out.push(x);
  return out.slice(0, MAX_SEEN);
}

export class SeenModels {
  private ids: string[] | null = null;

  constructor(private readonly file: string) {}

  list(): string[] {
    if (!this.ids) this.ids = cleanSeen(readJsonObject(this.file).models);
    return [...this.ids];
  }

  /** Remembers an id (moved to the front when already there). A failed write keeps the id in memory only. */
  add(id: string): void {
    if (!isModel(id)) return;
    const cur = this.list();
    if (cur[0] === id) return;
    this.ids = [id, ...cur.filter((x) => x !== id)].slice(0, MAX_SEEN);
    try {
      writeFileAtomic(this.file, JSON.stringify({ models: this.ids }, null, 2) + '\n');
    } catch {
      // read-only data folder: the list lives for this run
    }
  }
}
