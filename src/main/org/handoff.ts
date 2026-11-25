// Finds the inbox/ note of a department chat and reads its title. Two ways to find one: `ownInboxNote` (a Write, Edit or
// MultiEdit the chat itself made in a turn: certain), and `findInboxNote` (a note in inbox/ whose `from` names the
// department and whose `to` is the chief of staff, however it was written: by a worker, in the background, with Bash,
// or earlier in the chat). `turnWrittenNotes` lists the inbox paths a turn's own tool calls wrote.
import fs from 'node:fs';
import path from 'node:path';
import type { ToolUse } from './thread';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

function inInbox(hqPath: string, file: string): string | null {
  const abs = path.resolve(hqPath, file);
  const rel = path.relative(path.join(hqPath, 'inbox'), abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) return null;
  if (!rel.endsWith('.md') || rel.toLowerCase() === 'readme.md') return null;
  return path.join('inbox', rel);
}

/** Snapshot of inbox/ (file name → mtime), taken before asking for the note. */
export function inboxSnapshot(hqPath: string): Map<string, number> {
  const out = new Map<string, number>();
  try {
    for (const f of fs.readdirSync(path.join(hqPath, 'inbox'))) {
      try {
        out.set(f, fs.statSync(path.join(hqPath, 'inbox', f)).mtimeMs);
      } catch {
        // file vanished
      }
    }
  } catch {
    // no inbox folder
  }
  return out;
}

/**
 * The inbox/ note this chat wrote in a turn, relative to the hq, or null. Only a tool call that succeeded counts
 * (a tool_result arrived and was not an error: a denied or failed call never does), a Write, Edit or MultiEdit of
 * `inbox/<name>.md` that exists after the turn and was created or changed during it (`before` is the inbox snapshot
 * taken when the turn started: an Edit that left an older note as it was does not count). Never the reply text, never
 * files other chats wrote.
 */
export function ownInboxNote(hqPath: string, tools: ToolUse[], before: Map<string, number>, cosNames: readonly string[] = DEFAULT_COS): string | null {
  for (let i = tools.length - 1; i >= 0; i--) {
    const tl = tools[i];
    if (!tl.ok || !WRITE_TOOLS.has(tl.name)) continue;
    const fp = (tl.input as { file_path?: unknown } | null)?.file_path;
    if (typeof fp !== 'string') continue;
    const rel = inInbox(hqPath, fp);
    if (!rel) continue;
    let mtime: number;
    try {
      mtime = fs.statSync(path.join(hqPath, rel)).mtimeMs;
    } catch {
      continue; // does not exist after the turn
    }
    const was = before.get(path.basename(rel));
    if (was !== undefined && mtime <= was) continue;
    const head = readHead(path.join(hqPath, rel));
    if (head !== null && !toCos(noteTo(head), path.basename(rel), cosNames)) continue; // written for another department
    return rel;
  }
  return null;
}

/**
 * The inbox notes (`inbox/<name>.md`) that tool calls of one turn wrote: a Write, Edit or MultiEdit with that file_path,
 * or a Bash command that mentions `inbox/<name>.md`. `tools` are the chat's own calls, `subTools` those of its sub-agents
 * seen in its stream. A note another run wrote in the same minutes is in neither.
 */
export function turnWrittenNotes(hqPath: string, tools: ReadonlyArray<{ name: string; input: unknown }>, subTools: ReadonlyArray<{ name: string; input: unknown }> = []): Set<string> {
  const out = new Set<string>();
  for (const tl of [...tools, ...subTools]) {
    const input = (tl.input ?? {}) as { file_path?: unknown; command?: unknown };
    if (WRITE_TOOLS.has(tl.name) && typeof input.file_path === 'string') {
      const rel = inInbox(hqPath, input.file_path);
      if (rel) out.add(rel);
    } else if (tl.name === 'Bash' && typeof input.command === 'string') {
      for (const m of input.command.matchAll(/inbox\/([^\s'"`;|&<>()\\/]+\.md)/g)) {
        const rel = inInbox(hqPath, path.join('inbox', m[1]));
        if (rel) out.add(rel);
      }
    }
  }
  return out;
}

/** Who a chat's notes are from: the department id (null when the department is not in org.yaml), its agent and its persona. */
export interface NoteOwner {
  id: string | null;
  agent: string;
  persona: string;
}

/** The value of a key in a leading `---` frontmatter block (trimmed, surrounding quotes removed), null when there is none. */
function frontmatterValue(text: string, key: string): string | null {
  const m = text.replace(/^\uFEFF/, '').match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return null;
  const re = new RegExp(`^${key}[ \\t]*:`);
  const line = m[1].split(/\r?\n/).find((l) => re.test(l));
  if (line === undefined) return null;
  const v = line.replace(re, '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();
  return v === '' ? null : v;
}

/** The `from:` value of a leading `---` frontmatter block (trimmed, surrounding quotes removed), null when there is none. */
export function noteFrom(text: string): string | null {
  return frontmatterValue(text, 'from');
}

/** The `to:` value of a leading frontmatter block (same rules as `noteFrom`), null when there is none. */
export function noteTo(text: string): string | null {
  return frontmatterValue(text, 'to');
}

/** The names that mean the chief of staff in a `to:`. The CoS persona and agent are added by the caller when it knows them. */
const DEFAULT_COS: readonly string[] = ['cos'];

/**
 * Whether a note is addressed to the chief of staff. With a `to`: it equals (case-insensitive) one of `cosNames`. Without
 * one: the file name (`YYYY-MM-DD-<from>-to-<to>-<slug>.md`) has no `-to-`, or what follows it starts with `cos`.
 */
export function toCos(to: string | null, fileName: string, cosNames: readonly string[] = DEFAULT_COS): boolean {
  if (to !== null) return cosNames.map((x) => x.trim().toLowerCase()).includes(to.trim().toLowerCase());
  const base = path.basename(fileName, '.md').toLowerCase();
  const i = base.indexOf('-to-');
  if (i < 0) return true;
  const rest = base.slice(i + 4);
  return cosNames.map((x) => x.trim().toLowerCase()).filter(Boolean).some((x) => rest === x || rest.startsWith(`${x}-`));
}

/**
 * Whether a note is from this owner. With a `from`: it equals (case-insensitive) the department id, the agent or the
 * persona. Without one: the sender part of the file name (`YYYY-MM-DD-<from>-to-<to>-<slug>.md`: what comes
 * before the first `-to-`, or the whole name when it has none) holds `-<id>-` or `-<agent>-`.
 */
export function ownsNote(owner: NoteOwner, from: string | null, fileName: string): boolean {
  const names = [owner.id, owner.agent, owner.persona].map((x) => (x ?? '').trim().toLowerCase()).filter(Boolean);
  if (from !== null) return names.includes(from.trim().toLowerCase());
  const base = path.basename(fileName, '.md').toLowerCase();
  const i = base.indexOf('-to-');
  const hay = `-${i < 0 ? base : base.slice(0, i)}-`;
  return [owner.id, owner.agent].some((x) => !!x && x.trim() !== '' && hay.includes(`-${x.trim().toLowerCase()}-`));
}

/** Candidates that are new or changed since a snapshot (`inboxSnapshot`). */
export const changedSince = (snap: Map<string, number>) => (name: string, mtimeMs: number): boolean => !snap.has(name) || mtimeMs > snap.get(name)!;

/** Candidates written at or after a moment (epoch ms). */
export const writtenSince = (ms: number) => (_name: string, mtimeMs: number): boolean => mtimeMs >= ms;

const NOTE_HEAD_BYTES = 8192;

/** The first 8 KB of a file as text, null when it cannot be read. */
export function readHead(file: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(NOTE_HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, NOTE_HEAD_BYTES, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

/**
 * The newest note in `<hq>/inbox/` that is from `owner`, is addressed to the chief of staff (`to`, see `toCos`) and that `isCandidate` accepts, as `inbox/<name>`, or null. Only
 * regular `.md` files directly in inbox/ count (not README.md, no subfolders, no symlinks), none in `exclude` (names
 * as `inbox/<name>`: the notes of other chats). Only the first 8 KB of a file is read, for its `from`. Never throws.
 */
export function findInboxNote(hqPath: string, owner: NoteOwner, isCandidate: (name: string, mtimeMs: number) => boolean, exclude: ReadonlySet<string> = new Set(), cosNames: readonly string[] = DEFAULT_COS): string | null {
  const dir = path.join(hqPath, 'inbox');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let best: { name: string; mtime: number } | null = null;
  for (const name of names) {
    if (!name.endsWith('.md') || name.toLowerCase() === 'readme.md') continue;
    if (exclude.has(path.join('inbox', name))) continue;
    const file = path.join(dir, name);
    let mtime: number;
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile()) continue;
      mtime = st.mtimeMs;
    } catch {
      continue;
    }
    if (!isCandidate(name, mtime)) continue;
    if (best && mtime <= best.mtime) continue;
    const head = readHead(file);
    if (head === null || !ownsNote(owner, noteFrom(head), name) || !toCos(noteTo(head), name, cosNames)) continue;
    best = { name, mtime };
  }
  return best ? path.join('inbox', best.name) : null;
}

/** A short title: the first line of "## Ask or finding", else the first heading, else the file name. */
export function noteTitle(note: string, notePath: string): string {
  const body = note.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const ask = body.match(/^## Ask or finding\s*\n+([^\n]+)/m);
  const heading = body.match(/^#{1,3} (.+)$/m);
  const raw = (ask?.[1] ?? heading?.[1] ?? path.basename(notePath, '.md')).trim();
  return raw.length > 100 ? raw.slice(0, 97) + '...' : raw;
}
