// The handoff notes waiting in the hq's inbox/ (what the chief of staff's chat shows above its composer). Never throws.
import fs from 'node:fs';
import path from 'node:path';
import { noteFrom, noteTitle, noteTo, readHead, toCos } from '../org/handoff';

export interface InboxNote {
  /** `inbox/<name>.md`, relative to the hq. */
  path: string;
  /** The `from` of the note's frontmatter, null when it has none. */
  from: string | null;
  title: string;
}

/**
 * The notes directly in `<hq>/inbox/`, sorted by file name: regular `.md` files only (not README.md in any case, no
 * subfolders, no symlinks) addressed to the CoS (`toCos`: `to` or the file name says `cos` or a name in `cosNames`). Only the first 8 KB of each is read, for its `from` and title. A missing or unreadable
 * folder is an empty list; a file that cannot be read is skipped.
 */
export function readInboxNotes(hqPath: string, cosNames: readonly string[] = ['cos']): InboxNote[] {
  const dir = path.join(hqPath, 'inbox');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: InboxNote[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.md') || name.toLowerCase() === 'readme.md') continue;
    const file = path.join(dir, name);
    try {
      if (!fs.lstatSync(file).isFile()) continue;
    } catch {
      continue;
    }
    const head = readHead(file);
    if (head === null) continue;
    if (!toCos(noteTo(head), name, cosNames)) continue;
    const rel = path.join('inbox', name);
    out.push({ path: rel, from: noteFrom(head), title: noteTitle(head, rel) });
  }
  return out;
}
