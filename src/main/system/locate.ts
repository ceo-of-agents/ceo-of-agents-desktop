import fs from 'node:fs';
import path from 'node:path';
import { DEV } from '../config';
import { run, usualBinDirs, type Runner } from './exec';

export interface LocateOptions {
  devBin?: string | null;
  dirs?: string[];
  isExecutable?: (p: string) => boolean;
  runner?: Runner;
}

function defaultIsExecutable(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Finds the claude binary: dev override, usual folders, then the login shell's PATH. */
export async function locateClaude(opts: LocateOptions = {}): Promise<string | null> {
  const isExec = opts.isExecutable ?? defaultIsExecutable;
  const dev = opts.devBin === undefined ? DEV.claudeBin : opts.devBin;
  if (dev) return dev;
  for (const dir of opts.dirs ?? usualBinDirs()) {
    const p = path.join(dir, 'claude');
    if (isExec(p)) return p;
  }
  const r = await (opts.runner ?? run)('/bin/zsh', ['-lc', 'command -v claude'], { timeoutMs: 5000 });
  if (r.code !== 0 || r.error) return null;
  const line = r.stdout.trim().split('\n').pop()?.trim() ?? '';
  return line.startsWith('/') && isExec(line) ? line : null;
}
