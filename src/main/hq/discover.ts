import fs from 'node:fs';
import path from 'node:path';
import { isHq } from './read';

const SKIP = new Set(['node_modules', 'Library', '.Trash']);
const MAX_VISITED = 5000;

function real(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

export function findHqs(dir: string, maxDepth = 3): string[] {
  const start = real(dir);
  if (isHq(start)) return [start];
  const found = new Set<string>();
  let level = [start];
  let visited = 0;
  for (let depth = 0; depth < maxDepth && level.length > 0 && visited < MAX_VISITED; depth++) {
    const next: string[] = [];
    for (const parent of level) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(parent, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (visited >= MAX_VISITED) break;
        if (!e.isDirectory() || e.isSymbolicLink()) continue;
        if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
        visited++;
        const child = path.join(parent, e.name);
        if (isHq(child)) found.add(real(child));
        else next.push(child);
      }
    }
    level = next;
  }
  return [...found];
}

const PLACES = ['Desktop', 'Documents', 'Projects', 'projects', 'Developer', 'dev', 'code', 'Code', 'src', 'repos', 'GitHub', 'git'];

export function usualPlaces(home: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of PLACES) {
    const p = path.join(home, name);
    try {
      if (!fs.statSync(p).isDirectory()) continue;
    } catch {
      continue;
    }
    const r = real(p);
    if (!seen.has(r)) {
      seen.add(r);
      out.push(p);
    }
  }
  return out;
}

export function scanUsualPlaces(home: string, maxDepth = 3): string[] {
  const found = new Set<string>();
  for (const place of usualPlaces(home)) for (const h of findHqs(place, maxDepth)) found.add(h);
  for (const h of findHqs(home, 1)) found.add(h);
  return [...found];
}
