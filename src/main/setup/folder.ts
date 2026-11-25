// The folder a new hq is written into. The setup wizard's Step 0 (skills/init-fleet/SKILL.md) runs `ls -A` (and `ls -A .claude`) and stops
// when it finds anything other than `.git` and `.claude/settings.json`: so `.DS_Store` counts, here and inside `.claude` too.
// The app adds one rule of its own: nothing may be a symbolic link (the wizard would write through it, somewhere else).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface FolderCheck {
  ok: boolean;
  /** What blocks (names relative to the folder); empty when ok, and also when the folder is missing. */
  entries: string[];
  /** The folder does not exist or is not a folder. */
  missing?: boolean;
  /** The folder itself, or `.git`, `.claude` or `.claude/settings.json` in it, is a symbolic link. */
  symlink?: boolean;
}

const isLink = (p: string): boolean => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

export function checkSetupFolder(dir: string): FolderCheck {
  let names: string[];
  try {
    if (isLink(dir)) return { ok: false, entries: [], symlink: true };
    if (!fs.statSync(dir).isDirectory()) return { ok: false, entries: [], missing: true };
    names = fs.readdirSync(dir);
  } catch {
    return { ok: false, entries: [], missing: true };
  }
  const blocking: string[] = [];
  let symlink = false;
  for (const name of names.sort()) {
    if (name === '.git') {
      if (isLink(path.join(dir, name))) {
        symlink = true;
        blocking.push(name);
      }
      continue;
    }
    if (name === '.claude') {
      if (isLink(path.join(dir, name))) {
        symlink = true;
        blocking.push(name);
        continue;
      }
      let inner: string[] = [];
      try {
        inner = fs.readdirSync(path.join(dir, '.claude'));
      } catch {
        blocking.push(name);
        continue;
      }
      for (const n of inner.sort()) {
        if (n !== 'settings.json') blocking.push(`.claude/${n}`);
        else if (isLink(path.join(dir, '.claude', n))) {
          symlink = true;
          blocking.push(`.claude/${n}`);
        }
      }
      continue;
    }
    blocking.push(name);
  }
  return { ok: blocking.length === 0, entries: blocking, ...(symlink ? { symlink: true } : {}) };
}

/** The holding's policies repo folder must be a new place of its own: never the picked folder or inside it, and empty when it exists. */
export type PoliciesPathProblem = 'inside' | 'notEmpty';

/** The real path of the nearest folder that exists, with the missing rest appended (so a not yet created path compares like the real one). */
function resolveLoose(p: string): string {
  const rest: string[] = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.join(cur, ...rest);
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

export function checkPoliciesPath(folder: string, policiesPath: string): PoliciesPathProblem | null {
  const home = os.homedir();
  const expanded = policiesPath === '~' ? home : policiesPath.startsWith('~/') ? path.join(home, policiesPath.slice(2)) : policiesPath;
  const target = resolveLoose(expanded);
  const rel = path.relative(resolveLoose(folder), target);
  if (rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))) return 'inside';
  try {
    const st = fs.statSync(target);
    if (!st.isDirectory() || fs.readdirSync(target).length > 0) return 'notEmpty';
  } catch {
    // does not exist yet: fine
  }
  return null;
}
